import type { PrismaClient } from '@prisma/client';
import type { DomainEventType } from './flow/types.js';

/** Pasos del embudo principal, en orden. Cada uno cuenta usuarias distintas que lo alcanzaron. */
export const FUNNEL: { key: DomainEventType; label: string }[] = [
  { key: 'conversation_started', label: 'Inició la conversación' },
  { key: 'consent_accepted', label: 'Aceptó el tratamiento de datos' },
  { key: 'lead_captured', label: 'Dejó su correo (lead)' },
  { key: 'diagnostic_completed', label: 'Completó el diagnóstico' },
  { key: 'product_viewed', label: 'Vio un producto' },
  { key: 'checkout_started', label: 'Inició el pago' },
  { key: 'payment_approved', label: 'Pagó (clienta)' },
];

/** Caminos laterales: no siguen al paso anterior, se miden contra los leads. */
export const BRANCHES: { key: DomainEventType; label: string }[] = [
  { key: 'resource_viewed', label: 'Vio recursos gratuitos' },
  { key: 'booking_link_sent', label: 'Recibió el enlace de agenda' },
];

const round = (n: number) => Math.round(n * 1000) / 1000;
const rate = (n: number, d: number) => (d === 0 ? null : round(n / d));

/** Embudo en JSON: usuarias por paso alcanzado y conversión entre pasos, calculado desde la tabla Event. */
export async function buildStats(prisma: PrismaClient) {
  const rows = await prisma.$queryRaw<{ type: string; users: bigint | number }[]>`
    SELECT type, COUNT(DISTINCT userId) AS users FROM Event WHERE userId IS NOT NULL GROUP BY type`;
  const usersBy = new Map(rows.map((r) => [r.type, Number(r.users)]));
  const count = (key: string) => usersBy.get(key) ?? 0;

  const funnel = FUNNEL.map((step, i) => {
    const users = count(step.key);
    const prev = i > 0 ? count(FUNNEL[i - 1]!.key) : null;
    return {
      step: step.key,
      label: step.label,
      users,
      conversionFromPrevious: prev === null ? null : rate(users, prev),
      conversionFromStart: rate(users, count(FUNNEL[0]!.key)),
    };
  });
  const leads = count('lead_captured');
  const branches = BRANCHES.map((b) => ({ step: b.key, label: b.label, users: count(b.key), rateOfLeads: rate(count(b.key), leads) }));

  const [totalUsers, consentedUsers, orderGroups, revenue, eventTotals] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { consentAt: { not: null } } }),
    prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.order.aggregate({ where: { status: 'approved' }, _sum: { amountCents: true } }),
    prisma.event.groupBy({ by: ['type'], where: { type: { in: ['invalid_input', 'crm_sync_failed', 'payment_expired'] } }, _count: { _all: true } }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    users: { total: totalUsers, withConsent: consentedUsers },
    funnel,
    branches,
    orders: {
      byStatus: Object.fromEntries(orderGroups.map((g) => [g.status, g._count._all])),
      revenueCents: revenue._sum.amountCents ?? 0,
    },
    issues: Object.fromEntries(eventTotals.map((g) => [g.type, g._count._all])),
  };
}
