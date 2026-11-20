import type { OutgoingMessage } from '../flow/types.js';

/** Canal de salida: WhatsApp en producción, consola en el simulador. */
export interface Channel {
  send(waId: string, messages: OutgoingMessage[]): Promise<void>;
}
