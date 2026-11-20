import type { Order, User } from '@prisma/client';
import { findProduct } from '../content/products.js';
import { RateLimiter } from '../lib/rateLimit.js';
import type { PaymentProvider, PaymentStatus } from './PaymentProvider.js';

export interface PayphoneConfig {
  token: string;
  storeId: string;
  apiBase: string;
  expiresHours: number;
}

export class PayphoneRateLimitError extends Error {
  constructor(what: string) {
    super(`Payphone: límite de 30 solicitudes por minuto alcanzado (${what})`);
  }
}

export interface RawResponse {
  httpStatus: number;
  body: unknown;
}

/**
 * Payphone API Link (docs.payphone.app/api-link) + consulta de estado (docs.payphone.app/api-sale).
 * Montos en centavos enteros. Ambos endpoints admiten 30 solicitudes por minuto.
 */
export class PayphoneProvider implements PaymentProvider {
  private readonly base: string;
  private readonly postLimiter = new RateLimiter(30, 60_000);
  private readonly getLimiter = new RateLimiter(30, 60_000);

  constructor(
    private readonly config: PayphoneConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.base = config.apiBase.replace(/\/$/, '');
  }

  private headers() {
    return { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' };
  }

  async createPaymentLink(order: Order, _user: User): Promise<{ url: string }> {
    if (!this.postLimiter.allow('links')) throw new PayphoneRateLimitError('POST /api/Links');
    const productName = findProduct(order.productId)?.name ?? order.productId;

    // Sin impuestos en la prueba: amount = amountWithoutTax. La doc marca el resto de campos como obligatorios.
    const body = {
      amount: order.amountCents,
      amountWithoutTax: order.amountCents,
      amountWithTax: 0,
      tax: 0,
      service: 0,
      tip: 0,
      currency: 'USD',
      storeId: this.config.storeId,
      reference: productName.slice(0, 100),
      clientTransactionId: order.clientTransactionId,
      oneTime: true,
      expireIn: Math.max(1, Math.ceil(this.config.expiresHours)),
      isAmountEditable: false,
      additionalData: order.id.slice(0, 250),
    };

    const res = await this.fetchFn(`${this.base}/api/Links`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = (await res.text()).trim();
    return { url: parseLinkResponse(res.status, text) };
  }

  /** Consulta cruda por `clientTransactionId` (`GET /api/Sale/client/{id}`). */
  async queryRaw(clientTransactionId: string): Promise<RawResponse> {
    if (!this.getLimiter.allow('sale')) throw new PayphoneRateLimitError('GET /api/Sale/client');
    const res = await this.fetchFn(`${this.base}/api/Sale/client/${encodeURIComponent(clientTransactionId)}`, {
      headers: this.headers(),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* cuerpo no JSON: se devuelve como texto */
    }
    return { httpStatus: res.status, body };
  }

  async getStatus(order: Order): Promise<PaymentStatus> {
    const { httpStatus, body } = await this.queryRaw(order.clientTransactionId);
    return interpretStatus(httpStatus, body);
  }
}

/** La respuesta exitosa es un string con la URL; un JSON es un error de validación. */
export function parseLinkResponse(httpStatus: number, text: string): string {
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* la URL puede venir sin comillas */
  }
  if (typeof value === 'string' && /^https:\/\//.test(value)) return value;
  if (value && typeof value === 'object') {
    const v = value as { message?: string; errorCode?: number; errors?: { message?: string; errorDescriptions?: string[] }[] };
    const detail = (v.errors ?? []).map((e) => `${e.message}: ${(e.errorDescriptions ?? []).join(', ')}`).join('; ');
    throw new Error(`Payphone rechazó la solicitud (HTTP ${httpStatus}, código ${v.errorCode ?? '?'}): ${v.message ?? ''} ${detail}`.trim());
  }
  throw new Error(`Respuesta inesperada de Payphone (HTTP ${httpStatus}): ${text.slice(0, 200)}`);
}

/**
 * statusCode 1 = pendiente, 2 = cancelada/rechazada, 3 = aprobada.
 * Una transacción que Payphone aún no registra responde con error: se trata como pendiente,
 * salvo credenciales inválidas (401/403) o caída del servicio (5xx), que se propagan.
 */
export function interpretStatus(httpStatus: number, body: unknown): PaymentStatus {
  if (httpStatus === 401 || httpStatus === 403 || httpStatus >= 500) {
    throw new Error(`Payphone consulta de estado: HTTP ${httpStatus}`);
  }
  const code = body && typeof body === 'object' ? (body as { statusCode?: unknown }).statusCode : undefined;
  if (code === 3) return 'approved';
  if (code === 2) return 'canceled';
  return 'pending';
}
