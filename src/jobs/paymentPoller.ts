import type { PrismaClient } from '@prisma/client';
import type { Logger, Orchestrator } from '../orchestrator.js';
import type { PaymentProvider } from '../payments/PaymentProvider.js';

export interface PollerOptions {
  prisma: PrismaClient;
  payments: PaymentProvider;
  orchestrator: Orchestrator;
  intervalSeconds: number;
  maxMinutes: number;
  log: Logger;
  now?: () => Date;
}

/**
 * Consulta periódica de pagos pendientes: las órdenes recientes se consultan al proveedor;
 * las que superan `maxMinutes` sin pago se marcan como vencidas.
 */
export class PaymentPoller {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly opts: PollerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Una pasada. Nunca lanza; evita solaparse con una pasada anterior lenta. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { prisma, payments, orchestrator, log } = this.opts;
      const now = (this.opts.now ?? (() => new Date()))();
      const cutoff = new Date(now.getTime() - this.opts.maxMinutes * 60_000);
      const pending = await prisma.order.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' } });

      for (const order of pending) {
        try {
          if (order.createdAt < cutoff) {
            await orchestrator.expireOrder(order.id);
            continue;
          }
          const status = await payments.getStatus(order);
          if (status === 'approved') await orchestrator.approveOrder(order.id);
          else if (status === 'canceled') await orchestrator.cancelOrder(order.id);
        } catch (err) {
          log.warn({ err, orderId: order.id }, 'No se pudo consultar el estado del pago');
        }
      }
    } catch (err) {
      this.opts.log.error({ err }, 'Falló el poller de pagos');
    } finally {
      this.running = false;
    }
  }
}
