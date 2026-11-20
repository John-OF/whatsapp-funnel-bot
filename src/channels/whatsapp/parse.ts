import { z } from 'zod';
import type { IncomingInput } from '../../flow/types.js';

export interface IncomingWhatsAppMessage {
  id: string;
  waId: string;
  input: IncomingInput;
}

const messageSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ id: z.string() }).optional(),
        list_reply: z.object({ id: z.string() }).optional(),
      })
      .optional(),
  })
  .passthrough();

const payloadSchema = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(z.object({ value: z.object({ messages: z.array(z.unknown()).optional() }).passthrough() }).passthrough())
          .default([]),
      }),
    )
    .default([]),
});

/**
 * Extrae los mensajes entrantes del payload del webhook.
 * Los eventos `statuses` (entregado, leído) y las reacciones se ignoran.
 */
export function extractMessages(payload: unknown): IncomingWhatsAppMessage[] {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return [];
  const out: IncomingWhatsAppMessage[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      for (const raw of change.value.messages ?? []) {
        const m = messageSchema.safeParse(raw);
        if (!m.success) continue;
        const { id, from, type, text, interactive } = m.data;
        if (type === 'reaction') continue;
        let input: IncomingInput = { kind: 'unsupported', value: type };
        if (type === 'text' && text) input = { kind: 'text', value: text.body };
        else if (type === 'interactive' && interactive?.button_reply) input = { kind: 'button', value: interactive.button_reply.id };
        else if (type === 'interactive' && interactive?.list_reply) input = { kind: 'list', value: interactive.list_reply.id };
        out.push({ id, waId: from, input });
      }
    }
  }
  return out;
}
