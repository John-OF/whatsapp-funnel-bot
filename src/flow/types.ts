export type FunnelStage =
  | 'lead'
  | 'diagnostic_done'
  | 'resource_viewed'
  | 'checkout_started'
  | 'customer'
  | 'booking_link_sent';

export const FUNNEL_STAGES: readonly FunnelStage[] = [
  'lead',
  'diagnostic_done',
  'resource_viewed',
  'checkout_started',
  'customer',
  'booking_link_sent',
];

export type StepId =
  | 'WELCOME'
  | 'CONSENT'
  | 'CONSENT_REJECTED'
  | 'ASK_NAME'
  | 'ASK_EMAIL'
  | `DIAGNOSTIC_Q${number}`
  | 'MAIN_MENU'
  | 'RESOURCES'
  | 'RESOURCE_SENT'
  | 'PRODUCTS'
  | 'PRODUCT_DETAIL'
  | 'CHECKOUT'
  | 'DELIVERED'
  | 'BOOKING';

/** Datos auxiliares del paso actual (se persisten como JSON). */
export interface StepData {
  started?: boolean;
  emailAttempts?: number;
  /** El email no se pudo capturar; se vuelve a pedir cuando haga falta. */
  emailPending?: boolean;
  /** Acción a retomar cuando se capture el email pendiente. */
  returnTo?: 'booking' | 'checkout';
  resourceId?: string;
  productId?: string;
  orderId?: string;
  paymentUrl?: string;
  /** Etapa más avanzada ya sincronizada con el CRM. */
  stage?: FunnelStage;
}

export interface UserState {
  waId: string;
  name: string | null;
  email: string | null;
  consentAt: string | null;
  consentVersion: string | null;
  step: StepId;
  stepData: StepData;
  invalidInputCount: number;
  diagnosticScore: number | null;
  /** Una entrada por pregunta contestada (true = Sí). */
  diagnosticAnswers: boolean[];
}

export interface IncomingInput {
  kind: 'text' | 'button' | 'list' | 'unsupported';
  /** Texto libre, o id del botón / fila de lista. */
  value: string;
}

export interface ButtonOption {
  id: string;
  title: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export type OutgoingMessage =
  | { type: 'text'; body: string }
  | { type: 'buttons'; body: string; buttons: ButtonOption[] }
  | { type: 'list'; body: string; buttonLabel: string; rows: ListRow[] };

export type DomainEventType =
  | 'conversation_started'
  | 'consent_accepted'
  | 'consent_rejected'
  | 'lead_captured'
  | 'diagnostic_answered'
  | 'diagnostic_completed'
  | 'menu_opened'
  | 'resource_viewed'
  | 'product_viewed'
  | 'checkout_started'
  | 'payment_approved'
  | 'payment_expired'
  | 'product_delivered'
  | 'booking_link_sent'
  | 'invalid_input'
  | 'crm_sync_failed';

export interface DomainEvent {
  type: DomainEventType;
  payload: Record<string, unknown>;
}

export type Effect =
  | { type: 'createPayment'; productId: string }
  | { type: 'checkPayment' }
  | {
      type: 'syncCrm';
      stage: FunnelStage;
      extra?: Record<string, string | number>;
    };

export interface HandleResult {
  newState: UserState;
  outgoing: OutgoingMessage[];
  events: DomainEvent[];
  effects: Effect[];
}

export interface FlowLinks {
  privacyUrl: string;
  introVideoUrl: string;
  bookingUrl: string;
}

/** Dependencias externas del motor, inyectadas para mantenerlo puro. */
export interface FlowContext {
  now: Date;
  links: FlowLinks;
}

export function newUserState(waId: string): UserState {
  return {
    waId,
    name: null,
    email: null,
    consentAt: null,
    consentVersion: null,
    step: 'WELCOME',
    stepData: {},
    invalidInputCount: 0,
    diagnosticScore: null,
    diagnosticAnswers: [],
  };
}
