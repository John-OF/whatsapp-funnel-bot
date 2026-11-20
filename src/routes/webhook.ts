import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { extractMessages, type IncomingWhatsAppMessage } from '../channels/whatsapp/parse.js';
import { verifySignature } from '../channels/whatsapp/signature.js';
import { RateLimiter } from '../lib/rateLimit.js';
import type { Orchestrator } from '../orchestrator.js';

export interface WebhookOptions {
  orchestrator: Orchestrator;
  prisma: PrismaClient;
  verifyToken: string;
  appSecret: string;
  rateLimiter?: RateLimiter;
  /** Recorte del texto entrante, en caracteres. */
  maxTextLength?: number;
}

/** Registra `GET/POST /webhooks/whatsapp`. Devuelve una función que espera el procesamiento en curso (tests). */
export async function webhookRoutes(app: FastifyInstance, opts: WebhookOptions): Promise<() => Promise<void>> {
  const limiter = opts.rateLimiter ?? new RateLimiter(20, 60_000);
  const maxText = opts.maxTextLength ?? 500;
  const inflight = new Set<Promise<void>>();

  // Se conserva el cuerpo crudo: la firma se calcula sobre los bytes exactos que envió Meta.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.get('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && opts.verifyToken && q['hub.verify_token'] === opts.verifyToken) {
      return reply.code(200).type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send();
  });

  app.post('/webhooks/whatsapp', async (req, reply) => {
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, opts.appSecret)) {
      req.log.warn('Firma inválida en el webhook de WhatsApp');
      return reply.code(401).send();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.code(400).send();
    }

    // Se responde 200 de inmediato. Cada mensaje se encola de forma síncrona (en orden de llegada)
    // en la cola de su waId, así el orden se conserva aunque lleguen varias peticiones a la vez.
    for (const msg of extractMessages(payload)) enqueue(msg.waId, () => processMessage(msg, req.log));
    return reply.code(200).send();
  });

  const queues = new Map<string, Promise<void>>();
  function enqueue(waId: string, task: () => Promise<void>): void {
    const run = (queues.get(waId) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => undefined);
    queues.set(waId, tail);
    inflight.add(tail);
    void tail.then(() => {
      inflight.delete(tail);
      if (queues.get(waId) === tail) queues.delete(waId);
    });
  }

  async function processMessage(msg: IncomingWhatsAppMessage, log: FastifyInstance['log']): Promise<void> {
    try {
      if (await isDuplicate(msg.id)) {
        log.info({ messageId: msg.id }, 'Mensaje duplicado ignorado');
        return;
      }
      if (!limiter.allow(msg.waId)) {
        log.warn({ waId: msg.waId, messageId: msg.id }, 'Rate limit excedido: mensaje ignorado');
        return;
      }
      const input = msg.input.kind === 'text' ? { ...msg.input, value: msg.input.value.slice(0, maxText) } : msg.input;
      await opts.orchestrator.handleIncoming(msg.waId, input);
    } catch (err) {
      log.error({ err, messageId: msg.id }, 'Error procesando mensaje de WhatsApp');
    }
  }

  /** Meta reintenta los webhooks: `message.id` único en `ProcessedMessage`. */
  async function isDuplicate(waMessageId: string): Promise<boolean> {
    try {
      await opts.prisma.processedMessage.create({ data: { waMessageId } });
      return false;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return true;
      throw err;
    }
  }

  return async () => {
    while (inflight.size > 0) await Promise.all([...inflight]);
  };
}
