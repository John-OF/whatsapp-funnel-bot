import type { User } from '@prisma/client';
import type { FunnelStage } from '../flow/types.js';

export interface CrmProvider {
  upsertContact(user: User): Promise<{ contactId: string }>;
  updateStage(user: User, stage: FunnelStage, extra?: Record<string, string | number>): Promise<void>;
}
