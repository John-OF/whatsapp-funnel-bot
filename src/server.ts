import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { WhatsAppChannel } from './channels/whatsapp/WhatsAppChannel.js';
import { getEnv, type Env } from './config/env.js';
import { Orchestrator } from './orchestrator.js';
import { createCrmProvider, createPaymentProvider } from './providers.js';
import { adminRoutes } from './routes/admin.js';
import { PaymentPoller } from './jobs/paymentPoller.js';
import type { PaymentProvider } from './payments/PaymentProvider.js';
import { mockPayRoutes } from './routes/mockPay.js';
import { payphoneWebhookRoutes } from './routes/payphoneWebhook.js';
import { webhookRoutes, type WebhookOptions } from './routes/webhook.js';

export interface ServerDeps {
  env: Env;
  prisma: PrismaClient;
  orchestrator: Orchestrator;
  payments: PaymentProvider;
  webhook?: Partial<Pick<WebhookOptions, 'rateLimiter'>>;
}

export interface BuiltServer {
  app: FastifyInstance;
  /** Espera a que termine el procesamiento asíncrono de webhooks (tests). */
  idle: () => Promise<void>;
}

export async function buildServer(deps: ServerDeps): Promise<BuiltServer> {
  const { env, prisma, orchestrator, payments } = deps;
  const app = Fastify({ logger: process.env.NODE_ENV === 'test' ? false : { level: 'info' } });

  app.get('/health', async () => ({ status: 'ok' }));

  let idle = async () => {};
  await app.register(async (scope) => {
    idle = await webhookRoutes(scope, {
      orchestrator,
      prisma,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
      appSecret: env.WHATSAPP_APP_SECRET,
      ...deps.webhook,
    });
  });
  if (env.PAYMENT_PROVIDER === 'mock') {
    await app.register(async (scope) => mockPayRoutes(scope, { orchestrator, prisma }));
  }
  if (env.PAYPHONE_NOTIFICATIONS_ENABLED) {
    await app.register(async (scope) => payphoneWebhookRoutes(scope, { orchestrator, prisma, payments }));
  }
  await app.register(async (scope) => adminRoutes(scope, { orchestrator, prisma, adminToken: env.ADMIN_TOKEN }));

  return { app, idle };
}

function requireWhatsAppEnv(env: Env): void {
  const missing = (['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET'] as const).filter(
    (k) => !env[k],
  );
  if (missing.length > 0) {
    throw new Error(`Faltan variables de WhatsApp para arrancar el servidor: ${missing.join(', ')}. Revisa docs/SETUP.md.`);
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  requireWhatsAppEnv(env);
  const prisma = new PrismaClient();
  const payments = createPaymentProvider(env);
  const orchestrator = new Orchestrator({
    prisma,
    channel: new WhatsAppChannel({
      token: env.WHATSAPP_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      graphApiVersion: env.GRAPH_API_VERSION,
    }),
    payments,
    crm: createCrmProvider(env),
    links: { privacyUrl: env.PRIVACY_POLICY_URL, introVideoUrl: env.INTRO_VIDEO_URL, bookingUrl: env.BOOKING_URL },
  });
  const { app } = await buildServer({ env, prisma, orchestrator, payments });
  new PaymentPoller({
    prisma,
    payments,
    orchestrator,
    intervalSeconds: env.PAYMENT_POLL_INTERVAL_SECONDS,
    maxMinutes: env.PAYMENT_POLL_MAX_MINUTES,
    log: app.log,
  }).start();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
