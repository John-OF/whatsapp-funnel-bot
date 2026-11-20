import { describe, expect, it } from 'vitest';
import { handle, onPaymentApproved, onPaymentLinkCreated } from '../src/flow/engine.js';
import { newUserState } from '../src/flow/types.js';
import { bodyOf, button, ctx, list, run, text, TO_MENU } from './helpers.js';

const types = (r: ReturnType<typeof run>) => r.events.map((e) => e.type);

describe('camino feliz', () => {
  it('recorre bienvenida → consentimiento → datos → diagnóstico → menú', () => {
    const r = run(TO_MENU);
    expect(r.state.step).toBe('MAIN_MENU');
    expect(r.state.name).toBe('Ana');
    expect(r.state.email).toBe('ana@example.com');
    expect(r.state.consentAt).toBe(ctx.now.toISOString());
    expect(r.state.diagnosticScore).toBe(3);
    expect(r.state.diagnosticAnswers).toEqual([true, false, true, true]);
    expect(types(r)).toEqual([
      'conversation_started',
      'consent_accepted',
      'lead_captured',
      'diagnostic_answered',
      'diagnostic_answered',
      'diagnostic_answered',
      'diagnostic_answered',
      'diagnostic_completed',
      'menu_opened',
    ]);
    expect(r.outgoing[0]).toMatchObject({ type: 'list' });
  });

  it('sincroniza el CRM al capturar el email y al terminar el diagnóstico', () => {
    const r = run(TO_MENU);
    expect(r.effects).toEqual([
      { type: 'syncCrm', stage: 'lead' },
      { type: 'syncCrm', stage: 'diagnostic_done', extra: { wa_diagnostic_score: 3 } },
    ]);
  });

  it('recursos: lista → tema → enlaces → otro tema / menú', () => {
    const r = run([...TO_MENU, list('menu_learn'), list('res:saving')]);
    expect(r.state.step).toBe('RESOURCE_SENT');
    expect(bodyOf(r.outgoing[0])).toContain('https://youtube.com/watch?v=placeholder-ahorro');
    expect(types(r)).toContain('resource_viewed');
    expect(run([button('other_topic')], r.state).state.step).toBe('RESOURCES');
    expect(run([button('menu')], r.state).state.step).toBe('MAIN_MENU');
  });

  it('compra: producto → detalle → checkout emite createPayment', () => {
    const r = run([...TO_MENU, list('menu_products'), list('prod:planner-financiero'), button('buy')]);
    expect(r.state.step).toBe('CHECKOUT');
    expect(r.effects).toContainEqual({ type: 'createPayment', productId: 'planner-financiero' });
    expect(types(r)).toEqual(expect.arrayContaining(['product_viewed', 'checkout_started']));
  });

  it('pago: enlace creado → "Ya pagué" pide consultar → aprobado entrega el producto', () => {
    const atCheckout = run([...TO_MENU, list('menu_products'), list('prod:guia-digital'), button('buy')]).state;

    const linked = onPaymentLinkCreated(atCheckout, { orderId: 'o1', url: 'https://pay/x' }, ctx);
    expect(bodyOf(linked.outgoing[0])).toContain('https://pay/x');
    expect(linked.newState.stepData).toMatchObject({ orderId: 'o1', paymentUrl: 'https://pay/x' });

    const paid = handle(linked.newState, button('paid'), ctx);
    expect(paid.effects).toEqual([{ type: 'checkPayment' }]);
    expect(paid.outgoing).toEqual([]);

    const done = onPaymentApproved(linked.newState, 'guia-digital', ctx);
    expect(done.newState.step).toBe('DELIVERED');
    expect(bodyOf(done.outgoing[0])).toContain('https://drive.google.com/placeholder-guia-digital');
    expect(done.events.map((e) => e.type)).toEqual(['payment_approved', 'product_delivered']);
    expect(done.effects).toEqual([
      { type: 'syncCrm', stage: 'customer', extra: { wa_last_product: 'Guía Digital' } },
    ]);
  });

  it('agenda: enlace con nombre y email prellenados', () => {
    const r = run([...TO_MENU, list('menu_booking')]);
    expect(r.state.step).toBe('BOOKING');
    const url = new URL(/https:\/\/cal\.com\S+/.exec(bodyOf(r.outgoing[0]))![0]);
    expect(url.searchParams.get('name')).toBe('Ana');
    expect(url.searchParams.get('email')).toBe('ana@example.com');
    expect(types(r)).toContain('booking_link_sent');
  });

  it('la etapa del CRM solo avanza, nunca retrocede', () => {
    const inMenu = run(TO_MENU).state;
    const customer = onPaymentApproved(inMenu, 'guia-digital', ctx).newState;
    const r = run([button('menu'), list('menu_learn'), list('res:saving')], customer);
    expect(r.effects.filter((e) => e.type === 'syncCrm')).toEqual([]);
  });
});

describe('consentimiento', () => {
  it('rechazo: no se guarda nada personal y "hola" reinicia', () => {
    const r = run([text('hola'), button('start'), button('consent_no')]);
    expect(r.state.step).toBe('CONSENT_REJECTED');
    expect(r.state).toMatchObject({ name: null, email: null, consentAt: null });
    expect(types(r)).toEqual(['conversation_started', 'consent_rejected']);
    expect(r.effects).toEqual([]);
    expect(bodyOf(r.outgoing[0])).toContain('hola');

    expect(run([text('hola')], r.state).state.step).toBe('WELCOME');
  });

  it('antes de aceptar solo se registra conversation_started', () => {
    const r = run([text('hola'), button('start')]);
    expect(types(r)).toEqual(['conversation_started']);
  });

  it('"menu" sin consentimiento no abre el menú', () => {
    const r = run([text('hola'), text('menu')]);
    expect(r.state.step).toBe('WELCOME');
    expect(types(r)).toContain('invalid_input');
  });
});

describe('nombre y email', () => {
  const atName = run([text('hola'), button('start'), button('consent_yes')]).state;

  it('nombre fuera de 2–40 caracteres se vuelve a pedir', () => {
    expect(run([text('A')], atName).state.step).toBe('ASK_NAME');
    expect(run([text('x'.repeat(41))], atName).state.step).toBe('ASK_NAME');
    expect(run([text('  María   José ')], atName).state.name).toBe('María José');
  });

  it('email inválido: reintenta y al 3.er fallo sigue sin email', () => {
    const atEmail = run([text('Ana')], atName).state;
    const r1 = run([text('no-es-un-correo')], atEmail);
    expect(r1.state.step).toBe('ASK_EMAIL');
    expect(r1.state.stepData.emailAttempts).toBe(1);

    const r3 = run([text('mal'), text('mal@'), text('mal@x')], atEmail);
    expect(r3.state.step).toBe('DIAGNOSTIC_Q1');
    expect(r3.state.email).toBeNull();
    expect(r3.state.stepData.emailPending).toBe(true);
    expect(types(r3).filter((t) => t === 'invalid_input')).toHaveLength(3);
    expect(r3.effects).toEqual([]);
  });

  it('un email válido tras un fallo se acepta en minúsculas', () => {
    const atEmail = run([text('Ana')], atName).state;
    const r = run([text('mal'), text(' Ana@Example.COM ')], atEmail);
    expect(r.state.email).toBe('ana@example.com');
    expect(r.state.step).toBe('DIAGNOSTIC_Q1');
  });

  it('sin email, agendar o comprar lo pide de nuevo y luego retoma la acción', () => {
    const skipped = run([text('Ana'), text('a'), text('b'), text('c')], atName).state;
    const menu = run([...Array(4).fill(button('yes'))], skipped).state;
    expect(menu.step).toBe('MAIN_MENU');

    const asking = run([list('menu_booking')], menu);
    expect(asking.state.step).toBe('ASK_EMAIL');
    expect(asking.state.stepData.returnTo).toBe('booking');
    const back = run([text('ana@example.com')], asking.state);
    expect(back.state.step).toBe('BOOKING');
    expect(back.state.stepData.returnTo).toBeUndefined();

    const buying = run([list('menu_products'), list('prod:guia-digital'), button('buy')], menu);
    expect(buying.state.step).toBe('ASK_EMAIL');
    const checkout = run([text('ana@example.com')], buying.state);
    expect(checkout.state.step).toBe('CHECKOUT');
    expect(checkout.effects).toContainEqual({ type: 'createPayment', productId: 'guia-digital' });
  });
});

describe('comandos globales', () => {
  it('"hola" y "reiniciar" (sin tildes ni mayúsculas) vuelven a WELCOME sin consentimiento', () => {
    for (const cmd of ['HOLA', 'Hola!', ' reiniciar ', '¡Hola!']) {
      const r = run([text('hola'), button('start'), text(cmd)]);
      expect(r.state.step).toBe('WELCOME');
    }
  });

  it('con consentimiento, "hola" y "menu"/"menú" van al menú desde cualquier paso', () => {
    const inProducts = run([...TO_MENU, list('menu_products')]).state;
    for (const cmd of ['hola', 'Reiniciar', 'menu', 'MENÚ']) {
      expect(run([text(cmd)], inProducts).state.step).toBe('MAIN_MENU');
    }
    const midDiagnostic = run(TO_MENU.slice(0, 6)).state;
    expect(midDiagnostic.step).toBe('DIAGNOSTIC_Q2');
    expect(run([text('menú')], midDiagnostic).state.step).toBe('MAIN_MENU');
  });

  it('con consentimiento pero sin nombre, "hola" retoma la captura', () => {
    const atName = run([text('hola'), button('start'), button('consent_yes')]).state;
    expect(run([text('hola')], atName).state.step).toBe('ASK_NAME');
  });

  it('"hola" no repite conversation_started', () => {
    const r = run([text('hola'), text('hola'), text('hola')]);
    expect(types(r)).toEqual(['conversation_started']);
  });
});

describe('entrada inesperada', () => {
  it('responde "No te entendí" y reenvía el prompt del paso', () => {
    const r = run([text('hola'), text('blablá')]);
    expect(r.state.step).toBe('WELCOME');
    expect(r.state.invalidInputCount).toBe(1);
    expect(r.outgoing).toHaveLength(2);
    expect(bodyOf(r.outgoing[0])).toContain('No te entendí');
    expect(r.outgoing[1]).toMatchObject({ type: 'buttons' });
    expect(types(r)).toContain('invalid_input');
  });

  it('tipos no soportados (audio, imagen, sticker) cuentan como inesperados', () => {
    const r = run([text('hola'), { kind: 'unsupported', value: 'audio' }]);
    expect(bodyOf(r.outgoing[0])).toContain('No te entendí');
  });

  it('un texto donde se esperaba un botón es inesperado', () => {
    const r = run([...TO_MENU.slice(0, 5), text('quizás')]);
    expect(r.state.step).toBe('DIAGNOSTIC_Q1');
    expect(bodyOf(r.outgoing[0])).toContain('No te entendí');
  });

  it('a la 3.ª seguida envía el menú (con consentimiento) y reinicia el contador', () => {
    const r = run([...TO_MENU.slice(0, 5), text('a'), text('b'), text('c')]);
    expect(r.state.step).toBe('MAIN_MENU');
    expect(r.state.invalidInputCount).toBe(0);
    expect(r.outgoing.at(-1)).toMatchObject({ type: 'list' });
  });

  it('sin consentimiento, a la 3.ª seguida se vuelve a la bienvenida', () => {
    const r = run([text('hola'), button('start'), text('a'), text('b'), text('c')]);
    expect(r.state.step).toBe('WELCOME');
  });

  it('una entrada válida reinicia el contador', () => {
    const r = run([text('hola'), text('a'), text('b'), button('start'), text('c'), text('d')]);
    expect(r.state.step).toBe('CONSENT');
    expect(r.state.invalidInputCount).toBe(2);
  });

  it('recorta la entrada a 500 caracteres', () => {
    const atName = run([text('hola'), button('start'), button('consent_yes')]).state;
    const r = handle(atName, text('x'.repeat(2000)), ctx);
    expect(r.newState.step).toBe('ASK_NAME'); // 500 > 40: nombre inválido
  });
});

describe('estado', () => {
  it('el motor no muta el estado recibido', () => {
    const state = newUserState('1');
    const snapshot = structuredClone(state);
    handle(state, text('hola'), ctx);
    handle(state, button('start'), ctx);
    expect(state).toEqual(snapshot);
  });

  it('un paso desconocido (contenido cambiado) se recupera', () => {
    const state = { ...run(TO_MENU).state, step: 'DIAGNOSTIC_Q99' as const };
    expect(handle(state, button('yes'), ctx).newState.step).toBe('MAIN_MENU');
  });
});
