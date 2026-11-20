import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../src/channels/Channel.js';
import type { CrmProvider } from '../src/crm/CrmProvider.js';
import type { OutgoingMessage } from '../src/flow/types.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MockPaymentProvider } from '../src/payments/MockPaymentProvider.js';
import { ctx } from './helpers.js';

const prisma = new PrismaClient({ datasources: { db: { url: 'file:./test.db' } } });
const WA = '593999000111';
const silent = { info() {}, warn() {}, error() {} };

class RecordingChannel implements Channel {
  sent: OutgoingMessage[] = [];
  async send(_w: string, m: OutgoingMessage[]) {
    this.sent.push(...m);
  }
  get bodies() {
    return this.sent.map((m) => m.body);
  }
}

class RecordingCrm implements CrmProvider {
  calls: string[] = [];
  fail = false;
  async upsertContact() {
    if (this.fail) throw new Error('crm caído');
    this.calls.push('upsert');
    return { contactId: 'c1' };
  }
  async updateStage(_u: unknown, stage: string, extra?: Record<string, unknown>) {
    if (this.fail) throw new Error('crm caído');
    this.calls.push(`stage:${stage}${extra ? JSON.stringify(extra) : ''}`);
  }
}

let channel: RecordingChannel;
let crm: RecordingCrm;
let bot: Orchestrator;

const say = (value: string) => bot.handleIncoming(WA, { kind: 'text', value });
const tap = (kind: 'button' | 'list', value: string) => bot.handleIncoming(WA, { kind, value });

function makeBot(payments = new MockPaymentProvider('https://bot.example.com')) {
  return new Orchestrator({ prisma, channel, payments, crm, links: ctx.links, log: silent, crmBackoffMs: 1 });
}

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
  await prisma.event.deleteMany();
  await prisma.order.deleteMany();
  await prisma.user.deleteMany();
  channel = new RecordingChannel();
  crm = new RecordingCrm();
  bot = makeBot();
});

afterEach(() => bot.idle());
afterAll(() => prisma.$disconnect());

describe('orquestador', () => {
  it('antes del consentimiento solo guarda waId y conversation_started', async () => {
    await say('hola');
    await tap('button', 'start');
    const user = await prisma.user.findUniqueOrThrow({ where: { waId: WA } });
    expect(user).toMatchObject({ name: null, email: null, consentAt: null });
    expect((await prisma.event.findMany()).map((e) => e.type)).toEqual(['conversation_started']);
  });

  it('flujo completo con pago mock: crea la orden y entrega una sola vez', async () => {
    await toCheckout();
    const order = await prisma.order.findFirstOrThrow();
    expect(order).toMatchObject({ status: 'pending', productId: 'planner-financiero', amountCents: 1200 });
    expect(order.clientTransactionId.length).toBeLessThanOrEqual(15);
    expect(order.paymentUrl).toBe(`https://bot.example.com/mock-pay/${order.id}`);
    expect(channel.bodies.at(-1)).toContain(order.paymentUrl!);

    await tap('button', 'paid'); // antes de pagar
    expect(channel.bodies.at(-1)).toContain('Aún no vemos tu pago');

    // Aprobación repetida por varias vías: una sola entrega
    const results = await Promise.all([
      bot.approveOrder(order.id),
      bot.approveOrder(order.id),
      bot.approveOrder(order.id),
    ]);
    expect(results.filter((r) => r === 'delivered')).toHaveLength(1);
    expect(await bot.approveOrder(order.id)).toBe('already_delivered');

    const deliveries = channel.bodies.filter((b) => b.includes('https://drive.google.com/placeholder-planner'));
    expect(deliveries).toHaveLength(1);
    const done = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(done.status).toBe('approved');
    expect(done.deliveredAt).not.toBeNull();
    const events = (await prisma.event.findMany()).map((e) => e.type);
    expect(events.filter((t) => t === 'product_delivered')).toHaveLength(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { waId: WA } })).step).toBe('DELIVERED');
  });

  it('"Ya pagué" entrega cuando el proveedor ya ve el pago aprobado', async () => {
    await toCheckout();
    const provider = new MockPaymentProvider('https://bot.example.com');
    provider.getStatus = async () => 'approved';
    bot = makeBot(provider);
    await tap('button', 'paid');
    expect(channel.bodies.at(-1)).toContain('Pago confirmado');
    expect((await prisma.order.findFirstOrThrow()).status).toBe('approved');
  });

  it('sincroniza el CRM en segundo plano con wa_total_spent', async () => {
    await toCheckout();
    await bot.approveOrder((await prisma.order.findFirstOrThrow()).id);
    await bot.idle();
    expect(crm.calls).toEqual([
      'upsert',
      'stage:lead',
      'stage:diagnostic_done{"wa_diagnostic_score":3}',
      'stage:checkout_started',
      'stage:customer{"wa_last_product":"Planner financiero","wa_total_spent":12}',
    ]);
    expect((await prisma.user.findUniqueOrThrow({ where: { waId: WA } })).hubspotContactId).toBe('c1');
  });

  it('si el CRM falla el chat sigue funcionando y se registra crm_sync_failed', async () => {
    crm.fail = true;
    await toCheckout();
    await bot.idle();
    expect(channel.bodies.at(-1)).toContain('mock-pay');
    expect(await prisma.event.count({ where: { type: 'crm_sync_failed' } })).toBeGreaterThan(0);
  });

  it('una orden vencida avisa a la usuaria y vuelve al detalle del producto', async () => {
    await toCheckout();
    const order = await prisma.order.findFirstOrThrow();
    await bot.expireOrder(order.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('expired');
    expect(channel.bodies.some((b) => b.includes('venció'))).toBe(true);
    expect((await prisma.event.findMany()).map((e) => e.type)).toContain('payment_expired');
    expect((await prisma.user.findUniqueOrThrow({ where: { waId: WA } })).step).toBe('PRODUCT_DETAIL');
  });

  it('un pago que llega tarde a una orden vencida se entrega igualmente', async () => {
    await toCheckout();
    const order = await prisma.order.findFirstOrThrow();
    await bot.expireOrder(order.id);
    expect(await bot.approveOrder(order.id)).toBe('delivered');
  });
});
