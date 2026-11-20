import type { User } from '@prisma/client';
import type { CrmProvider } from './CrmProvider.js';

export class NoopCrmProvider implements CrmProvider {
  async upsertContact(user: User): Promise<{ contactId: string }> {
    return { contactId: `noop-${user.id}` };
  }

  async updateStage(): Promise<void> {}
}
