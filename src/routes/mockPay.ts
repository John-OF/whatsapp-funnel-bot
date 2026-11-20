import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { findProduct } from '../content/products.js';
import { formatPrice } from '../lib/text.js';
import type { Orchestrator } from '../orchestrator.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pago de prueba</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 20px;text-align:center}
button{font-size:1.1rem;padding:.8rem 1.4rem;margin:.4rem;border:0;border-radius:8px;cursor:pointer}
.ok{background:#1a7f37;color:#fff}.no{background:#eee}small{color:#777}</style></head><body>${body}</body></html>`;
}

/** Página de pago simulada (solo con PAYMENT_PROVIDER=mock). */
export async function mockPayRoutes(
  app: FastifyInstance,
  opts: { orchestrator: Orchestrator; prisma: PrismaClient },
): Promise<void> {
  // Los formularios sin campos llegan como urlencoded vacío.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.get<{ Params: { orderId: string } }>('/mock-pay/:orderId', async (req, reply) => {
    const order = await opts.prisma.order.findUnique({ where: { id: req.params.orderId } });
    if (!order) return reply.code(404).type('text/html').send(page('<h2>Orden no encontrada</h2>'));
    const product = findProduct(order.productId);
    const id = esc(order.id);
    const title = `<h2>Pago de prueba</h2><p>${esc(product?.name ?? order.productId)} — ${formatPrice(order.amountCents)}</p><small>Página simulada: no se cobra nada.</small>`;
    if (order.status !== 'pending') {
      return reply.type('text/html').send(page(`${title}<p>Estado de la orden: <b>${esc(order.status)}</b></p>`));
    }
    return reply.type('text/html').send(
      page(`${title}<form method="post" action="/mock-pay/${id}/approve"><button class="ok">Aprobar pago</button></form>
<form method="post" action="/mock-pay/${id}/cancel"><button class="no">Cancelar</button></form>`),
    );
  });

  app.post<{ Params: { orderId: string } }>('/mock-pay/:orderId/approve', async (req, reply) => {
    const result = await opts.orchestrator.approveOrder(req.params.orderId);
    if (result === 'not_found') return reply.code(404).type('text/html').send(page('<h2>Orden no encontrada</h2>'));
    return reply.type('text/html').send(page('<h2>✅ Pago aprobado</h2><p>Vuelve a WhatsApp: ya te envié tu producto.</p>'));
  });

  app.post<{ Params: { orderId: string } }>('/mock-pay/:orderId/cancel', async (req, reply) => {
    await opts.orchestrator.cancelOrder(req.params.orderId);
    return reply.type('text/html').send(page('<h2>Pago cancelado</h2><p>Puedes volver a WhatsApp.</p>'));
  });
}
