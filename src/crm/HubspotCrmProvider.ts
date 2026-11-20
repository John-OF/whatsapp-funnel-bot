import type { User } from '@prisma/client';
import type { FunnelStage } from '../flow/types.js';
import type { CrmProvider } from './CrmProvider.js';
import { HubspotApi, HubspotError } from './hubspotApi.js';

/** Solo se admiten estas propiedades en `extra`, para no escribir campos arbitrarios en el CRM. */
const EXTRA_PROPERTIES = new Set(['wa_diagnostic_score', 'wa_last_product', 'wa_total_spent']);

type Properties = Record<string, string | number>;

export class HubspotCrmProvider implements CrmProvider {
  private readonly api: HubspotApi;

  constructor(token: string, fetchFn?: typeof fetch) {
    this.api = new HubspotApi(token, fetchFn);
  }

  /** Busca por email (Search API); si existe actualiza, si no crea. */
  async upsertContact(user: User): Promise<{ contactId: string }> {
    if (!user.email) throw new Error('No se puede crear un contacto sin email');
    const properties = contactProperties(user);

    const found = await this.api.request<{ results: { id: string }[] }>('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: user.email }] }],
      properties: ['email'],
      limit: 1,
    });
    const existing = found.results[0]?.id;
    if (existing) return this.patch(existing, properties);

    try {
      const created = await this.api.request<{ id: string }>('POST', '/crm/v3/objects/contacts', { properties });
      return { contactId: created.id };
    } catch (err) {
      // El índice de búsqueda es eventualmente consistente: un contacto recién creado puede no aparecer aún.
      const id = err instanceof HubspotError && err.status === 409 ? /Existing ID:\s*(\d+)/i.exec(err.detail)?.[1] : undefined;
      if (id) return this.patch(id, properties);
      throw err;
    }
  }

  async updateStage(user: User, stage: FunnelStage, extra?: Record<string, string | number>): Promise<void> {
    if (!user.hubspotContactId) throw new Error('El usuario aún no tiene contacto en HubSpot');
    const properties: Properties = { wa_funnel_stage: stage };
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (EXTRA_PROPERTIES.has(key)) properties[key] = value;
    }
    await this.api.request('PATCH', `/crm/v3/objects/contacts/${user.hubspotContactId}`, { properties });
  }

  private async patch(id: string, properties: Properties): Promise<{ contactId: string }> {
    await this.api.request('PATCH', `/crm/v3/objects/contacts/${id}`, { properties });
    return { contactId: id };
  }
}

function contactProperties(user: User): Properties {
  const props: Properties = { email: user.email! };
  if (user.name) props.firstname = user.name;
  props.phone = `+${user.waId.replace(/^\+/, '')}`;
  if (user.diagnosticScore !== null) props.wa_diagnostic_score = user.diagnosticScore;
  if (user.consentAt) props.wa_consent_date = user.consentAt.toISOString().slice(0, 10);
  return props;
}
