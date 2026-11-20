import { messages } from '../content/messages.js';
import { findProduct } from '../content/products.js';
import { normalizeText } from '../lib/text.js';
import { advanceStage, dispatchStep, goTo, stepPrompt } from './steps.js';
import type { FlowContext, HandleResult, IncomingInput, OutgoingMessage, UserState } from './types.js';

export const MAX_INPUT_LENGTH = 500;
const MAX_INVALID_IN_A_ROW = 3;

const text = (body: string): OutgoingMessage => ({ type: 'text', body });

/** Retoma el flujo de una usuaria que ya dio consentimiento, sin repetir pasos ya completos. */
function resume(state: UserState, ctx: FlowContext): HandleResult {
  if (!state.name) return goTo(state, 'ASK_NAME', ctx);
  if (!state.email && !state.stepData.emailPending) return goTo(state, 'ASK_EMAIL', ctx);
  return goTo(state, 'MAIN_MENU', ctx);
}

/**
 * Máquina de estados del bot. Función pura: no toca red, base de datos ni reloj.
 * Las acciones externas se devuelven como `effects` para que las ejecute el orquestador.
 */
export function handle(state: UserState, input: IncomingInput, ctx: FlowContext): HandleResult {
  const value = input.value.slice(0, MAX_INPUT_LENGTH);
  const hasConsent = state.consentAt !== null;

  // Comandos globales
  if (input.kind === 'text') {
    const cmd = normalizeText(value);
    if (cmd === 'hola' || cmd === 'reiniciar') {
      return hasConsent ? resume(state, ctx) : goTo(state, 'WELCOME', ctx);
    }
    if (cmd === 'menu' && hasConsent) return resume(state, ctx);
  }
  // Botón "Menú" de mensajes antiguos
  if (input.kind === 'button' && value === 'menu' && hasConsent) return resume(state, ctx);

  const step = dispatchStep(state, { ...input, value }, ctx);
  if (step === undefined) return goTo(state, hasConsent ? 'MAIN_MENU' : 'WELCOME', ctx);
  if (step) return { ...step, newState: { ...step.newState, invalidInputCount: 0 } };

  // Entrada inesperada
  const count = state.invalidInputCount + 1;
  const invalid = { type: 'invalid_input' as const, payload: { step: state.step, kind: input.kind } };
  if (count >= MAX_INVALID_IN_A_ROW) {
    return goTo(state, hasConsent ? 'MAIN_MENU' : 'WELCOME', ctx, {
      outgoing: [text(messages.notUnderstood)],
      events: [invalid],
    });
  }
  return {
    newState: { ...state, invalidInputCount: count },
    outgoing: [text(messages.notUnderstood), ...stepPrompt(state, ctx)],
    events: [invalid],
    effects: [],
  };
}

// ---------- ciclo de vida del pago (lo invoca el orquestador) ----------

export function onPaymentLinkCreated(
  state: UserState,
  link: { orderId: string; url: string },
  ctx: FlowContext,
): HandleResult {
  const next: UserState = {
    ...state,
    step: 'CHECKOUT',
    stepData: { ...state.stepData, orderId: link.orderId, paymentUrl: link.url },
  };
  return { newState: next, outgoing: stepPrompt(next, ctx), events: [], effects: [] };
}

export function onPaymentFailed(state: UserState, ctx: FlowContext): HandleResult {
  return goTo(state, 'PRODUCT_DETAIL', ctx, { outgoing: [text(messages.paymentFailed)] });
}

export function onPaymentPending(state: UserState): HandleResult {
  return { newState: state, outgoing: [text(messages.paymentPending)], events: [], effects: [] };
}

export function onPaymentApproved(state: UserState, productId: string, ctx: FlowContext): HandleResult {
  const product = findProduct(productId);
  const { state: staged, effects } = advanceStage(
    { ...state, stepData: { ...state.stepData, productId } },
    'customer',
    { wa_last_product: product?.name ?? productId },
  );
  return goTo(staged, 'DELIVERED', ctx, {
    events: [
      { type: 'payment_approved', payload: { product: productId } },
      { type: 'product_delivered', payload: { product: productId } },
    ],
    effects,
  });
}

export function onPaymentClosed(
  state: UserState,
  status: 'expired' | 'canceled',
  ctx: FlowContext,
): HandleResult {
  const notice = text(status === 'expired' ? messages.paymentExpired : messages.paymentCanceled);
  const events =
    status === 'expired'
      ? [{ type: 'payment_expired' as const, payload: { product: state.stepData.productId ?? null } }]
      : [];
  if (state.step === 'CHECKOUT') return goTo(state, 'PRODUCT_DETAIL', ctx, { outgoing: [notice], events });
  return { newState: state, outgoing: [notice], events, effects: [] };
}
