import { FUNNEL_STAGES } from '../flow/types.js';
import { HubspotError, type HubspotApi } from './hubspotApi.js';

export const PROPERTY_GROUP = { name: 'whatsapp_bot', label: 'WhatsApp Bot' } as const;

const STAGE_LABELS: Record<string, string> = {
  lead: 'Lead',
  diagnostic_done: 'Diagnóstico completado',
  resource_viewed: 'Recurso visto',
  checkout_started: 'Checkout iniciado',
  customer: 'Clienta',
  booking_link_sent: 'Enlace de agenda enviado',
};

/** Propiedades personalizadas de contacto que usa el bot. */
export const CUSTOM_PROPERTIES = [
  {
    name: 'wa_funnel_stage',
    label: 'Etapa del embudo (WhatsApp)',
    type: 'enumeration',
    fieldType: 'select',
    options: FUNNEL_STAGES.map((value, i) => ({ label: STAGE_LABELS[value] ?? value, value, displayOrder: i })),
  },
  { name: 'wa_diagnostic_score', label: 'Puntaje del diagnóstico', type: 'number', fieldType: 'number' },
  { name: 'wa_consent_date', label: 'Fecha de consentimiento', type: 'date', fieldType: 'date' },
  { name: 'wa_last_product', label: 'Último producto comprado', type: 'string', fieldType: 'text' },
  { name: 'wa_total_spent', label: 'Total gastado (USD)', type: 'number', fieldType: 'number' },
] as const;

export type SetupOutcome = { name: string; result: 'created' | 'exists' };

/** Crea el grupo y las propiedades que falten. Se puede ejecutar varias veces sin duplicar nada. */
export async function ensureHubspotSchema(api: HubspotApi): Promise<SetupOutcome[]> {
  const outcomes: SetupOutcome[] = [];

  try {
    await api.request('POST', '/crm/v3/properties/contacts/groups', {
      name: PROPERTY_GROUP.name,
      label: PROPERTY_GROUP.label,
      displayOrder: -1,
    });
    outcomes.push({ name: `grupo ${PROPERTY_GROUP.name}`, result: 'created' });
  } catch (err) {
    if (!(err instanceof HubspotError && err.status === 409)) throw err;
    outcomes.push({ name: `grupo ${PROPERTY_GROUP.name}`, result: 'exists' });
  }

  for (const prop of CUSTOM_PROPERTIES) {
    try {
      await api.request('GET', `/crm/v3/properties/contacts/${prop.name}`);
      outcomes.push({ name: prop.name, result: 'exists' });
      continue;
    } catch (err) {
      if (!(err instanceof HubspotError && err.status === 404)) throw err;
    }
    try {
      await api.request('POST', '/crm/v3/properties/contacts', { ...prop, groupName: PROPERTY_GROUP.name });
      outcomes.push({ name: prop.name, result: 'created' });
    } catch (err) {
      if (!(err instanceof HubspotError && err.status === 409)) throw err; // creada entre el GET y el POST
      outcomes.push({ name: prop.name, result: 'exists' });
    }
  }
  return outcomes;
}
