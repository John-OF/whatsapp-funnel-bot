import { handle } from '../src/flow/engine.js';
import {
  newUserState,
  type DomainEvent,
  type Effect,
  type FlowContext,
  type IncomingInput,
  type OutgoingMessage,
  type UserState,
} from '../src/flow/types.js';

export const ctx: FlowContext = {
  now: new Date('2026-01-15T12:00:00Z'),
  links: {
    privacyUrl: 'https://example.com/privacidad',
    introVideoUrl: 'https://example.com/video',
    bookingUrl: 'https://cal.com/usuario/sesion',
  },
};

export const text = (value: string): IncomingInput => ({ kind: 'text', value });
export const button = (value: string): IncomingInput => ({ kind: 'button', value });
export const list = (value: string): IncomingInput => ({ kind: 'list', value });

export interface Run {
  state: UserState;
  outgoing: OutgoingMessage[];
  events: DomainEvent[];
  effects: Effect[];
  /** Todos los mensajes emitidos en la sesión, en orden. */
  allOutgoing: OutgoingMessage[];
}

/** Aplica una secuencia de entradas al motor acumulando lo emitido. */
export function run(inputs: IncomingInput[], from: UserState = newUserState('593999000111')): Run {
  let state = from;
  const acc: Run = { state, outgoing: [], events: [], effects: [], allOutgoing: [] };
  for (const input of inputs) {
    const r = handle(state, input, ctx);
    state = r.newState;
    acc.outgoing = r.outgoing;
    acc.events.push(...r.events);
    acc.effects.push(...r.effects);
    acc.allOutgoing.push(...r.outgoing);
  }
  acc.state = state;
  return acc;
}

export const bodyOf = (m: OutgoingMessage | undefined) => m?.body ?? '';

/** Camino hasta el menú principal con datos válidos. */
export const TO_MENU: IncomingInput[] = [
  text('hola'),
  button('start'),
  button('consent_yes'),
  text('Ana'),
  text('ana@example.com'),
  button('yes'),
  button('no'),
  button('yes'),
  button('yes'),
];
