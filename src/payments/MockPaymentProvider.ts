import type { Order, User } from '@prisma/client';
import type { PaymentProvider, PaymentStatus } from './PaymentProvider.js';

/**
 * Pago simulado. El enlace apunta a `/mock-pay/{orderId}` (ruta HTTP en el Hito 2);
 * en el simulador de terminal el pago se aprueba con `/pagar`.
 * El estado lo decide el orquestador al aprobar la orden, así que aquí solo se refleja.
 */
export class MockPaymentProvider implements PaymentProvider {
  constructor(private readonly publicBaseUrl: string) {}

  async createPaymentLink(order: Order, _user: User): Promise<{ url: string }> {
    return { url: `${this.publicBaseUrl.replace(/\/$/, '')}/mock-pay/${order.id}` };
  }

  async getStatus(order: Order): Promise<PaymentStatus> {
    if (order.status === 'approved') return 'approved';
    if (order.status === 'canceled') return 'canceled';
    return 'pending';
  }
}
