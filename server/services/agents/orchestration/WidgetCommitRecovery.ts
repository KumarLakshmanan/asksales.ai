import { randomUUID } from 'node:crypto';
import { currentSupportTurn, supportOwnershipSnapshot, type SupportTurnIdentity } from './SupportConversationTurn.js';
import { sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import { agentRouter } from '../AgentRouter.js';
import type { AgentResult } from '../BaseOutreachAgent.js';
import { decryptRestrictedPayload, encryptRestrictedPayload, type RestrictedPayload } from './PrivacyVaultService.js';
import { withSupportCommitCheckpoint } from './SupportCommitCheckpoint.js';
import { assistantDeliveryCurrent, assistantProvenanceCurrent, withPublishedAssistant } from '../../assistants/AssistantFreshness.js';
import type { AssistantProvenance } from '../../../../shared/outreachAssistants.js';

interface WidgetCommit { sessionId: number; userMessageIds: number[]; inboundId: string; decision: AgentResult | null; assistantProvenance?: AssistantProvenance; ownership: string; supportTurn?: SupportTurnIdentity }
export function widgetCommitEnvelope(userId: number, value: WidgetCommit) {
  return encryptRestrictedPayload(userId, 'widget-commit', value);
}

/** The reply and encrypted commit envelope are saved together. Recovery never
 * regenerates the answer or repeats an uncertain effect. */
export async function finishWidgetCommit(userId: number, messageId: number): Promise<boolean> {
  const commitToken = randomUUID();
  const claimed = await db.execute(sql`UPDATE support_chat_messages m SET processing_expires_at=NOW()+INTERVAL '2 minutes',commit_token=${commitToken}::uuid
    FROM support_chat_sessions s,team_members t WHERE m.id=${messageId} AND m.session_id=s.id AND s.member_id=t.id AND t.user_id=${userId}
      AND m.role='assistant' AND m.processing_status='committing'
      AND (m.processing_expires_at IS NULL OR m.processing_expires_at<NOW())
    RETURNING m.session_id,m.deferred_commit,s.automation_mode`);
  const row = claimed.rows[0];
  if (!row) return false;
  let lease: { scopeKey: string; token: string } | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let leaseLost = false;
  let commitHeartbeat: ReturnType<typeof setInterval> | undefined;
  let commitMessages: number[] = [];
  try {
    const commit = decryptRestrictedPayload<WidgetCommit>(userId, 'widget-commit', row.deferred_commit as RestrictedPayload);
    // Committing deferred effects consumes deferredEffectContext on the result.
    // Keep the original assignment for every subsequent delivery-time check.
    const assistantProvenance = commit.decision?.deferredEffectContext?.assistantProvenance ?? commit.assistantProvenance;
    if (!await assistantProvenanceCurrent(assistantProvenance)) {
      await db.execute(sql`UPDATE support_chat_messages SET processing_status='superseded',deferred_commit=NULL,processing_expires_at=NULL,commit_token=NULL
        WHERE id=${messageId} AND commit_token=${commitToken}::uuid`);
      return false;
    }
    if (commit.decision && commit.ownership !== await supportOwnershipSnapshot(userId, -commit.sessionId, 'web')) throw new Error('Conversation ownership changed before widget commit.');
    // The gateway may authorize a factual response during a human-owned
    // ticket. Its encrypted decision explicitly suppresses business effects.
    if (commit.decision && row.automation_mode !== 'ai_active'
      && commit.decision.deferredEffectContext?.suppressBusinessEffects !== true) throw new Error('Conversation ownership changed before widget commit.');
    if (commit.sessionId !== Number(row.session_id) || !commit.userMessageIds.length
      || (commit.decision && (commit.decision.deferredEffectContext?.userId !== userId
        || commit.decision.deferredEffectContext.conversationId !== -commit.sessionId))) throw new Error('Widget commit scope mismatch.');
    if (commit.supportTurn && currentSupportTurn()?.id !== commit.supportTurn.id) {
      const token = randomUUID();
      const claimedTurn = await db.execute(sql`UPDATE support_conversation_turns s SET lease_token=${token}::uuid,lease_expires_at=NOW()+INTERVAL '90 seconds'
        WHERE s.scope_key=${commit.supportTurn.scopeKey} AND s.user_id=${userId} AND s.conversation_id=${-commit.sessionId} AND s.channel='web'
          AND (s.lease_expires_at IS NULL OR s.lease_expires_at<NOW())
          AND EXISTS(SELECT 1 FROM support_conversation_turn_runs r WHERE r.id=${commit.supportTurn.id}::uuid AND r.scope_key=s.scope_key
            AND r.last_revision=${commit.supportTurn.revision} AND r.status IN ('dispatching','uncertain','completed')) RETURNING s.scope_key`);
      if (!claimedTurn.rows.length) {
        await db.execute(sql`UPDATE support_chat_messages SET processing_expires_at=NULL,commit_token=NULL
          WHERE id=${messageId} AND processing_status='committing' AND commit_token=${commitToken}::uuid`);
        return false;
      }
      lease = { scopeKey: commit.supportTurn.scopeKey, token };
      heartbeat = setInterval(async () => {
        try {
          const renewed = await db.execute(sql`UPDATE support_conversation_turns SET lease_expires_at=NOW()+INTERVAL '90 seconds'
            WHERE scope_key=${lease!.scopeKey} AND lease_token=${token}::uuid AND lease_expires_at>NOW() RETURNING scope_key`);
          if (!renewed.rows.length) leaseLost = true;
        } catch { leaseLost = true; }
      }, 20_000);
      heartbeat.unref();
    }
    commitMessages = commit.userMessageIds;
    for (const id of commitMessages) await db.execute(sql`UPDATE support_chat_messages SET processing_status='committing'
      WHERE id=${id} AND session_id=${commit.sessionId} AND role='user' AND processing_status<>'completed'`);
    const checkpoint = async () => {
      if (!await assistantDeliveryCurrent(assistantProvenance,commit.decision?.provenance)) throw new Error('Assistant assignment or availability changed before widget delivery.');
      if (leaseLost) throw new Error('Widget recovery ownership expired.');
      const owned = await db.execute(sql`UPDATE support_chat_messages SET processing_expires_at=NOW()+INTERVAL '2 minutes'
        WHERE id=${messageId} AND commit_token=${commitToken}::uuid AND processing_status='committing' AND processing_expires_at>NOW() RETURNING id`);
      if (!owned.rows.length) { leaseLost = true; throw new Error('Widget reply ownership expired.'); }
      if (lease) {
        const turn = await db.execute(sql`SELECT scope_key FROM support_conversation_turns WHERE scope_key=${lease.scopeKey}
          AND lease_token=${lease.token}::uuid AND lease_expires_at>NOW()`);
        if (!turn.rows.length) { leaseLost = true; throw new Error('Widget recovery ownership expired.'); }
      }
    };
    commitHeartbeat = setInterval(() => { void checkpoint().catch(() => { leaseLost = true; }); }, 20_000);
    commitHeartbeat.unref();
    await withPublishedAssistant(assistantProvenance,()=>withSupportCommitCheckpoint(checkpoint, async () => {
      await checkpoint();
      if (commit.decision?.verifiedMedia?.length) {
        const { supportMediaDeliveryService } = await import('../../supportMedia/SupportMediaDeliveryService.js');
        await supportMediaDeliveryService.recordDeferredAcknowledgement({ userId, conversationId: -commit.sessionId,
          channel: 'web', inboundId: commit.inboundId, providerMessageId: String(messageId), media: commit.decision.verifiedMedia });
      }
      await checkpoint();
      if (commit.decision) await agentRouter.commitDeferredDelivery(commit.decision);
      await checkpoint();
    }));
    await db.transaction(async (tx: typeof db) => {
      if (!await assistantDeliveryCurrent(assistantProvenance,commit.decision?.provenance,tx,true)) {
        throw new Error('Assistant assignment or availability changed before widget delivery.');
      }
      const ownedReply = await tx.execute(sql`SELECT id FROM support_chat_messages WHERE id=${messageId}
        AND commit_token=${commitToken}::uuid AND processing_status='committing' AND processing_expires_at>NOW() FOR UPDATE`);
      if (!ownedReply.rows.length || leaseLost) throw new Error('Widget reply ownership expired.');
      if (lease && commit.supportTurn) {
        const owned = await tx.execute(sql`SELECT scope_key FROM support_conversation_turns WHERE scope_key=${lease.scopeKey}
          AND lease_token=${lease.token}::uuid AND lease_expires_at>NOW() FOR UPDATE`);
        if (leaseLost || !owned.rows.length) throw new Error('Widget recovery ownership expired.');
        await tx.execute(sql`UPDATE support_conversation_turn_runs SET status='completed',updated_at=NOW() WHERE id=${commit.supportTurn.id}::uuid`);
        await tx.execute(sql`UPDATE support_conversation_turns SET consumed_revision=GREATEST(consumed_revision,${commit.supportTurn.revision}),updated_at=NOW()
          WHERE scope_key=${lease.scopeKey} AND lease_token=${lease.token}::uuid`);
      }
      await tx.execute(sql`UPDATE support_chat_messages SET processing_status='completed',processing_expires_at=NULL,deferred_commit=NULL,commit_token=NULL
        WHERE id=${messageId} AND session_id=${commit.sessionId} AND processing_status='committing'`);
      for (const id of commit.userMessageIds) await tx.execute(sql`UPDATE support_chat_messages
        SET processing_status='completed',processing_expires_at=NULL WHERE id=${id} AND session_id=${commit.sessionId} AND role='user'`);
    });
    if (commit.decision?.provenance?.assistantAway) await (await import('../../assistants/AssistantAvailability.js')).confirmAssistantAwayMessage(commit.decision.provenance);
    return true;
  } catch (error) {
    const owned = await db.execute(sql`UPDATE support_chat_messages SET processing_status='reconciliation_required',processing_expires_at=NULL,commit_token=NULL
      WHERE id=${messageId} AND commit_token=${commitToken}::uuid AND processing_status='committing' RETURNING id`);
    if (owned.rows.length) for (const id of commitMessages) await db.execute(sql`UPDATE support_chat_messages
      SET processing_status='reconciliation_required',processing_expires_at=NULL
      WHERE id=${id} AND session_id=${row.session_id} AND role='user' AND processing_status<>'completed'`);
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (commitHeartbeat) clearInterval(commitHeartbeat);
    if (lease) await db.execute(sql`UPDATE support_conversation_turns SET lease_token=NULL,lease_expires_at=NULL
      WHERE scope_key=${lease.scopeKey} AND lease_token=${lease.token}::uuid`);
  }
}

export async function recoverWidgetCommits(limit = 20): Promise<number> {
  const pending = await db.execute(sql`SELECT m.id,t.user_id FROM support_chat_messages m
    JOIN support_chat_sessions s ON s.id=m.session_id JOIN team_members t ON t.id=s.member_id
    WHERE m.role='assistant' AND m.processing_status='committing'
      AND (m.processing_expires_at IS NULL OR m.processing_expires_at<NOW()) ORDER BY m.id LIMIT ${limit}`);
  let completed = 0;
  for (const row of pending.rows) {
    try { if (await finishWidgetCommit(Number(row.user_id), Number(row.id))) completed++; }
    catch { /* The durable reconciliation state is exposed to operators. */ }
  }
  return completed;
}
