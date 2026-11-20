import { createInterface } from 'node:readline/promises';
import { PrismaClient } from '@prisma/client';
import { ConsoleChannel } from '../src/channels/console/ConsoleChannel.js';
import { getEnv } from '../src/config/env.js';
import { NoopCrmProvider } from '../src/crm/NoopCrmProvider.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MockPaymentProvider } from '../src/payments/MockPaymentProvider.js';

const PROMPT = '\n👩 > ';
const HELP =`Comandos del simulador:
  /pagar    aprueba el último pago pendiente
  /reset    borra tus datos de simulación y empieza de cero
  /ayuda    muestra esta ayuda
  /salir    termina
Para elegir una opción escribe su número o su título.`;

async function main() {
  const env = getEnv();
  const waId = process.argv[2] ?? 'simulador';
  const prisma = new PrismaClient();
  const channel = new ConsoleChannel();
  const orchestrator = new Orchestrator({
    prisma,
    channel,
    payments: new MockPaymentProvider(env.PUBLIC_BASE_URL),
    crm: new NoopCrmProvider(),
    links: { privacyUrl: env.PRIVACY_POLICY_URL, introVideoUrl: env.INTRO_VIDEO_URL, bookingUrl: env.BOOKING_URL },
  });

  console.log(`Simulador de chat (usuaria: ${waId}). Proveedores: pago mock, CRM noop.\n${HELP}`);
  await orchestrator.handleIncoming(waId, { kind: 'text', value: 'hola' });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(PROMPT);
    // Iterar sobre el flujo de líneas también funciona con stdin redirigido (pipes).
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        process.stdout.write(PROMPT);
        continue;
      }
      if (line === '/salir') break;
      if (line === '/ayuda') {
        console.log(HELP);
      } else if (line === '/reset') {
        const user = await prisma.user.findUnique({ where: { waId } });
        if (user) {
          await prisma.event.deleteMany({ where: { userId: user.id } });
          await prisma.order.deleteMany({ where: { userId: user.id } });
          await prisma.user.delete({ where: { id: user.id } });
        }
        console.log('Datos borrados.');
        await orchestrator.handleIncoming(waId, { kind: 'text', value: 'hola' });
      } else if (line === '/pagar') {
        const user = await prisma.user.findUnique({ where: { waId } });
        const order = user
          ? await prisma.order.findFirst({ where: { userId: user.id, status: 'pending' }, orderBy: { createdAt: 'desc' } })
          : null;
        if (!order) console.log('No hay pagos pendientes.');
        else await orchestrator.approveOrder(order.id);
      } else {
        await orchestrator.handleIncoming(waId, channel.resolveInput(line));
      }
      process.stdout.write(PROMPT);
    }
  } finally {
    rl.close();
    await orchestrator.idle();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
