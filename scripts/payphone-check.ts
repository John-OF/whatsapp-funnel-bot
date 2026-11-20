/**
 * Verificación manual de Payphone contra el entorno de pruebas (sin base de datos ni WhatsApp):
 *   1. crea un link real con POST /api/Links,
 *   2. consulta GET /api/Sale/client/{clientTransactionId} mientras pagas el link,
 *   3. imprime las respuestas crudas para documentar el comportamiento en docs/DECISIONS.md.
 *
 * Uso: PAYMENT_PROVIDER=payphone (con PAYPHONE_TOKEN y PAYPHONE_STORE_ID) y `npm run payphone:check`.
 */
import type { Order, User } from '@prisma/client';
import { getEnv } from '../src/config/env.js';
import { shortId } from '../src/lib/ids.js';
import { PayphoneProvider } from '../src/payments/PayphoneProvider.js';

const POLL_EVERY_MS = 10_000;
const MAX_MINUTES = 10;

async function main() {
  const env = getEnv();
  if (!env.PAYPHONE_TOKEN || !env.PAYPHONE_STORE_ID) {
    throw new Error('Configura PAYPHONE_TOKEN y PAYPHONE_STORE_ID en .env (ver docs/SETUP.md).');
  }
  const provider = new PayphoneProvider({
    token: env.PAYPHONE_TOKEN,
    storeId: env.PAYPHONE_STORE_ID,
    apiBase: env.PAYPHONE_API_BASE,
    expiresHours: env.PAYMENT_LINK_EXPIRES_HOURS,
  });
  const order = { id: 'check-' + shortId(6), productId: 'guia-digital', amountCents: 100, clientTransactionId: shortId(12) } as Order;

  console.log(`clientTransactionId: ${order.clientTransactionId}`);
  const { url } = await provider.createPaymentLink(order, {} as User);
  console.log(`\n✅ Link creado: ${url}\nPaga en el entorno de pruebas; consulto el estado cada ${POLL_EVERY_MS / 1000}s (máx. ${MAX_MINUTES} min).\n`);

  const deadline = Date.now() + MAX_MINUTES * 60_000;
  while (Date.now() < deadline) {
    const { httpStatus, body } = await provider.queryRaw(order.clientTransactionId);
    console.log(`[${new Date().toLocaleTimeString()}] HTTP ${httpStatus} ${JSON.stringify(body)}`);
    const code = (body as { statusCode?: number } | null)?.statusCode;
    if (code === 2 || code === 3) {
      console.log(`\n${code === 3 ? '✅ Aprobada' : '❌ Cancelada'} por consulta de estado: el poller y "Ya pagué" funcionarán.`);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
  }
  console.log('\n⚠️ No se vio un estado final en el tiempo dado. Revisa el pago en Payphone Developer > Probadores > Transacciones y anota el resultado en docs/DECISIONS.md; mientras tanto usa POST /admin/orders/:id/approve.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
