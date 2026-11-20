import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../src/channels/Channel.js';
import { extractMessages } from '../src/channels/whatsapp/parse.js';
import { signBody, verifySignature } from '../src/channels/whatsapp/signature.js';
import { toApiPayload, WhatsAppChannel } from '../src/channels/whatsapp/WhatsAppChannel.js';
import { parseEnv } from '../src/config/env.js';
import { NoopCrmProvider } from '../src/crm/NoopCrmProvider.js';
import type { OutgoingMessage } from '../src/flow/types.js';
import { RateLimiter } from '../src/lib/rateLimit.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MockPaymentProvider } from '../src/payments/MockPaymentProvider.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import { ctx } from './helpers.js';

process.env.NODE_ENV = 'test';
const prisma = new PrismaClient({ datasources: { db: { url: 'file:./test.db' } } });
const SECRET = 'app-secret';
const env = parseEnv({
  PUBLIC_BASE_URL: 'https://bot.example.com',
  ADMIN_TOKEN: 'admin-secret',
  PRIVACY_POLICY_URL: 'https://example.com/p',
  INTRO_VIDEO_URL: 'https://example.com/v',
  BOOKING_URL: 'https://cal.com/u/s',
  WHATSAPP_VERIFY_TOKEN: 'verify-me',
  WHATSAPP_APP_SECRET: SECRET,
});

const textPayload = (id: string, from: string, body: string) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { messages: [{ id, from, type: 'text', text: { body } }] } }] }],
});

describe('parse', () => {
  it('extrae texto, botones y listas; ignora statuses y reacciones', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: 's', status: 'read' }],
                messages: [
                  { id: '1', from: '593', type: 'text', text: { body: 'hola' } },
                  { id: '2', from: '593', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'start', title: 'Empezar' } } },
                  { id: '3', from: '593', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'menu_learn', title: 'x' } } },
                  { id: '4', from: '593', type: 'audio', audio: { id: 'a' } },
                  { id: '5', from: '593', type: 'reaction', reaction: { emoji: '👍' } },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(extractMessages(payload).map((m) => [m.id, m.input])).toEqual([
      ['1', { kind: 'text', value: 'hola' }],
      ['2', { kind: 'button', value: 'start' }],
      ['3', { kind: 'list', value: 'menu_learn' }],
      ['4', { kind: 'unsupported', value: 'audio' }],
    ]);
    expect(extractMessages({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] })).toEqual([]);
    expect(extractMessages('basura')).toEqual([]);
  });
});

describe('firma', () => {
  it('acepta la firma correcta y rechaza el resto', () => {
    const body = Buffer.from('{"a":1}');
    const sig = signBody(body, SECRET);
    expect(verifySignature(body, sig, SECRET)).toBe(true);
    expect(verifySignature(body, sig, 'otro')).toBe(false);
    expect(verifySignature(Buffer.from('{"a":2}'), sig, SECRET)).toBe(false);
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, 'sha256=zz', SECRET)).toBe(false);
    expect(verifySignature(body, sig, '')).toBe(false);
  });
});

describe('cliente de envío', () => {
  it('arma los payloads de texto, botones y lista', () => {
    expect(toApiPayload('593', { type: 'text', body: 'hi' })).toMatchObject({ type: 'text', to: '593', text: { body: 'hi' } });
    expect(toApiPayload('593', { type: 'buttons', body: 'b', buttons: [{ id: 'a', title: 'A' }] })).toMatchObject({
      type: 'interactive',
      interactive: { type: 'button', body: { text: 'b' }, action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'A' } }] } },
    });
    expect(toApiPayload('593', { type: 'list', body: 'b', buttonLabel: 'Ver', rows: [{ id: 'r', title: 'R', description: 'd' }] })).toMatchObject({
      interactive: { type: 'list', action: { button: 'Ver', sections: [{ rows: [{ id: 'r', title: 'R', description: 'd' }] }] } },
    });
  });

  const config = { token: 'tok', phoneNumberId: '123', graphApiVersion: 'v23.0' };
  const msg: OutgoingMessage = { type: 'text', body: 'hi' };

  it('reintenta 2 veces ante 5xx y luego tiene éxito', async () => {
    const statuses = [500, 503, 200];
    const calls: { url: string; auth: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization! });
      return new Response('{}', { status: statuses.shift()! });
    }) as unknown as typeof fetch;
    await new WhatsAppChannel(config, fetchFn, 1).send('593', [msg]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ url: 'https://graph.facebook.com/v23.0/123/messages', auth: 'Bearer tok' });
  });

  it('falla tras agotar los reintentos y no reintenta 4xx', async () => {
    let n = 0;
    const always500 = (async () => (n++, new Response('x', { status: 500 }))) as unknown as typeof fetch;
    await expect(new WhatsAppChannel(config, always500, 1).send('593', [msg])).rejects.toThrow(/500/);
    expect(n).toBe(3);

    n = 0;
    const bad = (async () => (n++, new Response('bad', { status: 400 }))) as unknown as typeof fetch;
    await expect(new WhatsAppChannel(config, bad, 1).send('593', [msg])).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });
});

describe('rate limiter', () => {
  it('permite 20 por minuto por clave y se recupera', () => {
    let t = 0;
    const rl = new RateLimiter(20, 60_000, () => t);
    for (let i = 0; i < 20; i++) expect(rl.allow('a')).toBe(true);
    expect(rl.allow('a')).toBe(false);
    expect(rl.allow('b')).toBe(true);
    t = 60_001;
    expect(rl.allow('a')).toBe(true);
  });
});

describe('servidor', () => {
  const sent: { waId: string; messages: OutgoingMessage[] }[] = [];
  const channel: Channel = { async send(waId, messages) { sent.push({ waId, messages }); } };
  let server: BuiltServer;

  const post = (payload: unknown, signature?: string) => {
    const raw = JSON.stringify(payload);
    return server.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? signBody(raw, SECRET) },
      payload: raw,
    });
  };

  async function setup(limiter?: RateLimiter) {
    const orchestrator = new Orchestrator({
      prisma,
      channel,
      payments: new MockPaymentProvider(env.PUBLIC_BASE_URL),
      crm: new NoopCrmProvider(),
      links: ctx.links,
      log: { info() {}, warn() {}, error() {} },
    });
    server = await buildServer({ env, prisma, orchestrator, payments: new MockPaymentProvider(env.PUBLIC_BASE_URL), webhook: limiter ? { rateLimiter: limiter } : {} });
    return orchestrator;
  }

  beforeEach(async () => {
    sent.length = 0;
    await prisma.processedMessage.deleteMany();
    await prisma.event.deleteMany();
    await prisma.order.deleteMany();
    await prisma.user.deleteMany();
    await setup();
  });
  afterAll(() => prisma.$disconnect());

  it('GET verifica el webhook con el token correcto', async () => {
    const ok = await server.app.inject({
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    const bad = await server.app.inject({
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345',
    });
    expect(bad.statusCode).toBe(403);
  });

  it('POST con firma inválida responde 401 y no procesa nada', async () => {
    const res = await post(textPayload('m1', '593', 'hola'), 'sha256=' + '0'.repeat(64));
    expect(res.statusCode).toBe(401);
    expect((await post(textPayload('m1', '593', 'hola'), '')).statusCode).toBe(401);
    await server.idle();
    expect(sent).toHaveLength(0);
  });

  it('POST válido responde 200 y el bot contesta por el canal', async () => {
    const res = await post(textPayload('m1', '593', 'hola'));
    expect(res.statusCode).toBe(200);
    await server.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.waId).toBe('593');
    expect(sent[0]!.messages[0]).toMatchObject({ type: 'buttons' });
  });

  it('deduplica reintentos de Meta por message.id', async () => {
    await post(textPayload('dup', '593', 'hola'));
    await post(textPayload('dup', '593', 'hola'));
    await server.idle();
    expect(sent).toHaveLength(1);
    expect(await prisma.processedMessage.count()).toBe(1);
  });

  it('ignora los eventos de statuses', async () => {
    const res = await post({ entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'delivered' }] } }] }] });
    expect(res.statusCode).toBe(200);
    await server.idle();
    expect(sent).toHaveLength(0);
  });

  it('respeta el rate limit por waId (excedente ignorado)', async () => {
    await setup(new RateLimiter(2, 60_000));
    for (const id of ['a', 'b', 'c', 'd']) await post(textPayload(id, '593', 'hola'));
    await server.idle();
    expect(sent).toHaveLength(2);
  });

  it('procesa en orden los mensajes de un mismo payload', async () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: 'o1', from: '593', type: 'text', text: { body: 'hola' } },
                  { id: 'o2', from: '593', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'start' } } },
                  { id: 'o3', from: '593', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'consent_yes' } } },
                ],
              },
            },
          ],
        },
      ],
    };
    await post(payload);
    await server.idle();
    expect((await prisma.user.findUniqueOrThrow({ where: { waId: '593' } })).step).toBe('ASK_NAME');
  });

  it('mock-pay: la página aprueba el pago y entrega el producto', async () => {
    const say = async (id: string, type: string, extra: object) =>
      post({ entry: [{ changes: [{ value: { messages: [{ id, from: '593', type, ...extra }] } }] }] });
    const btn = (id: string) => ({ interactive: { type: 'button_reply', button_reply: { id } } });
    await say('1', 'text', { text: { body: 'hola' } });
    await say('2', 'interactive', btn('start'));
    await say('3', 'interactive', btn('consent_yes'));
    await say('4', 'text', { text: { body: 'Ana' } });
    await say('5', 'text', { text: { body: 'ana@example.com' } });
    for (const [i, a] of ['yes', 'no', 'yes', 'yes'].entries()) await say(`q${i}`, 'interactive', btn(a));
    await say('m1', 'interactive', { interactive: { type: 'list_reply', list_reply: { id: 'menu_products' } } });
    await say('m2', 'interactive', { interactive: { type: 'list_reply', list_reply: { id: 'prod:tablero-de-metas' } } });
    await say('m3', 'interactive', btn('buy'));
    await server.idle();

    const order = await prisma.order.findFirstOrThrow();
    const page = await server.app.inject({ url: `/mock-pay/${order.id}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Aprobar pago');

    const approve = await server.app.inject({ method: 'POST', url: `/mock-pay/${order.id}/approve`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(approve.statusCode).toBe(200);
    const delivered = sent.flatMap((s) => s.messages).filter((m) => m.body.includes('placeholder-tablero-de-metas'));
    expect(delivered).toHaveLength(1);
    expect((await server.app.inject({ url: `/mock-pay/${order.id}` })).body).toContain('approved');
    expect((await server.app.inject({ url: '/mock-pay/nope' })).statusCode).toBe(404);
  });

  it('admin: exige token y aprueba órdenes de forma idempotente', async () => {
    const user = await prisma.user.create({ data: { waId: '777' } });
    const order = await prisma.order.create({
      data: { userId: user.id, productId: 'guia-digital', amountCents: 900, clientTransactionId: 'ABC123' },
    });
    const url = `/admin/orders/${order.id}/approve`;
    expect((await server.app.inject({ method: 'POST', url })).statusCode).toBe(401);
    expect((await server.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer mal' } })).statusCode).toBe(401);
    const headers = { authorization: 'Bearer admin-secret' };
    expect((await server.app.inject({ method: 'POST', url, headers })).json()).toEqual({ result: 'delivered' });
    expect((await server.app.inject({ method: 'POST', url, headers })).json()).toEqual({ result: 'already_delivered' });
    expect((await server.app.inject({ method: 'POST', url: '/admin/orders/xx/approve', headers })).statusCode).toBe(404);
  });

  it('/health responde ok', async () => {
    expect((await server.app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
  });
});
