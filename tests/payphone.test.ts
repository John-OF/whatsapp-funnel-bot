import { PrismaClient, type Order, type User } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../src/channels/Channel.js';
import { parseEnv } from '../src/config/env.js';
import { NoopCrmProvider } from '../src/crm/NoopCrmProvider.js';
import { PaymentPoller } from '../src/jobs/paymentPoller.js';
import type { OutgoingMessage } from '../src/flow/types.js';
import { Orchestrator } from '../src/orchestrator.js';
import { interpretStatus, parseLinkResponse, PayphoneProvider } from '../src/payments/PayphoneProvider.js';
import type { PaymentProvider, PaymentStatus } from '../src/payments/PaymentProvider.js';
import { buildServer } from '../src/server.js';
import { ctx } from './helpers.js';

process.env.NODE_ENV = 'test';
const prisma = new PrismaClient({ datasources: { db: { url: 'file:./test.db' } } });
const silent = { info() {}, warn() {}, error() {} };

const config = { token: 'secret-token', storeId: 'store-1', apiBase: 'https://pay.example.com/', expiresHours: 1 };
const order = { id: 'ord1', productId: 'planner-financiero', amountCents: 1200, clientTransactionId: 'ABCDEFGHJKLM' } as Order;
const user = {} as User;

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses.shift()!();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('PayphoneProvider.createPaymentLink', () => {
  it('envía el cuerpo exigido por la doc, en centavos, con Bearer', async () => {
    const { fn, calls } = fakeFetch([() => new Response('"https://payp.page.link/aYu55"', { status: 200 })]);
    const { url } = await new PayphoneProvider(config, fn).createPaymentLink(order, user);
    expect(url).toBe('https://payp.page.link/aYu55');
    expect(calls[0]!.url).toBe('https://pay.example.com/api/Links');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({
      amount: 1200,
      amountWithoutTax: 1200,
      amountWithTax: 0,
      tax: 0,
      service: 0,
      tip: 0,
      currency: 'USD',
      storeId: 'store-1',
      reference: 'Planner financiero',
      clientTransactionId: 'ABCDEFGHJKLM',
      oneTime: true,
      expireIn: 1,
      isAmountEditable: false,
      additionalData: 'ord1',
    });
    expect(body.clientTransactionId.length).toBeLessThanOrEqual(15);
    expect(Number.isInteger(body.amount)).toBe(true);
  });

  it('un JSON de respuesta es un error de validación', async () => {
    const err = { message: 'Validaciones fallidas', errorCode: 800, errors: [{ message: 'storeId', errorCode: 0, errorDescriptions: ['inválido'] }] };
    const { fn } = fakeFetch([() => new Response(JSON.stringify(err), { status: 400 })]);
    await expect(new PayphoneProvider(config, fn).createPaymentLink(order, user)).rejects.toThrow(/800.*storeId: inválido/);
  });

  it('el mensaje de error nunca contiene el token', async () => {
    const { fn } = fakeFetch([() => new Response('<html>boom</html>', { status: 502 })]);
    const err = await new PayphoneProvider(config, fn).createPaymentLink(order, user).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('secret-token');
  });

  it('respeta el límite de 30 solicitudes por minuto', async () => {
    const { fn } = fakeFetch(Array.from({ length: 31 }, () => () => new Response('"https://payp.page.link/x"')));
    const provider = new PayphoneProvider(config, fn);
    for (let i = 0; i < 30; i++) await provider.createPaymentLink(order, user);
    await expect(provider.createPaymentLink(order, user)).rejects.toThrow(/30 solicitudes/);
  });

  it('parseLinkResponse acepta la URL con o sin comillas', () => {
    expect(parseLinkResponse(200, 'https://payp.page.link/a')).toBe('https://payp.page.link/a');
    expect(parseLinkResponse(200, '"https://payp.page.link/a"')).toBe('https://payp.page.link/a');
    expect(() => parseLinkResponse(200, 'http://inseguro')).toThrow();
  });
});

describe('PayphoneProvider.getStatus', () => {
  it('mapea statusCode 1/2/3 a pending/canceled/approved', () => {
    expect(interpretStatus(200, { statusCode: 3, transactionStatus: 'Approved' })).toBe('approved');
    expect(interpretStatus(200, { statusCode: 2 })).toBe('canceled');
    expect(interpretStatus(200, { statusCode: 1 })).toBe('pending');
  });

  it('una transacción aún no registrada (error 4xx) es pendiente; credenciales o caída se propagan', () => {
    expect(interpretStatus(404, { message: 'No existe', errorCode: 20 })).toBe('pending');
    expect(interpretStatus(400, { message: 'x', errorCode: 1 })).toBe('pending');
    expect(() => interpretStatus(401, {})).toThrow();
    expect(() => interpretStatus(503, {})).toThrow();
  });

  it('consulta GET /api/Sale/client/{clientTransactionId}', async () => {
    const { fn, calls } = fakeFetch([() => new Response(JSON.stringify({ statusCode: 3 }), { status: 200 })]);
    expect(await new PayphoneProvider(config, fn).getStatus(order)).toBe('approved');
    expect(calls[0]!.url).toBe('https://pay.example.com/api/Sale/client/ABCDEFGHJKLM');
    expect(calls[0]!.init.method).toBeUndefined(); // GET
  });
});

// ---------- poller, notificación externa y entrega única ----------

class StubProvider implements PaymentProvider {
  status: PaymentStatus | Error = 'pending';
  calls = 0;
  async createPaymentLink() {
    return { url: 'https://payp.page.link/test' };
  }
  async getStatus(): Promise<PaymentStatus> {
    this.calls++;
    if (this.status instanceof Error) throw this.status;
    return this.status;
  }
}

const sent: string[] = [];
const channel: Channel = {
  async send(_w: string, m: OutgoingMessage[]) {
    sent.push(...m.map((x) => x.body));
  },
};
let provider: StubProvider;
let bot: Orchestrator;

async function seedOrder(createdAt = new Date()) {
  const u = await prisma.user.create({
    data: { waId: `u${Math.random()}`, name: 'Ana', email: 'a@b.co', consentAt: new Date(), step: 'CHECKOUT', stepData: JSON.stringify({ productId: 'guia-digital' }) },
  });
  return prisma.order.create({
    data: { userId: u.id, productId: 'guia-digital', amountCents: 900, clientTransactionId: `T${Math.random().toString(36).slice(2, 10)}`, createdAt },
  });
}

const poller = (now?: () => Date) =>
  new PaymentPoller({ prisma, payments: provider, orchestrator: bot, intervalSeconds: 20, maxMinutes: 30, log: silent, now });

beforeEach(async () => {
  sent.length = 0;
  await prisma.event.deleteMany();
  await prisma.order.deleteMany();
  await prisma.user.deleteMany();
  provider = new StubProvider();
  bot = new Orchestrator({ prisma, channel, payments: provider, crm: new NoopCrmProvider(), links: ctx.links, log: silent });
});
afterAll(() => prisma.$disconnect());

describe('poller', () => {
  it('aprueba las órdenes pagadas y entrega una sola vez aunque haya varias pasadas', async () => {
    const o = await seedOrder();
    provider.status = 'approved';
    const p = poller();
    await Promise.all([p.tick(), p.tick()]);
    await p.tick();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('approved');
    expect(sent.filter((b) => b.includes('placeholder-guia-digital'))).toHaveLength(1);
  });

  it('deja pendientes las que no se han pagado y cancela las rechazadas', async () => {
    const pending = await seedOrder();
    await poller().tick();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('pending');

    provider.status = 'canceled';
    await poller().tick();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('canceled');
  });

  it('marca como vencidas las órdenes de más de PAYMENT_POLL_MAX_MINUTES sin consultar al proveedor', async () => {
    const old = await seedOrder(new Date(Date.now() - 31 * 60_000));
    await poller().tick();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('expired');
    expect(provider.calls).toBe(0);
    expect((await prisma.event.findMany()).map((e) => e.type)).toContain('payment_expired');
  });

  it('un error del proveedor no detiene el poller ni cambia la orden', async () => {
    const o = await seedOrder();
    provider.status = new Error('Payphone caído');
    await poller().tick();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('pending');
  });
});

describe('"Ya pagué" con el proveedor caído', () => {
  it('responde "aún no vemos tu pago" en lugar de fallar', async () => {
    const o = await seedOrder();
    provider.status = new Error('Payphone caído');
    const waId = (await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).waId;
    await bot.handleIncoming(waId, { kind: 'button', value: 'paid' });
    expect(sent.at(-1)).toContain('Aún no vemos tu pago');
  });
});

describe('POST /webhooks/payphone', () => {
  const baseEnv = {
    PUBLIC_BASE_URL: 'https://bot.example.com',
    ADMIN_TOKEN: 'a',
    PRIVACY_POLICY_URL: 'https://example.com/p',
    INTRO_VIDEO_URL: 'https://example.com/v',
    BOOKING_URL: 'https://cal.com/u/s',
    WHATSAPP_VERIFY_TOKEN: 'v',
    WHATSAPP_APP_SECRET: 's',
  };

  it('está desactivada por defecto (404)', async () => {
    const { app } = await buildServer({ env: parseEnv(baseEnv), prisma, orchestrator: bot, payments: provider });
    expect((await app.inject({ method: 'POST', url: '/webhooks/payphone', payload: {} })).statusCode).toBe(404);
  });

  it('activada: aprueba con StatusCode 3 confirmado, es idempotente y responde el formato de Payphone', async () => {
    const { app } = await buildServer({
      env: parseEnv({ ...baseEnv, PAYPHONE_NOTIFICATIONS_ENABLED: 'true' }),
      prisma,
      orchestrator: bot,
      payments: provider,
    });
    const o = await seedOrder();
    const notify = (body: object) => app.inject({ method: 'POST', url: '/webhooks/payphone', payload: body });
    const payload = { ClientTransactionId: o.clientTransactionId, StatusCode: 3, TransactionId: 987, Amount: 900 };

    provider.status = 'pending'; // la consulta no confirma: se rechaza
    expect((await notify(payload)).json()).toEqual({ Response: false, ErrorCode: '111' });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('pending');

    provider.status = 'approved';
    expect((await notify(payload)).json()).toEqual({ Response: true, ErrorCode: '000' });
    expect((await notify(payload)).json()).toEqual({ Response: true, ErrorCode: '000' });
    const done = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(done).toMatchObject({ status: 'approved', providerTransactionId: '987' });
    expect(sent.filter((b) => b.includes('placeholder-guia-digital'))).toHaveLength(1);

    expect((await notify({ ClientTransactionId: 'NOEXISTE', StatusCode: 3 })).json()).toEqual({ Response: false, ErrorCode: '111' });
    expect((await notify({ basura: true })).statusCode).toBe(400);
  });
});
