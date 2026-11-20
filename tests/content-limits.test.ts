import { describe, expect, it } from 'vitest';
import { diagnosticQuestions } from '../src/content/diagnostic.js';
import { products } from '../src/content/products.js';
import { resourceTopics } from '../src/content/resources.js';
import { validateMessage, WA_LIMITS } from '../src/lib/whatsappLimits.js';
import { button, list, run, text, TO_MENU } from './helpers.js';

describe('límites de WhatsApp', () => {
  it('todos los mensajes que emite el flujo respetan los límites', () => {
    const all = [
      ...run(TO_MENU).allOutgoing,
      ...run([text('hola'), button('start'), button('consent_no'), text('x'), text('hola')]).allOutgoing,
      // email inválido, nombre inválido
      ...run([text('hola'), button('start'), button('consent_yes'), text('A'), text('Ana'), text('mal')]).allOutgoing,
      // todos los temas y productos
      ...resourceTopics.flatMap((t) => run([...TO_MENU, list('menu_learn'), list(`res:${t.id}`)]).allOutgoing),
      ...products.flatMap((p) =>
        run([...TO_MENU, list('menu_products'), list(`prod:${p.id}`), button('buy')]).allOutgoing,
      ),
      ...run([...TO_MENU, list('menu_booking')]).allOutgoing,
      ...run([...TO_MENU, text('???')]).allOutgoing,
      ...diagnosticQuestions.flatMap((_, i) => run(TO_MENU.slice(0, 5 + i)).allOutgoing),
    ];
    expect(all.length).toBeGreaterThan(30);
    const problems = all.flatMap((m) => validateMessage(m));
    expect(problems).toEqual([]);
  });

  it('las listas de recursos y productos caben en 10 filas', () => {
    expect(resourceTopics.length).toBeLessThanOrEqual(WA_LIMITS.maxListRows);
    expect(products.length).toBeLessThanOrEqual(WA_LIMITS.maxListRows);
  });

  it('el validador detecta excesos', () => {
    expect(validateMessage({ type: 'buttons', body: 'x', buttons: [{ id: 'a', title: 'x'.repeat(21) }] })).not.toEqual([]);
    expect(
      validateMessage({
        type: 'buttons',
        body: 'x',
        buttons: [1, 2, 3, 4].map((n) => ({ id: `${n}`, title: 'ok' })),
      }),
    ).not.toEqual([]);
    expect(validateMessage({ type: 'buttons', body: 'x'.repeat(1025), buttons: [{ id: 'a', title: 'ok' }] })).not.toEqual([]);
    expect(
      validateMessage({
        type: 'list',
        body: 'x',
        buttonLabel: 'ok',
        rows: [{ id: 'a', title: 'x'.repeat(25), description: 'y'.repeat(73) }],
      }),
    ).toHaveLength(2);
    expect(
      validateMessage({
        type: 'list',
        body: 'x',
        buttonLabel: 'ok',
        rows: Array.from({ length: 11 }, (_, n) => ({ id: `${n}`, title: 'ok' })),
      }),
    ).not.toEqual([]);
  });
});
