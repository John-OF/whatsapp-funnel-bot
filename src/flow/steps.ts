import { buttons, CONSENT_VERSION, menuOptions, messages } from '../content/messages.js';
import { diagnosticQuestions } from '../content/diagnostic.js';
import { resourceTopics } from '../content/resources.js';
import { findProduct, products } from '../content/products.js';
import { formatPrice, isValidEmail } from '../lib/text.js';
import {
  FUNNEL_STAGES,
  type DomainEvent,
  type Effect,
  type FlowContext,
  type FunnelStage,
  type HandleResult,
  type IncomingInput,
  type OutgoingMessage,
  type StepId,
  type UserState,
} from './types.js';

const MAX_EMAIL_ATTEMPTS = 3;

interface EnterResult {
  state?: UserState;
  events?: DomainEvent[];
  effects?: Effect[];
}

interface StepDef {
  /** Mensajes que presentan el paso (también se usan para reenviar el prompt). */
  prompt(state: UserState, ctx: FlowContext): OutgoingMessage[];
  /** Efectos secundarios al entrar al paso (eventos, efectos). No se ejecutan al reenviar el prompt. */
  enter?(state: UserState, ctx: FlowContext): EnterResult;
  /** Devuelve `null` si la entrada no corresponde al paso (entrada inesperada). */
  handle(state: UserState, input: IncomingInput, ctx: FlowContext): HandleResult | null;
}

type Extra = Partial<Pick<HandleResult, 'outgoing' | 'events' | 'effects'>>;

// ---------- helpers ----------

export function stepPrompt(state: UserState, ctx: FlowContext): OutgoingMessage[] {
  return getStep(state.step)?.prompt(state, ctx) ?? [];
}

/** `undefined` si el paso no existe, `null` si la entrada no corresponde al paso. */
export function dispatchStep(
  state: UserState,
  input: IncomingInput,
  ctx: FlowContext,
): HandleResult | null | undefined {
  return getStep(state.step)?.handle(state, input, ctx);
}

export function goTo(state: UserState, step: StepId, ctx: FlowContext, extra: Extra = {}): HandleResult {
  let next: UserState = { ...state, step, invalidInputCount: 0 };
  const entered = getStep(step)?.enter?.(next, ctx);
  if (entered?.state) next = entered.state;
  return {
    newState: next,
    outgoing: [...(extra.outgoing ?? []), ...stepPrompt(next, ctx)],
    events: [...(extra.events ?? []), ...(entered?.events ?? [])],
    effects: [...(extra.effects ?? []), ...(entered?.effects ?? [])],
  };
}

function stay(state: UserState, extra: Extra = {}): HandleResult {
  return { newState: state, outgoing: extra.outgoing ?? [], events: extra.events ?? [], effects: extra.effects ?? [] };
}

const text = (body: string): OutgoingMessage => ({ type: 'text', body });

const stageRank = (s: FunnelStage) => FUNNEL_STAGES.indexOf(s);

/** Sube la etapa del embudo solo hacia adelante; emite `syncCrm` si cambia o hay datos extra. */
export function advanceStage(
  state: UserState,
  stage: FunnelStage,
  extra?: Record<string, string | number>,
): { state: UserState; effects: Effect[] } {
  const current = state.stepData.stage;
  const next = current && stageRank(current) >= stageRank(stage) ? current : stage;
  if (next === current && !extra) return { state, effects: [] };
  return {
    state: { ...state, stepData: { ...state.stepData, stage: next } },
    effects: [{ type: 'syncCrm', stage: next, ...(extra ? { extra } : {}) }],
  };
}

export function buildBookingUrl(base: string, name: string | null, email: string | null): string {
  try {
    const url = new URL(base);
    if (name) url.searchParams.set('name', name);
    if (email) url.searchParams.set('email', email);
    return url.toString();
  } catch {
    return base;
  }
}

/** Pasos que necesitan el email: si falta (se omitió al inicio), se pide y luego se retoma la acción. */
function requireEmailThen(
  state: UserState,
  target: 'booking' | 'checkout',
  ctx: FlowContext,
): HandleResult {
  if (state.email) return goTo(state, target === 'booking' ? 'BOOKING' : 'CHECKOUT', ctx);
  return goTo(
    { ...state, stepData: { ...state.stepData, returnTo: target, emailAttempts: 0 } },
    'ASK_EMAIL',
    ctx,
  );
}

const isButton = (i: IncomingInput, id: string) => i.kind === 'button' && i.value === id;
const isList = (i: IncomingInput, id: string) => i.kind === 'list' && i.value === id;

// ---------- pasos ----------

const WELCOME: StepDef = {
  prompt: (_s, ctx) => [
    { type: 'buttons', body: messages.welcome(ctx.links), buttons: [{ id: 'start', title: buttons.start }] },
  ],
  enter: (s) =>
    s.stepData.started
      ? {}
      : {
          state: { ...s, stepData: { ...s.stepData, started: true } },
          events: [{ type: 'conversation_started', payload: {} }],
        },
  handle: (s, i, ctx) => (isButton(i, 'start') ? goTo(s, 'CONSENT', ctx) : null),
};

const CONSENT: StepDef = {
  prompt: (_s, ctx) => [
    {
      type: 'buttons',
      body: messages.consent(ctx.links),
      buttons: [
        { id: 'consent_yes', title: buttons.consentYes },
        { id: 'consent_no', title: buttons.consentNo },
      ],
    },
  ],
  handle: (s, i, ctx) => {
    if (isButton(i, 'consent_yes')) {
      const next: UserState = { ...s, consentAt: ctx.now.toISOString(), consentVersion: CONSENT_VERSION };
      return goTo(next, 'ASK_NAME', ctx, {
        events: [{ type: 'consent_accepted', payload: { version: CONSENT_VERSION } }],
      });
    }
    if (isButton(i, 'consent_no')) {
      return goTo(s, 'CONSENT_REJECTED', ctx, { events: [{ type: 'consent_rejected', payload: {} }] });
    }
    return null;
  },
};

const CONSENT_REJECTED: StepDef = {
  prompt: () => [text(messages.consentRejected)],
  // Cualquier mensaje reenvía la despedida; solo "hola" reinicia (comando global).
  handle: (s, _i, ctx) => goTo(s, 'CONSENT_REJECTED', ctx),
};

const ASK_NAME: StepDef = {
  prompt: () => [text(messages.askName)],
  handle: (s, i, ctx) => {
    if (i.kind !== 'text') return null;
    const name = i.value.trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 40) {
      return stay(s, {
        outgoing: [text(messages.nameInvalid)],
        events: [{ type: 'invalid_input', payload: { step: s.step, reason: 'name' } }],
      });
    }
    return goTo({ ...s, name }, 'ASK_EMAIL', ctx);
  },
};

const ASK_EMAIL: StepDef = {
  prompt: (s) => [text(s.stepData.returnTo ? messages.emailNeeded : messages.askEmail(s.name ?? ''))],
  handle: (s, i, ctx) => {
    if (i.kind !== 'text') return null;
    const email = i.value.trim().toLowerCase();
    const { returnTo, ...restData } = s.stepData;

    if (isValidEmail(email)) {
      const { state: withStage, effects } = advanceStage(
        { ...s, email, stepData: { ...restData, emailAttempts: 0, emailPending: false } },
        'lead',
      );
      const extra: Extra = { events: [{ type: 'lead_captured', payload: {} }], effects };
      if (returnTo === 'booking') return goTo(withStage, 'BOOKING', ctx, extra);
      if (returnTo === 'checkout') return goTo(withStage, 'CHECKOUT', ctx, extra);
      return goTo(withStage, 'DIAGNOSTIC_Q1', ctx, { ...extra, outgoing: [text(messages.diagnosticIntro)] });
    }

    const attempts = (s.stepData.emailAttempts ?? 0) + 1;
    const invalid: DomainEvent = { type: 'invalid_input', payload: { step: s.step, reason: 'email', attempts } };
    if (attempts < MAX_EMAIL_ATTEMPTS) {
      return stay({ ...s, stepData: { ...s.stepData, emailAttempts: attempts } }, {
        outgoing: [text(messages.emailInvalid)],
        events: [invalid],
      });
    }
    // Tercer intento fallido: se sigue sin email y se vuelve a pedir cuando haga falta.
    const given: UserState = { ...s, stepData: { ...restData, emailAttempts: 0, emailPending: true } };
    const extra: Extra = { events: [invalid], outgoing: [text(messages.emailGiveUp)] };
    if (returnTo) return goTo(given, 'MAIN_MENU', ctx, extra);
    return goTo(given, 'DIAGNOSTIC_Q1', ctx, {
      ...extra,
      outgoing: [...extra.outgoing!, text(messages.diagnosticIntro)],
    });
  },
};

export const diagnosticStepId = (n: number): StepId => `DIAGNOSTIC_Q${n}`;

function diagnosticIndex(step: string): number | null {
  const m = /^DIAGNOSTIC_Q(\d+)$/.exec(step);
  return m ? Number(m[1]) : null;
}

const DIAGNOSTIC: StepDef = {
  prompt: (s) => {
    const n = diagnosticIndex(s.step) ?? 1;
    const q = diagnosticQuestions[n - 1];
    if (!q) return [];
    return [
      {
        type: 'buttons',
        body: messages.diagnosticQuestion(n, diagnosticQuestions.length, q.text),
        buttons: [
          { id: 'yes', title: buttons.yes },
          { id: 'no', title: buttons.no },
        ],
      },
    ];
  },
  handle: (s, i, ctx) => {
    const n = diagnosticIndex(s.step);
    if (n === null || (!isButton(i, 'yes') && !isButton(i, 'no'))) return null;
    const yes = i.value === 'yes';
    const answers = [...s.diagnosticAnswers.slice(0, n - 1), yes];
    const answered: DomainEvent = { type: 'diagnostic_answered', payload: { question: n, answer: yes } };
    const withAnswers: UserState = { ...s, diagnosticAnswers: answers };

    if (n < diagnosticQuestions.length) {
      return goTo(withAnswers, diagnosticStepId(n + 1), ctx, { events: [answered] });
    }
    const score = answers.filter(Boolean).length;
    const { state, effects } = advanceStage({ ...withAnswers, diagnosticScore: score }, 'diagnostic_done', {
      wa_diagnostic_score: score,
    });
    return goTo(state, 'MAIN_MENU', ctx, {
      events: [answered, { type: 'diagnostic_completed', payload: { score } }],
      effects,
    });
  },
};

const MAIN_MENU: StepDef = {
  prompt: (s) => [
    {
      type: 'list',
      body: messages.menuBody(s.name, s.diagnosticScore, diagnosticQuestions.length),
      buttonLabel: messages.menuButton,
      rows: [
        { id: 'menu_learn', ...menuOptions.learn },
        { id: 'menu_products', ...menuOptions.products },
        { id: 'menu_booking', ...menuOptions.booking },
      ],
    },
  ],
  enter: () => ({ events: [{ type: 'menu_opened', payload: {} }] }),
  handle: (s, i, ctx) => {
    if (isList(i, 'menu_learn')) return goTo(s, 'RESOURCES', ctx);
    if (isList(i, 'menu_products')) return goTo(s, 'PRODUCTS', ctx);
    if (isList(i, 'menu_booking')) return requireEmailThen(s, 'booking', ctx);
    return null;
  },
};

const RESOURCES: StepDef = {
  prompt: () => [
    {
      type: 'list',
      body: messages.resourcesBody,
      buttonLabel: messages.resourcesButton,
      rows: resourceTopics.map((t) => ({ id: `res:${t.id}`, title: t.title, description: t.description })),
    },
  ],
  handle: (s, i, ctx) => {
    if (i.kind !== 'list' || !i.value.startsWith('res:')) return null;
    const topic = resourceTopics.find((t) => t.id === i.value.slice(4));
    if (!topic) return null;
    const { state, effects } = advanceStage(
      { ...s, stepData: { ...s.stepData, resourceId: topic.id } },
      'resource_viewed',
    );
    return goTo(state, 'RESOURCE_SENT', ctx, {
      events: [{ type: 'resource_viewed', payload: { topic: topic.id } }],
      effects,
    });
  },
};

const RESOURCE_SENT: StepDef = {
  prompt: (s, ctx) => {
    const topic = resourceTopics.find((t) => t.id === s.stepData.resourceId);
    if (!topic) return RESOURCES.prompt(s, ctx);
    return [
      {
        type: 'buttons',
        body: messages.resourceSent(topic.title, topic.links),
        buttons: [
          { id: 'other_topic', title: buttons.otherTopic },
          { id: 'see_products', title: buttons.seeProducts },
          { id: 'menu', title: buttons.menu },
        ],
      },
    ];
  },
  handle: (s, i, ctx) => {
    if (isButton(i, 'other_topic')) return goTo(s, 'RESOURCES', ctx);
    if (isButton(i, 'see_products')) return goTo(s, 'PRODUCTS', ctx);
    if (isButton(i, 'menu')) return goTo(s, 'MAIN_MENU', ctx);
    return null;
  },
};

const PRODUCTS: StepDef = {
  prompt: () => [
    {
      type: 'list',
      body: messages.productsBody,
      buttonLabel: messages.productsButton,
      rows: products.map((p) => ({
        id: `prod:${p.id}`,
        title: p.name,
        description: `${formatPrice(p.priceCents)} · ${p.shortDescription}`,
      })),
    },
  ],
  handle: (s, i, ctx) => {
    if (i.kind !== 'list' || !i.value.startsWith('prod:')) return null;
    const product = findProduct(i.value.slice(5));
    if (!product) return null;
    return goTo({ ...s, stepData: { ...s.stepData, productId: product.id } }, 'PRODUCT_DETAIL', ctx, {
      events: [{ type: 'product_viewed', payload: { product: product.id } }],
    });
  },
};

const PRODUCT_DETAIL: StepDef = {
  prompt: (s, ctx) => {
    const product = s.stepData.productId ? findProduct(s.stepData.productId) : undefined;
    if (!product) return PRODUCTS.prompt(s, ctx);
    return [
      {
        type: 'buttons',
        body: messages.productDetail(product.name, product.description, formatPrice(product.priceCents)),
        buttons: [
          { id: 'buy', title: buttons.buy },
          { id: 'see_others', title: buttons.seeOthers },
          { id: 'menu', title: buttons.menu },
        ],
      },
    ];
  },
  handle: (s, i, ctx) => {
    if (isButton(i, 'buy') && s.stepData.productId && findProduct(s.stepData.productId)) {
      return requireEmailThen(s, 'checkout', ctx);
    }
    if (isButton(i, 'see_others')) return goTo(s, 'PRODUCTS', ctx);
    if (isButton(i, 'menu')) return goTo(s, 'MAIN_MENU', ctx);
    return null;
  },
};

const CHECKOUT: StepDef = {
  prompt: (s) => {
    const product = s.stepData.productId ? findProduct(s.stepData.productId) : undefined;
    // Sin enlace todavía, el orquestador lo enviará al crear el pago.
    if (!product || !s.stepData.paymentUrl) return [];
    return [
      {
        type: 'buttons',
        body: messages.checkoutLink(product.name, formatPrice(product.priceCents), s.stepData.paymentUrl),
        buttons: [{ id: 'paid', title: buttons.paid }],
      },
    ];
  },
  enter: (s) => {
    const productId = s.stepData.productId!;
    const { orderId: _o, paymentUrl: _u, ...rest } = s.stepData;
    const { state, effects } = advanceStage({ ...s, stepData: rest }, 'checkout_started');
    return {
      state,
      events: [{ type: 'checkout_started', payload: { product: productId } }],
      effects: [{ type: 'createPayment', productId }, ...effects],
    };
  },
  handle: (s, i) => (isButton(i, 'paid') ? stay(s, { effects: [{ type: 'checkPayment' }] }) : null),
};

const DELIVERED: StepDef = {
  prompt: (s) => {
    const product = s.stepData.productId ? findProduct(s.stepData.productId) : undefined;
    if (!product) return [];
    return [
      {
        type: 'buttons',
        body: messages.delivered(s.name ?? '', product.name, product.deliveryUrl),
        buttons: [
          { id: 'booking', title: buttons.bookSession },
          { id: 'menu', title: buttons.menu },
        ],
      },
    ];
  },
  handle: (s, i, ctx) => {
    if (isButton(i, 'booking')) return requireEmailThen(s, 'booking', ctx);
    if (isButton(i, 'menu')) return goTo(s, 'MAIN_MENU', ctx);
    return null;
  },
};

const BOOKING: StepDef = {
  prompt: (s, ctx) => [
    {
      type: 'buttons',
      body: messages.booking(buildBookingUrl(ctx.links.bookingUrl, s.name, s.email)),
      buttons: [{ id: 'menu', title: buttons.menu }],
    },
  ],
  enter: (s) => {
    const { state, effects } = advanceStage(s, 'booking_link_sent');
    return { state, events: [{ type: 'booking_link_sent', payload: {} }], effects };
  },
  handle: (s, i, ctx) => (isButton(i, 'menu') ? goTo(s, 'MAIN_MENU', ctx) : null),
};

const STEPS: Record<string, StepDef> = {
  WELCOME,
  CONSENT,
  CONSENT_REJECTED,
  ASK_NAME,
  ASK_EMAIL,
  MAIN_MENU,
  RESOURCES,
  RESOURCE_SENT,
  PRODUCTS,
  PRODUCT_DETAIL,
  CHECKOUT,
  DELIVERED,
  BOOKING,
};

function getStep(step: string): StepDef | undefined {
  const n = diagnosticIndex(step);
  if (n !== null) return n >= 1 && n <= diagnosticQuestions.length ? DIAGNOSTIC : undefined;
  return STEPS[step];
}
