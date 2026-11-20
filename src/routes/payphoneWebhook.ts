import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Orchestrator } from '../orchestrator.js';
import type { PaymentProvider } from '../payments/PaymentProvider.js';

const notificationSchema = z
  .object({
    ClientTransactionId: z.string().min(1),
    StatusCode: z.coerce.number(),
    TransactionId: z.coerce.number().optional(),
  })
  .passthrough();

const OK = { Response: true, ErrorCode: '000' };
const FAIL = { Response: false, ErrorCode: '111' };

/**
 * Notificación externa de Payphone (docs.payphone.app/notificacion-externa).
 * Se registra solo con PAYPHONE_NOTIFICATIONS_ENABLED=true: Payphone exige autorización previa del servicio.
 *
 * La notificación no está firmada, así que antes de aprobar se confirma con la consulta de estado.
 * La entrega es idempotente (por orden), por lo que los reenvíos con el mismo TransactionId no duplican nada.
 */
export async function payphoneWebhookRoutes(
  app: FastifyInstance,
  opts: { orchestrator: Orchestrator; prisma: PrismaClient; payments: PaymentProvider },
): Promise<void> {
  app.post('/webhooks/payphone', async (req, reply) => {
    const parsed = notificationSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(FAIL);
    const { ClientTransactionId, StatusCode, TransactionId } = parsed.data;

    const order = await opts.prisma.order.findUnique({ where: { clientTransactionId: ClientTransactionId } });
    if (!order) return FAIL;

    if (TransactionId !== undefined && !order.providerTransactionId) {
      await opts.prisma.order.update({ where: { id: order.id }, data: { providerTransactionId: String(TransactionId) } });
    }
    try {
      const confirmed = await opts.payments.getStatus(order);
      if (StatusCode === 3 && confirmed === 'approved') await opts.orchestrator.approveOrder(order.id);
      else if (StatusCode === 2 && confirmed === 'canceled') await opts.orchestrator.cancelOrder(order.id);
      else if (StatusCode === 3 || StatusCode === 2) return FAIL; // no coincide con la consulta de estado
    } catch (err) {
      req.log.error({ err, orderId: order.id }, 'No se pudo confirmar la notificación de Payphone');
      return FAIL;
    }
    return OK;
  });
}
