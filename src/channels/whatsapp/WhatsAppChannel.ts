import type { OutgoingMessage } from '../../flow/types.js';
import type { Channel } from '../Channel.js';

export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  graphApiVersion: string;
}

const RETRIES_ON_5XX = 2;

/** Convierte un mensaje independiente del canal al cuerpo de `POST /{phone-number-id}/messages`. */
export function toApiPayload(to: string, m: OutgoingMessage): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  if (m.type === 'text') {
    return { ...base, type: 'text', text: { body: m.body, preview_url: true } };
  }
  if (m.type === 'buttons') {
    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: m.body },
        action: {
          buttons: m.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
        },
      },
    };
  }
  return {
    ...base,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: m.body },
      action: {
        button: m.buttonLabel,
        sections: [
          {
            rows: m.rows.map((r) => ({
              id: r.id,
              title: r.title,
              ...(r.description ? { description: r.description } : {}),
            })),
          },
        ],
      },
    },
  };
}

export class WhatsAppChannel implements Channel {
  constructor(
    private readonly config: WhatsAppConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly retryDelayMs = 500,
  ) {}

  async send(waId: string, messages: OutgoingMessage[]): Promise<void> {
    for (const m of messages) await this.post(toApiPayload(waId, m));
  }

  private async post(payload: Record<string, unknown>): Promise<void> {
    const { token, phoneNumberId, graphApiVersion } = this.config;
    const url = `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= RETRIES_ON_5XX; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
      try {
        const res = await this.fetchFn(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) return;
        const detail = await res.text().catch(() => '');
        lastError = new Error(`WhatsApp API ${res.status}: ${detail.slice(0, 500)}`);
        if (res.status < 500) throw lastError; // errores 4xx no se reintentan
      } catch (err) {
        if (err === lastError) throw err;
        lastError = err as Error; // fallo de red: se reintenta
      }
    }
    throw lastError ?? new Error('WhatsApp API: error desconocido');
  }
}
