import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../src/channels/Channel.js';
import { parseEnv } from '../src/config/env.js';
import { NoopCrmProvider } from '../src/crm/NoopCrmProvider.js';
import { toCsv } from '../src/lib/csv.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MockPaymentProvider } from '../src/payments/MockPaymentProvider.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import { ctx } from './helpers.js';

process.env.NODE_ENV = 'test';
const prisma = new PrismaClient({ datasources: { db: { url: 'file:./test.db' } } });
const env = parseEnv({
  PUBLIC_BASE_URL: 'https://bot.example.com',
  ADMIN_TOKEN: 'admin-secret',
  PRIVACY_POLICY_URL: 'https://example.com/p',
  INTRO_VIDEO_URL: 'https://example.com/v',
  BOOKING_URL: 'https://cal.com/u/s',
});
const auth = { authorization: 'Bearer admin-secret' };
const channel: Channel = { async send() {} };

let bot: Orchestrator;
let server: BuiltServer;

const say = (waId: string, v: string) => bot.handleIncoming(waId, { kind: 'text', value: v });
const tap = (waId: string, kind: 'button' | 'list', v: string) => bot.handleIncoming(waId, { kind, value: v });

async function toMenu(waId: string, name: string, email: string) {
  await say(waId, 'hola');
  await tap(waId, 'button', 'start');
  await tap(waId, 'button', 'consent_yes');
  await say(waId, name);
  await say(waId, email);
  for (const a of ['yes', 'yes', 'no', 'yes']) await tap(waId, 'button', a);
}

beforeEach(async () => {
  await prisma.event.deleteMany();
  await prisma.order.deleteMany();
  await prisma.user.deleteMany();
  bot = new Orchestrator({
    prisma,
    channel,
    payments: new MockPaymentProvider(env.PUBLIC_BASE_URL),
    crm: new NoopCrmProvider(),
    links: ctx.links,
    log: { info() {}, warn() {}, error() {} },
  });
  server = await buildServer({ env, prisma, orchestrator: bot, payments: new MockPaymentProvider(env.PUBLIC_BASE_URL) });

  // A: compra completa y agenda · B: llega a leads y ve recursos · C: acepta y se detiene · D: solo saluda
  await toMenu('A', 'Ana', 'ana@example.com');
  await tap('A', 'list', 'menu_products');
  await tap('A', 'list', 'prod:planner-financiero');
  await tap('A', 'button', 'buy');
  await bot.approveOrder((await prisma.order.findFirstOrThrow()).id);
  await tap('A', 'button', 'booking');
  await toMenu('B', 'Bea', 'bea@example.com');
  await tap('B', 'list', 'menu_learn');
  await tap('B', 'list', 'res:saving');
  await say('C', 'hola');
  await tap('C', 'button', 'start');
  await tap('C', 'button', 'consent_yes');
  await say('D', 'hola');
  await bot.idle();
});
afterAll(() => prisma.$disconnect());

describe('/admin/stats', () => {
  it('exige el token', async () => {
    expect((await server.app.inject({ url: '/admin/stats' })).statusCode).toBe(401);
    expect((await server.app.inject({ url: '/admin/export/users.csv' })).statusCode).toBe(401);
    expect((await server.app.inject({ url: '/admin/export/events.csv', headers: { authorization: 'Bearer x' } })).statusCode).toBe(401);
  });

  it('cuenta usuarias distintas por paso y calcula la conversión', async () => {
    const stats = (await server.app.inject({ url: '/admin/stats', headers: auth })).json();
    const users = Object.fromEntries(stats.funnel.map((s: { step: string; users: number }) => [s.step, s.users]));
    expect(users).toEqual({
      conversation_started: 4,
      consent_accepted: 3,
      lead_captured: 2,
      diagnostic_completed: 2,
      product_viewed: 1,
      checkout_started: 1,
      payment_approved: 1,
    });
    const step = (k: string) => stats.funnel.find((s: { step: string }) => s.step === k);
    expect(step('conversation_started').conversionFromPrevious).toBeNull();
    expect(step('consent_accepted')).toMatchObject({ conversionFromPrevious: 0.75, conversionFromStart: 0.75 });
    expect(step('lead_captured').conversionFromPrevious).toBe(0.667);
    expect(step('product_viewed')).toMatchObject({ conversionFromPrevious: 0.5, conversionFromStart: 0.25 });
    expect(step('payment_approved').conversionFromPrevious).toBe(1);

    expect(stats.branches).toEqual([
      expect.objectContaining({ step: 'resource_viewed', users: 1, rateOfLeads: 0.5 }),
      expect.objectContaining({ step: 'booking_link_sent', users: 1, rateOfLeads: 0.5 }),
    ]);
    expect(stats.users).toEqual({ total: 4, withConsent: 3 });
    expect(stats.orders).toEqual({ byStatus: { approved: 1 }, revenueCents: 1200 });
  });

  it('una usuaria que repite un paso cuenta una sola vez', async () => {
    await tap('B', 'list', 'menu_learn');
    await tap('B', 'list', 'res:budget');
    const stats = (await server.app.inject({ url: '/admin/stats', headers: auth })).json();
    expect(stats.branches[0].users).toBe(1);
  });

  it('sin datos no divide por cero', async () => {
    await prisma.event.deleteMany();
    await prisma.order.deleteMany();
    await prisma.user.deleteMany();
    const stats = (await server.app.inject({ url: '/admin/stats', headers: auth })).json();
    expect(stats.funnel[1]).toMatchObject({ users: 0, conversionFromPrevious: null, conversionFromStart: null });
    expect(stats.orders.revenueCents).toBe(0);
  });
});

describe('exportaciones CSV', () => {
  it('users.csv: cabecera, una fila por usuaria y tipo de contenido', async () => {
    const res = await server.app.inject({ url: '/admin/export/users.csv', headers: auth });
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('users.csv');
    const lines = res.body.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('id,waId,name,email,consentAt,consentVersion,step,diagnosticScore,diagnosticAnswers,hubspotContactId,createdAt,updatedAt');
    expect(lines).toHaveLength(5);
    expect(res.body).toContain('ana@example.com');
    expect(res.body).toContain('"[true,true,false,true]"'); // JSON con comas: entre comillas
  });

  it('events.csv: incluye los eventos del embudo', async () => {
    const res = await server.app.inject({ url: '/admin/export/events.csv', headers: auth });
    const lines = res.body.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('id,userId,type,payload,createdAt');
    const total = await prisma.event.count();
    expect(lines).toHaveLength(total + 1);
    for (const t of ['conversation_started', 'consent_accepted', 'lead_captured', 'payment_approved', 'product_delivered', 'booking_link_sent']) {
      expect(res.body).toContain(t);
    }
  });

  it('antes del consentimiento no hay datos personales en el export', async () => {
    const res = await server.app.inject({ url: '/admin/export/users.csv', headers: auth });
    const rowD = res.body.split('\r\n').find((l) => l.includes(',D,'))!;
    expect(rowD.split(',').slice(2, 6)).toEqual(['', '', '', '']); // name, email, consentAt, consentVersion
  });
});

describe('toCsv', () => {
  it('escapa comillas, comas y saltos de línea', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'di "hola"\nmundo'], [null, 3]])).toBe('a,b\r\n"x,y","di ""hola""\nmundo"\r\n,3\r\n');
  });

  it('neutraliza la inyección de fórmulas en celdas de texto pero no en números', () => {
    expect(toCsv(['n'], [['=HYPERLINK("http://x")'], ['+1'], ['-5'], ['@cmd'], [-5]])).toBe(
      `n\r\n"'=HYPERLINK(""http://x"")"\r\n'+1\r\n'-5\r\n'@cmd\r\n-5\r\n`,
    );
  });
});
