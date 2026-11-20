import type { OutgoingMessage } from '../flow/types.js';

/**
 * Límites de la WhatsApp Cloud API para mensajes interactivos (verificados en la doc de Meta).
 * El cuerpo interactivo (1024) es más estricto que el de las listas (4096) a propósito: se usa 1024 para todos.
 */
export const WA_LIMITS = {
  maxButtons: 3,
  buttonTitle: 20,
  maxListRows: 10,
  rowTitle: 24,
  rowDescription: 72,
  listButtonLabel: 20,
  interactiveBody: 1024,
  textBody: 4096,
  buttonId: 256,
  rowId: 200,
} as const;

/** Devuelve la lista de violaciones de límites de un mensaje (vacía si es válido). */
export function validateMessage(m: OutgoingMessage): string[] {
  const errors: string[] = [];
  const max = (what: string, value: string, limit: number) => {
    if (value.length > limit) errors.push(`${what} excede ${limit} caracteres (${value.length}): "${value.slice(0, 40)}…"`);
  };
  if (m.body.trim().length === 0) errors.push('cuerpo vacío');

  if (m.type === 'text') {
    max('texto', m.body, WA_LIMITS.textBody);
    return errors;
  }
  max('cuerpo interactivo', m.body, WA_LIMITS.interactiveBody);
  if (m.type === 'buttons') {
    if (m.buttons.length < 1 || m.buttons.length > WA_LIMITS.maxButtons) errors.push(`botones: ${m.buttons.length} (máx. ${WA_LIMITS.maxButtons})`);
    for (const b of m.buttons) { max('título de botón', b.title, WA_LIMITS.buttonTitle); max('id de botón', b.id, WA_LIMITS.buttonId); }
    if (new Set(m.buttons.map((b) => b.id)).size !== m.buttons.length) errors.push('ids de botón repetidos');
  } else {
    if (m.rows.length < 1 || m.rows.length > WA_LIMITS.maxListRows) errors.push(`filas: ${m.rows.length} (máx. ${WA_LIMITS.maxListRows})`);
    max('etiqueta de lista', m.buttonLabel, WA_LIMITS.listButtonLabel);
    for (const r of m.rows) {
      max('título de fila', r.title, WA_LIMITS.rowTitle);
      max('id de fila', r.id, WA_LIMITS.rowId);
      if (r.description) max('descripción de fila', r.description, WA_LIMITS.rowDescription);
    }
    if (new Set(m.rows.map((r) => r.id)).size !== m.rows.length) errors.push('ids de fila repetidos');
  }
  return errors;
}
