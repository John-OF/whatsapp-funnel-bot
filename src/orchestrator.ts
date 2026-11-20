import type { Order, PrismaClient, User } from '@prisma/client';
import type { Channel } from './channels/Channel.js';
import type { CrmProvider } from './crm/CrmProvider.js';
import { findProduct } from './content/products.js';
import { handle, onPaymentApproved, onPaymentClosed, onPaymentFailed, onPaymentLinkCreated, onPaymentPending } from './flow/engine.js';
import type {
  DomainEvent,
  Effect,
  FlowContext,
  FlowLinks,
  FunnelStage,
  HandleResult,
  IncomingInput,
  StepData,
  StepId,
  UserState,
} from './flow/types.js';
import { shortId } from './lib/ids.js';
import type { PaymentProvider, PaymentStatus } from './payments/PaymentProvider.js';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const consoleLogger: Logger = {
  info: (o, m) => console.log(m ?? '', o),
  warn: (o, m) => console.warn(m ?? '', o),
  error: (o, m) => console.error(m ?? '', o),
};

export interface OrchestratorDeps {
  prisma: PrismaClient;
  channel: Channel;
  payments: PaymentProvider;
  crm: CrmProvider;
  links: FlowLinks;
  log?: Logger;
  now?: () => Date;
  /** Base del backoff exponencial de las llamadas al CRM (ms). */
  crmBackoffMs?: number;
}

const CRM_ATTEMPTS = 3;

export function userToState(user: User): UserState {
  return {
    waId: user.waId,
    name: user.name,
    email: user.email,
    consentAt: user.consentAt?.toISOString() ?? null,
    consentVersion: user.consentVersion,
    step: user.step as StepId,
    stepData: JSON.parse(user.stepData) as StepData,
    invalidInputCount: user.invalidInputCount,
    diagnosticScore: user.diagnosticScore,
    diagnosticAnswers: JSON.parse(user.diagnosticAnswers) as boolean[],
  };
}

/**
 * Conecta el motor puro con el mundo exterior: base de datos, canal, pagos y CRM.
 * Los mensajes de una misma usuaria se procesan en orden (cola en memoria por waId).
 */
export class Orchestrator {
  private readonly log: Logger;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly crmQueues = new Map<string, Promise<void>>();
  private readonly background =new Set<Promise<void>>();

  constructor(private readonly deps: OrchestratorDeps) {
    this.log = deps.log ?? consoleLogger;
  }

  private ctx(): FlowContext {
    return { now: (this.deps.now ?? (() => new Date()))(), links: this.deps.links };
  }

  /** Cola serial por waId: evita carreras entre mensajes y aprobaciones de pago. */
  private enqueue<T>(waId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(waId) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.catch(() => undefined);
    this.queues.set(waId, tail);
    void tail.then(() => {
      if (this.queues.get(waId) === tail) this.queues.delete(waId);
    });
    return run;
  }

  /** Espera a que terminen las sincronizaciones de CRM en segundo plano (útil en tests). */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  handleIncoming(waId: string, input: IncomingInput): Promise<void> {
    return this.enqueue(waId, async () => {
      const user = await this.deps.prisma.user.upsert({ where: { waId }, update: {}, create: { waId } });
      const result = handle(userToState(user), input, this.ctx());
      await this.apply(user.id, result);
    });
  }

  /** Aprueba una orden y entrega el producto una sola vez, sin importar por cuántas vías llegue. */
  async approveOrder(orderId: string): Promise<'delivered' | 'already_delivered' | 'not_found'> {
    const order = await this.deps.prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
    if (!order) return 'not_found';
    return this.enqueue(order.user.waId, () => this.approveLocked(orderId));
  }

  private async approveLocked(orderId: string): Promise<'delivered' | 'already_delivered' | 'not_found'> {
    const { prisma } = this.deps;
    const now = this.ctx().now;
    const claimed = await prisma.order.updateMany({
      where: { id: orderId, deliveredAt: null, status: { in: ['pending', 'expired'] } },
      data: { status: 'approved', paidAt: now, deliveredAt: now },
    });
    if (claimed.count === 0) {
      return (await prisma.order.findUnique({ where: { id: orderId } })) ? 'already_delivered' : 'not_found';
    }
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { user: true } });
    const total = await prisma.order.aggregate({
      where: { userId: order.userId, status: 'approved' },
      _sum: { amountCents: true },
    });
    const result = onPaymentApproved(userToState(order.user), order.productId, this.ctx());
    result.effects = result.effects.map((e) =>
      e.type === 'syncCrm' && e.extra
        ? { ...e, extra: { ...e.extra, wa_total_spent: (total._sum.amountCents ?? 0) / 100 } }
        : e,
    );
    await this.apply(order.userId, result);
    return 'delivered';
  }

  /** Marca como vencidas las órdenes pendientes y avisa a la usuaria. */
  async expireOrder(orderId: string): Promise<void> {
    const order = await this.deps.prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
    if (!order) return;
    await this.enqueue(order.user.waId, async () => {
      const claimed = await this.deps.prisma.order.updateMany({
        where: { id: orderId, status: 'pending' },
        data: { status: 'expired' },
      });
      if (claimed.count === 0) return;
      const user = await this.deps.prisma.user.findUniqueOrThrow({ where: { id: order.userId } });
      await this.apply(user.id, onPaymentClosed(userToState(user), 'expired', this.ctx()));
    });
  }

  /** La usuaria canceló el pago (p. ej. en la página de pago simulada). */
  async cancelOrder(orderId: string): Promise<void> {
    const order = await this.deps.prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
    if (!order) return;
    await this.enqueue(order.user.waId, async () => {
      const claimed = await this.deps.prisma.order.updateMany({
        where: { id: orderId, status: 'pending' },
        data: { status: 'canceled' },
      });
      if (claimed.count === 0) return;
      const user = await this.deps.prisma.user.findUniqueOrThrow({ where: { id: order.userId } });
      await this.apply(user.id, onPaymentClosed(userToState(user), 'canceled', this.ctx()));
    });
  }

  // ---------- aplicación de resultados ----------

  private async apply(userId: string, result: HandleResult): Promise<void> {
    const { prisma, channel } = this.deps;
    const s = result.newState;
    await prisma.user.update({
      where: { id: userId },
      data: {
        name: s.name,
        email: s.email,
        consentAt: s.consentAt ? new Date(s.consentAt) : null,
        consentVersion: s.consentVersion,
        step: s.step,
        stepData: JSON.stringify(s.stepData),
        invalidInputCount: s.invalidInputCount,
        diagnosticScore: s.diagnosticScore,
        diagnosticAnswers: JSON.stringify(s.diagnosticAnswers),
      },
    });
    await this.logEvents(userId, result.events);
    if (result.outgoing.length > 0) {
      try {
        await channel.send(s.waId, result.outgoing);
      } catch (err) {
        this.log.error({ err, waId: s.waId }, 'No se pudo enviar el mensaje');
      }
    }
    for (const effect of result.effects) await this.runEffect(userId, s, effect);
  }

  private async logEvents(userId: string | null, events: DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.deps.prisma.event.createMany({
      data: events.map((e) => ({ userId, type: e.type, payload: JSON.stringify(e.payload) })),
    });
  }

  private async runEffect(userId: string, state: UserState, effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'createPayment':
        return this.createPayment(userId, state, effect.productId);
      case 'checkPayment':
        return this.checkPayment(userId, state);
      case 'syncCrm':
        this.syncCrmInBackground(userId, effect.stage, effect.extra);
        return;
    }
  }

  private async createPayment(userId: string, state: UserState, productId: string): Promise<void> {
    const { prisma, payments } = this.deps;
    const product = findProduct(productId);
    let result: HandleResult;
    try {
      if (!product) throw new Error(`Producto desconocido: ${productId}`);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const order = await prisma.order.create({
        data: {
          userId,
          productId,
          amountCents: product.priceCents,
          clientTransactionId: shortId(12),
        },
      });
      const { url } = await payments.createPaymentLink(order, user);
      await prisma.order.update({ where: { id: order.id }, data: { paymentUrl: url } });
      result = onPaymentLinkCreated(state, { orderId: order.id, url }, this.ctx());
    } catch (err) {
      this.log.error({ err, productId }, 'No se pudo crear el enlace de pago');
      result = onPaymentFailed(state, this.ctx());
    }
    await this.apply(userId, result);
  }

  private async checkPayment(userId: string, state: UserState): Promise<void> {
    const { prisma, payments } = this.deps;
    const order: Order | null = await prisma.order.findFirst({
      where: { userId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    if (!order) return;
    let status: PaymentStatus;
    try {
      status = await payments.getStatus(order);
    } catch (err) {
      // Si el proveedor no responde no se bloquea la conversación: se trata como pendiente.
      this.log.warn({ err, orderId: order.id }, 'No se pudo consultar el estado del pago');
      status = 'pending';
    }
    if (status === 'approved') {
      await this.approveLocked(order.id);
    } else if (status === 'canceled') {
      await prisma.order.update({ where: { id: order.id }, data: { status: 'canceled' } });
      await this.apply(userId, onPaymentClosed(state, 'canceled', this.ctx()));
    } else {
      await this.apply(userId, onPaymentPending(state));
    }
  }

  // ---------- CRM (nunca bloquea la conversación) ----------

  private syncCrmInBackground(userId: string, stage: FunnelStage, extra?: Record<string, string | number>): void {
    // Una cola por usuaria: las actualizaciones llegan al CRM en orden y sin crear contactos duplicados.
    const prev = this.crmQueues.get(userId) ?? Promise.resolve();
    const task: Promise<void> = prev
      .then(() => this.syncCrm(userId, stage, extra))
      .catch((err) => this.log.error({ err, stage }, 'Error inesperado en la sincronización con el CRM'))
      .finally(() => {
        this.background.delete(task);
        if (this.crmQueues.get(userId) === task) this.crmQueues.delete(userId);
      });
    this.crmQueues.set(userId, task);
    this.background.add(task);
  }

  private async syncCrm(userId: string, stage: FunnelStage, extra?: Record<string, string | number>): Promise<void> {
    const { prisma, crm } = this.deps;
    const base = this.deps.crmBackoffMs ?? 500;
    let lastError: unknown;
    for (let attempt = 1; attempt <= CRM_ATTEMPTS; attempt++) {
      try {
        let user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        if (!user.email) return; // el CRM solo recibe contactos con email capturado
        if (!user.hubspotContactId) {
          const { contactId } = await crm.upsertContact(user);
          user = await prisma.user.update({ where: { id: userId }, data: { hubspotContactId: contactId } });
        }
        await crm.updateStage(user, stage, extra);
        return;
      } catch (err) {
        lastError = err;
        if (attempt < CRM_ATTEMPTS) await new Promise((r) => setTimeout(r, base * 2 ** (attempt - 1)));
      }
    }
    this.log.error({ err: lastError, stage }, 'Falló la sincronización con el CRM');
    await this.logEvents(userId, [
      { type: 'crm_sync_failed', payload: { stage, error: String((lastError as Error)?.message ?? lastError) } },
    ]);
  }
}
