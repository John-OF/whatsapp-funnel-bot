import type { Order, User } from '@prisma/client';

export type PaymentStatus = 'pending' | 'approved' | 'canceled';

export interface PaymentProvider {
  createPaymentLink(order: Order, user: User): Promise<{ url: string }>;
  getStatus(order: Order): Promise<PaymentStatus>;
}
