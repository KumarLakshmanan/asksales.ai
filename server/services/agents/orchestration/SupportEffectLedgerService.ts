import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db } from '../../../models/db.js';
import { supportEffectLedgerTable } from '../../../models/supportOrchestration/schema.js';
import { sealSupportTurn } from './SupportConversationTurn.js';
import { checkpointSupportCommit } from './SupportCommitCheckpoint.js';

export interface EffectIdentity {
  userId: number;
  conversationId: number;
  channel: string;
  inboundProviderMessageId?: string;
  inboundMessageId?: number;
  effectType: string;
  version?: number;
}

export function buildSupportEffectKey(identity: EffectIdentity): string {
  const inboundIdentity = identity.inboundProviderMessageId
    || (identity.inboundMessageId ? `local:${identity.inboundMessageId}` : 'missing');
  const stable = JSON.stringify({
    userId: identity.userId,
    conversationId: identity.conversationId,
    channel: identity.channel,
    inboundIdentity,
    effectType: identity.effectType,
    version: identity.version || 1,
  });
  return `support-effect:v1:${crypto.createHash('sha256').update(stable).digest('hex')}`;
}

export class SupportEffectLedgerService {
  async runOnce(identity: EffectIdentity, effect: () => Promise<void>): Promise<'executed' | 'duplicate'> {
    await checkpointSupportCommit();
    await sealSupportTurn();
    if (!identity.inboundProviderMessageId && !identity.inboundMessageId) {
      throw new Error('A stable inbound identity is required for support effects.');
    }
    const key = buildSupportEffectKey(identity);
    let [claimed] = await db.insert(supportEffectLedgerTable).values({
      userId: identity.userId,
      conversationId: identity.conversationId,
      effectKey: key,
      effectType: identity.effectType,
      status: 'running',
    }).onConflictDoNothing({ target: supportEffectLedgerTable.effectKey }).returning();

    if (!claimed) {
      const status = await this.getStatus(identity);
      if (status === 'success') return 'duplicate';
      if (status === 'retry_ready') [claimed] = await db.update(supportEffectLedgerTable).set({ status: 'running', updatedAt: new Date() })
        .where(and(eq(supportEffectLedgerTable.userId, identity.userId), eq(supportEffectLedgerTable.effectKey, key), eq(supportEffectLedgerTable.status, 'retry_ready'))).returning();
      if (!claimed) throw new Error('The existing support effect requires reconciliation before it can be committed.');
    }

    try {
      await effect();
      await db.update(supportEffectLedgerTable).set({
        status: 'success',
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(supportEffectLedgerTable.id, claimed.id),
        eq(supportEffectLedgerTable.status, 'running'),
      ));
      return 'executed';
    } catch (error) {
      await db.update(supportEffectLedgerTable).set({
        status: 'reconciliation_required',
        lastError: error instanceof Error ? error.message.slice(0, 2000) : 'Unknown support effect failure',
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(supportEffectLedgerTable.id, claimed.id));
      throw error;
    }
  }

  async getStatus(identity: EffectIdentity): Promise<string | null> {
    const key = buildSupportEffectKey(identity);
    const [row] = await db.select({ status: supportEffectLedgerTable.status })
      .from(supportEffectLedgerTable)
      .where(and(
        eq(supportEffectLedgerTable.userId, identity.userId),
        eq(supportEffectLedgerTable.effectKey, key),
      ))
      .limit(1);
    return row?.status || null;
  }
}

export const supportEffectLedgerService = new SupportEffectLedgerService();
