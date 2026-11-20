import type { OutgoingMessage } from '../../flow/types.js';
import type { Channel } from '../Channel.js';

/** Imprime los mensajes en la terminal y recuerda las opciones para poder elegirlas por número. */
export class ConsoleChannel implements Channel {
  private options: { id: string; kind: 'button' | 'list'; title: string }[] = [];

  async send(_waId: string, messages: OutgoingMessage[]): Promise<void> {
    for (const m of messages) {
      console.log(`\n🤖 ${m.body.replace(/\n/g, '\n   ')}`);
      if (m.type === 'buttons') {
        this.options = m.buttons.map((b) => ({ id: b.id, kind: 'button', title: b.title }));
        this.options.forEach((o, i) => console.log(`   [${i + 1}] ${o.title}`));
      } else if (m.type === 'list') {
        this.options = m.rows.map((r) => ({ id: r.id, kind: 'list', title: r.title }));
        m.rows.forEach((r, i) => console.log(`   [${i + 1}] ${r.title}${r.description ? ` — ${r.description}` : ''}`));
      }
    }
  }

  /** Convierte lo tecleado en una entrada: número o título de opción → botón/lista; si no, texto. */
  resolveInput(line: string): { kind: 'text' | 'button' | 'list'; value: string } {
    const trimmed = line.trim();
    const byNumber = /^\d+$/.test(trimmed) ? this.options[Number(trimmed) - 1] : undefined;
    const byTitle = this.options.find((o) => o.title.toLowerCase() === trimmed.toLowerCase());
    const opt = byNumber ?? byTitle;
    return opt ? { kind: opt.kind, value: opt.id } : { kind: 'text', value: line };
  }
}
