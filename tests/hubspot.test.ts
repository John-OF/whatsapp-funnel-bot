import { PrismaClient, type User } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../src/channels/Channel.js';
import { HubspotApi } from '../src/crm/hubspotApi.js';
import { CUSTOM_PROPERTIES, ensureHubspotSchema } from '../src/crm/hubspotSchema.js';
import { HubspotCrmProvider } from '../src/crm/HubspotCrmProvider.js';
import type { OutgoingMessage } from '../src/flow/types.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MockPaymentProvider } from '../src/payments/MockPaymentProvider.js';
import { ctx } from './helpers.js';

const prisma = new PrismaClient({ datasources: { db: { url: 'file:./test.db' } } });
const silent = { info() {}, warn() {}, error() {} };

/** HubSpot simulado en memoria con el comportamiento documentado (search, 409 por duplicado, propiedades). */
class FakeHubspot {
  contacts = new Map<string, Record<string, string | number>>();
  properties = new Set<string>();
  groups = new Set<string>();
  requests: { method: string; path: string; body?: any }[] = [];
  token = 'good-token';
  /** Simula el retraso del índice de búsqueda: el contacto existe pero la búsqueda no lo ve. */
  searchBlind = false;
  private nextId = 100;

  fetch = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.hubapi.com', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    this.requests.push({ method, path, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });

    if ((init.headers as Record<string, string>).Authorization !== `Bearer ${this.token}`) {
      return json(401, { status: 'error', message: 'Authentication credentials not found.' });
    }
    if (method === 'POST' && path === '/crm/v3/properties/contacts/groups') {
      if (this.groups.has(body.name)) return json(409, { message: 'Group already exists' });
      this.groups.add(body.name);
      return json(201, body);
    }
    if (method === 'GET' && path.startsWith('/crm/v3/properties/contacts/')) {
      return this.properties.has(path.split('/').pop()!) ? json(200, {}) : json(404, { message: 'Property does not exist' });
    }
    if (method === 'POST' && path === '/crm/v3/properties/contacts') {
      if (this.properties.has(body.name)) return json(409, { message: 'Property already exists' });
      this.properties.add(body.name);
      return json(201, body);
    }
    if (method === 'POST' && path === '/crm/v3/objects/contacts/search') {
      const email = body.filterGroups[0].filters[0].value;
      const hit = this.searchBlind ? undefined : [...this.contacts].find(([, p]) => p.email === email);
      return json(200, { total: hit ? 1 : 0, results: hit ? [{ id: hit[0], properties: hit[1] }] : [] });
    }
    if (method === 'POST' && path === '/crm/v3/objects/contacts') {
      const dup = [...this.contacts].find(([, p]) => p.email === body.properties.email);
      if (dup) return json(409, { status: 'error', message: `Contact already exists. Existing ID: ${dup[0]}` });
      const id = String(this.nextId++);
      this.contacts.set(id, { ...body.properties });
      return json(201, { id, properties: body.properties });
    }
    const patch = /^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(path);
    if (method === 'PATCH' && patch) {
      const c = this.contacts.get(patch[1]!);
      if (!c) return json(404, { message: 'not found' });
      Object.assign(c, body.properties);
      return json(200, { id: patch[1], properties: c });
    }
    return json(500, { message: `ruta no simulada ${method} ${path}` });
  }) as unknown as typeof fetch;
}

const user = (over: Partial<User> = {}) =>
  ({
    id: 'u1',
    waId: '593999000111',
    name: 'Ana',
    email: 'ana@example.com',
    consentAt: new Date('2026-01-15T12:00:00Z'),
    diagnosticScore: 3,
    hubspotContactId: null,
    ...over,
  }) as User;

describe('hubspot:setup', () => {
  it('crea el grupo y las 5 propiedades, y se puede ejecutar varias veces sin duplicar', async () => {
    const hs = new FakeHubspot();
    const api = new HubspotApi('good-token', hs.fetch);
    const first = await ensureHubspotSchema(api);
    expect(first.every((o) => o.result === 'created')).toBe(true);
    expect(first).toHaveLength(6);
    expect([...hs.properties].sort()).toEqual(CUSTOM_PROPERTIES.map((p) => p.name).sort());

    const second = await ensureHubspotSchema(api);
    expect(second.map((o) => o.result)).toEqual(['exists', 'exists', 'exists', 'exists', 'exists', 'exists']);
    expect(hs.properties.size).toBe(5);
  });

  it('las propiedades quedan en el grupo whatsapp_bot y wa_funnel_stage tiene las 6 etapas', async () => {
    const hs = new FakeHubspot();
    await ensureHubspotSchema(new HubspotApi('good-token', hs.fetch));
    const creates = hs.requests.filter((r) => r.method === 'POST' && r.path === '/crm/v3/properties/contacts');
    expect(creates.every((r) => r.body.groupName === 'whatsapp_bot')).toBe(true);
    const stage = creates.find((r) => r.body.name === 'wa_funnel_stage')!.body;
    expect(stage).toMatchObject({ type: 'enumeration', fieldType: 'select' });
    expect(stage.options.map((o: { value: string }) => o.value)).toEqual([
      'lead', 'diagnostic_done', 'resource_viewed', 'checkout_started', 'customer', 'booking_link_sent',
    ]);
    const byName = Object.fromEntries(creates.map((r) => [r.body.name, `${r.body.type}/${r.body.fieldType}`]));
    expect(byName).toMatchObject({
      wa_diagnostic_score: 'number/number',
      wa_consent_date: 'date/date',
      wa_last_product: 'string/text',
      wa_total_spent: 'number/number',
    });
  });

  it('un token inválido falla con un error claro sin filtrar el token', async () => {
    const hs = new FakeHubspot();
    const err = await ensureHubspotSchema(new HubspotApi('mal-token', hs.fetch)).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).not.toContain('mal-token');
  });
});

describe('HubspotCrmProvider', () => {
  it('crea el contacto con firstname, email, phone y propiedades personalizadas', async () => {
    const hs = new FakeHubspot();
    const crm = new HubspotCrmProvider('good-token', hs.fetch);
    const { contactId } = await crm.upsertContact(user());
    expect(hs.contacts.get(contactId)).toEqual({
      email: 'ana@example.com',
      firstname: 'Ana',
      phone: '+593999000111',
      wa_diagnostic_score: 3,
      wa_consent_date: '2026-01-15',
    });
  });

  it('si el email ya existe actualiza el mismo contacto en lugar de duplicarlo', async () => {
    const hs = new FakeHubspot();
    const crm = new HubspotCrmProvider('good-token', hs.fetch);
    const a = await crm.upsertContact(user());
    const b = await crm.upsertContact(user({ name: 'Ana María' }));
    expect(b.contactId).toBe(a.contactId);
    expect(hs.contacts.size).toBe(1);
    expect(hs.contacts.get(a.contactId)!.firstname).toBe('Ana María');
  });

  it('tolera el retraso del índice de búsqueda (409 con el id existente)', async () => {
    const hs = new FakeHubspot();
    const crm = new HubspotCrmProvider('good-token', hs.fetch);
    const a = await crm.upsertContact(user());
    hs.searchBlind = true;
    const b = await crm.upsertContact(user());
    expect(b.contactId).toBe(a.contactId);
    expect(hs.contacts.size).toBe(1);
  });

  it('updateStage escribe wa_funnel_stage y solo las propiedades permitidas', async () => {
    const hs = new FakeHubspot();
    const crm = new HubspotCrmProvider('good-token', hs.fetch);
    const { contactId } = await crm.upsertContact(user());
    await crm.updateStage(user({ hubspotContactId: contactId }), 'customer', {
      wa_last_product: 'Planner financiero',
      wa_total_spent: 12,
      lifecyclestage: 'customer', // no permitido
    });
    expect(hs.contacts.get(contactId)).toMatchObject({ wa_funnel_stage: 'customer', wa_last_product: 'Planner financiero', wa_total_spent: 12 });
    expect(hs.contacts.get(contactId)).not.toHaveProperty('lifecyclestage');
    await expect(crm.updateStage(user(), 'lead')).rejects.toThrow(/contacto/);
  });
});

// ---------- integración con el orquestador ----------

const sent: string[] = [];
const channel: Channel = { async send(_w, m: OutgoingMessage[]) { sent.push(...m.map((x) => x.body)); } };
const WA = '593999000222';
let hs: FakeHubspot;
let bot: Orchestrator;

const say = (v: string) => bot.handleIncoming(WA, { kind: 'text', value: v });
const tap = (kind: 'button' | 'list', v: string) => bot.handleIncoming(WA, { kind, value: v });
async function toCheckout() {
  await say('hola');
  await tap('button', 'start');
  await tap('button', 'consent_yes');
  await say('Ana');
  await say('ana@example.com');
  for (const a of ['yes', 'yes', 'no', 'yes']) await tap('button', a);
  await tap('list', 'menu_products');
  await tap('list', 'prod:planner-financiero');
  await tap('button', 'buy');
}

beforeEach(async () => {
  sent.length = 0;
  await prisma.event.deleteMany();
  await prisma.order.deleteMany();
  await prisma.user.deleteMany();
  hs = new FakeHubspot();
  bot = new Orchestrator({
    prisma,
    channel,
    payments: new MockPaymentProvider('https://bot.example.com'),
    crm: new HubspotCrmProvider('good-token', hs.fetch),
    links: ctx.links,
    log: silent,
    crmBackoffMs: 1,
  });
});
afterAll(() => prisma.$disconnect());

describe('HubSpot en el flujo completo', () => {
  it('el contacto aparece al capturar el email y cada etapa actualiza wa_funnel_stage', async () => {
    await say('hola');
    await tap('button', 'start');
    await tap('button', 'consent_yes');
    await say('Ana');
    expect(hs.contacts.size).toBe(0); // antes del email no se crea nada
    await say('ana@example.com');
    await bot.idle();
    expect([...hs.contacts.values()]).toEqual([expect.objectContaining({ email: 'ana@example.com', firstname: 'Ana', wa_funnel_stage: 'lead' })]);

    for (const a of ['yes', 'yes', 'no', 'yes']) await tap('button', a);
    await bot.idle();
    expect([...hs.contacts.values()][0]).toMatchObject({ wa_funnel_stage: 'diagnostic_done', wa_diagnostic_score: 3 });

    await tap('list', 'menu_learn');
    await tap('list', 'res:saving');
    await bot.idle();
    expect([...hs.contacts.values()][0]).toMatchObject({ wa_funnel_stage: 'resource_viewed' });
  });

  it('un pago aprobado marca customer con wa_last_product y wa_total_spent', async () => {
    await toCheckout();
    await bot.idle();
    expect([...hs.contacts.values()][0]).toMatchObject({ wa_funnel_stage: 'checkout_started' });
    await bot.approveOrder((await prisma.order.findFirstOrThrow()).id);
    await bot.idle();
    expect([...hs.contacts.values()][0]).toMatchObject({
      wa_funnel_stage: 'customer',
      wa_last_product: 'Planner financiero',
      wa_total_spent: 12,
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { waId: WA } })).hubspotContactId).toBe([...hs.contacts.keys()][0]);
    expect(hs.contacts.size).toBe(1);
  });

  it('con el token inválido el chat sigue funcionando y se registra crm_sync_failed', async () => {
    hs.token = 'otro-token'; // HubSpot "apagado": todas las llamadas dan 401
    await toCheckout();
    await bot.idle();
    expect(sent.at(-1)).toContain('mock-pay'); // el enlace de pago llegó igualmente
    await bot.approveOrder((await prisma.order.findFirstOrThrow()).id);
    await bot.idle();
    expect(sent.at(-1)).toContain('¡Pago confirmado');
    const failed = await prisma.event.findMany({ where: { type: 'crm_sync_failed' } });
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.payload).toContain('401');
    expect(failed[0]!.payload).not.toContain('good-token');
    expect(hs.contacts.size).toBe(0);
  });

  it('reintenta 3 veces con backoff antes de rendirse y se recupera si HubSpot vuelve', async () => {
    hs.token = 'otro-token';
    await say('hola');
    await tap('button', 'start');
    await tap('button', 'consent_yes');
    await say('Ana');
    await say('ana@example.com');
    await bot.idle();
    expect(hs.requests.filter((r) => r.path.endsWith('/search'))).toHaveLength(3);

    hs.token = 'good-token'; // HubSpot vuelve: el siguiente cambio de etapa crea el contacto
    for (const a of ['yes', 'yes', 'no', 'yes']) await tap('button', a);
    await bot.idle();
    expect([...hs.contacts.values()][0]).toMatchObject({ email: 'ana@example.com', wa_funnel_stage: 'diagnostic_done' });
  });
});
