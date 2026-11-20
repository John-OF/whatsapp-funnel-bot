import { timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { toCsv } from '../lib/csv.js';
import type { Orchestrator } from '../orchestrator.js';
import { buildStats } from '../stats.js';

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from((header ?? '').replace(/^Bearer /, ''));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const BOM = '﻿'; // para que Excel abra bien las tildes

/** Rutas protegidas con `Authorization: Bearer {ADMIN_TOKEN}`. */
export async function adminRoutes(
  app: FastifyInstance,
  opts: { orchestrator: Orchestrator; prisma: PrismaClient; adminToken: string },
): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (!tokenMatches(req.headers.authorization, opts.adminToken)) return reply.code(401).send({ error: 'unauthorized' });
  });

  /** Aprobación manual (pruebas, o si el entorno de Payphone no permite consultar estados). */
  app.post<{ Params: { id: string } }>('/admin/orders/:id/approve', async (req, reply) => {
    const result = await opts.orchestrator.approveOrder(req.params.id);
    if (result === 'not_found') return reply.code(404).send({ error: 'order_not_found' });
    return { result };
  });

  app.get('/admin/stats', async () => buildStats(opts.prisma));

  app.get('/admin/export/users.csv', async (_req, reply) => {
    const users = await opts.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    const csv = toCsv(
      ['id', 'waId', 'name', 'email', 'consentAt', 'consentVersion', 'step', 'diagnosticScore', 'diagnosticAnswers', 'hubspotContactId', 'createdAt', 'updatedAt'],
      users.map((u) => [u.id, u.waId, u.name, u.email, u.consentAt, u.consentVersion, u.step, u.diagnosticScore, u.diagnosticAnswers, u.hubspotContactId, u.createdAt, u.updatedAt]),
    );
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="users.csv"').send(BOM + csv);
  });

  app.get('/admin/export/events.csv', async (_req, reply) => {
    const events = await opts.prisma.event.findMany({ orderBy: { createdAt: 'asc' } });
    const csv = toCsv(
      ['id', 'userId', 'type', 'payload', 'createdAt'],
      events.map((e) => [e.id, e.userId, e.type, e.payload, e.createdAt]),
    );
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="events.csv"').send(BOM + csv);
  });
}
