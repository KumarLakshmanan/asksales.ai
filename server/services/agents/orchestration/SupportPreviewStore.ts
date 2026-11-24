import { sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import type { PlaybookGraph, supportPlaybookRunsTable } from '../../../models/supportOrchestration/schema.js';
import { encryptRestrictedPayload, decryptRestrictedPayload } from './PrivacyVaultService.js';

export interface PreviewSnapshot { run: typeof supportPlaybookRunsTable.$inferSelect; graph: PlaybookGraph }
/** Isolated, encrypted, expiring simulation state. Never stored as a customer run. */
export const supportPreviewStore = {
  async load(userId: number, conversationId: number, executor = db): Promise<PreviewSnapshot | null> {
    const result = await executor.execute(sql`SELECT payload FROM support_preview_sessions
      WHERE user_id=${userId} AND conversation_id=${conversationId} AND expires_at>NOW()`);
    const row = result.rows[0] as { payload?: any } | undefined;
    return row?.payload ? decryptRestrictedPayload<PreviewSnapshot>(userId, `preview:${conversationId}`, row.payload) : null;
  },
  async save(userId: number, conversationId: number, snapshot: PreviewSnapshot, executor = db) {
    const encrypted = encryptRestrictedPayload(userId, `preview:${conversationId}`, snapshot);
    await executor.execute(sql`INSERT INTO support_preview_sessions(user_id,conversation_id,payload,expires_at)
      VALUES (${userId},${conversationId},${JSON.stringify(encrypted)}::jsonb,NOW()+INTERVAL '2 hours')
      ON CONFLICT(business_profile_id, user_id,conversation_id) DO UPDATE SET payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at`);
    await executor.execute(sql`DELETE FROM support_preview_sessions WHERE expires_at<NOW()`);
  },
  async commit(userId: number, conversationId: number, outcome: Record<string, unknown>, eventKey: string) {
    await db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId},${conversationId})`);
      const snapshot = await this.load(userId, conversationId, tx as typeof db);
      if (!snapshot || !snapshot.run.state.proposedNodeId || snapshot.run.state.proposedEventKey !== eventKey) return;
      const { proposedNodeId, proposedEventKey, proposedCompleted, correctionPendingTransition: _correction, ...state } = snapshot.run.state;
      snapshot.run.currentNodeId = String(proposedNodeId);
      snapshot.run.status = proposedCompleted ? 'completed' : 'active';
      snapshot.run.state = { ...state, lastEventKey: proposedEventKey,
        capabilityStatus: { ...(state.capabilityStatus as object || {}),
          ...(outcome.capabilityName ? { [String(outcome.capabilityName)]: outcome.capabilityStatus } : {}) },
        groundingStatus: outcome.groundingStatus, deliveryStatus: 'simulated' };
      if (!proposedCompleted) {
        const { committedTerminalNode } = await import('./PlaybookEngine.js');
        const terminal = committedTerminalNode(snapshot.graph, String(proposedNodeId), snapshot.run.state, {
          userId, conversationId, channel: 'internal', inboundText: '',
          agentType: String(state.agentType || ''), groundingStatus: String(outcome.groundingStatus || ''), deliveryStatus: 'simulated',
        });
        if (terminal) { snapshot.run.currentNodeId = terminal.id; snapshot.run.status = 'completed'; }
      }
      await this.save(userId, conversationId, snapshot, tx as typeof db);
    });
  },
};
