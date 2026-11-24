import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response, NextFunction } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { finishWidgetCommit } from '../services/agents/orchestration/WidgetCommitRecovery.js';
import { recordSupportAdminAudit } from '../services/agents/orchestration/SupportAdminAuditService.js';

export async function listConversationRecovery(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = businessOwnerUserId(req);
    const [replies, effects, turns] = await Promise.all([
      db.execute(sql`SELECT m.id,m.session_id AS conversation_id,m.processing_status AS status,m.created_at
        FROM support_chat_messages m JOIN support_chat_sessions s ON s.id=m.session_id JOIN team_members t ON t.id=s.member_id
        WHERE t.user_id=${userId} AND m.role='assistant' AND m.processing_status IN ('committing','reconciliation_required') ORDER BY m.id DESC LIMIT 50`),
      db.execute(sql`SELECT id,conversation_id,effect_type,status,updated_at FROM support_effect_ledger
        WHERE user_id=${userId} AND status IN ('running','reconciliation_required','retry_ready') ORDER BY updated_at DESC LIMIT 50`),
      db.execute(sql`SELECT r.id,s.conversation_id,s.channel,r.status,r.updated_at FROM support_conversation_turn_runs r
        JOIN support_conversation_turns s ON s.scope_key=r.scope_key WHERE s.user_id=${userId}
          AND r.status IN ('dispatching','uncertain') AND (s.lease_expires_at IS NULL OR s.lease_expires_at<NOW()) ORDER BY r.updated_at DESC LIMIT 50`),
    ]);
    return res.json({ replies: replies.rows, effects: effects.rows, turns: turns.rows });
  } catch (error) { next(error); }
}

export async function reconcileConversationRecovery(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = businessOwnerUserId(req);
    const kind = req.params.kind;
    const id = req.params.id;
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    const outcome = req.body.outcome;
    if (note.length < 3 || note.length > 500 || !['reply','effect','turn'].includes(kind)
      || (kind === 'turn' ? !/^[a-f0-9-]{36}$/i.test(id) : !/^[1-9]\d{0,15}$/.test(id))) return res.status(400).json({ error: 'A valid recovery item and verification note are required.' });
    if (kind === 'reply') {
      if (outcome === 'discard') {
        const resolved = await db.transaction(async (tx: typeof db) => {
          const row = (await tx.execute(sql`SELECT m.id,m.session_id,m.metadata,m.request_id FROM support_chat_messages m
            JOIN support_chat_sessions s ON s.id=m.session_id JOIN team_members t ON t.id=s.member_id
            WHERE m.id=${Number(id)} AND t.user_id=${userId} AND m.role='assistant' AND m.processing_status='reconciliation_required' FOR UPDATE OF m`)).rows[0];
          if (!row) return false;
          const busy = await tx.execute(sql`SELECT scope_key FROM support_conversation_turns WHERE user_id=${userId} AND conversation_id=${-Number(row.session_id)} AND lease_expires_at>NOW()`);
          if (busy.rows.length) return false;
          await tx.execute(sql`UPDATE support_chat_messages SET processing_status='cancelled',deferred_commit=NULL,processing_expires_at=NULL,commit_token=NULL WHERE id=${Number(id)}`);
          // Synchronous widget requests have a matching role suffix. Coordinated
          // batches are closed together by the reviewed turn below.
          if (typeof row.request_id === 'string' && row.request_id.endsWith(':assistant')) {
            await tx.execute(sql`UPDATE support_chat_messages SET processing_status='cancelled',processing_expires_at=NULL
              WHERE session_id=${row.session_id} AND role='user' AND request_id=${row.request_id.replace(/:assistant$/, ':user')}`);
          }
          await recordSupportAdminAudit(tx, { userId, actorType: 'owner', actorId: userId, action: 'widget_reply.discard', entityType: 'support_chat_message', entityId: Number(id), metadata: { note } });
          return true;
        });
        return resolved ? res.json({ success: true }) : res.status(409).json({ error: 'The reply is busy or already resolved.' });
      }
      if (outcome !== 'resume') return res.status(400).json({ error: 'Resolve any uncertain effects, then resume this saved reply.' });
      const rows = await db.execute(sql`UPDATE support_chat_messages m SET processing_status='committing',processing_expires_at=NULL
        FROM support_chat_sessions s,team_members t WHERE m.id=${Number(id)} AND m.session_id=s.id AND s.member_id=t.id AND t.user_id=${userId}
          AND m.role='assistant' AND m.processing_status='reconciliation_required' RETURNING m.id`);
      if (!rows.rows.length) return res.status(409).json({ error: 'This reply is already recovering or no longer requires review.' });
      await recordSupportAdminAudit(db, { userId, actorType: 'owner', actorId: userId, action: 'widget_reply.resume', entityType: 'support_chat_message', entityId: Number(id), metadata: { note } });
      if (!await finishWidgetCommit(userId, Number(id))) return res.status(409).json({ error: 'The conversation is busy. The saved reply will be recovered when its lease is available.' });
      return res.json({ success: true });
    }
    const result = await db.transaction(async (tx: typeof db) => {
      if (kind === 'effect') {
        if (!['succeeded','not_executed'].includes(outcome)) return null;
        const row = (await tx.execute(sql`SELECT * FROM support_effect_ledger WHERE id=${Number(id)} AND user_id=${userId} FOR UPDATE`)).rows[0];
        if (!row || !['running','reconciliation_required'].includes(row.status)) return null;
        const busy = await tx.execute(sql`SELECT scope_key FROM support_conversation_turns WHERE user_id=${userId}
          AND conversation_id=${row.conversation_id} AND lease_expires_at>NOW()`);
        if (busy.rows.length || (row.status === 'running' && Date.now() - new Date(row.updated_at).getTime() < 120_000)) return null;
        const status = outcome === 'succeeded' ? 'success' : 'retry_ready';
        await tx.execute(sql`UPDATE support_effect_ledger SET status=${status},last_error=${`Owner review: ${note}`},updated_at=NOW() WHERE id=${Number(id)} AND user_id=${userId}`);
        await recordSupportAdminAudit(tx, { userId, actorType: 'owner', actorId: userId, action: 'effect.reconcile', entityType: 'support_effect', entityId: Number(id), metadata: { outcome, note } });
      } else {
        if (outcome !== 'reviewed') return null;
        const row = (await tx.execute(sql`SELECT r.*,s.conversation_id,s.lease_expires_at FROM support_conversation_turn_runs r
          JOIN support_conversation_turns s ON s.scope_key=r.scope_key WHERE r.id=${id}::uuid AND s.user_id=${userId} FOR UPDATE OF s,r`)).rows[0];
        if (!row || !['uncertain','dispatching'].includes(row.status) || (row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now())) return null;
        // Resolve effects and hidden replies first; releasing a turn must never
        // make those pending commits disappear from the recovery workflow.
        const pending = await tx.execute(sql`SELECT id FROM support_effect_ledger WHERE user_id=${userId} AND conversation_id=${row.conversation_id}
          AND status IN ('running','reconciliation_required','retry_ready') LIMIT 1`);
        const replies = Number(row.conversation_id) < 0 ? await tx.execute(sql`SELECT id FROM support_chat_messages WHERE session_id=${-Number(row.conversation_id)}
          AND role='assistant' AND processing_status IN ('committing','reconciliation_required') LIMIT 1`) : { rows: [] };
        if (pending.rows.length || replies.rows.length) return null;
        await tx.execute(sql`UPDATE support_conversation_turn_runs SET status='reviewed',updated_at=NOW() WHERE id=${id}::uuid`);
        await tx.execute(sql`UPDATE support_conversation_turns SET consumed_revision=GREATEST(consumed_revision,${row.last_revision}),updated_at=NOW() WHERE scope_key=${row.scope_key}`);
        if (Number(row.conversation_id) < 0 && Array.isArray(row.message_ids)) {
          for (const messageId of row.message_ids) await tx.execute(sql`UPDATE support_chat_messages SET processing_status='cancelled',processing_expires_at=NULL
            WHERE session_id=${-Number(row.conversation_id)} AND id=${Number(messageId)} AND role='user' AND processing_status<>'completed'`);
        }
        await recordSupportAdminAudit(tx, { userId, actorType: 'owner', actorId: userId, action: 'conversation_turn.review', entityType: 'support_turn', entityId: id, metadata: { note } });
      }
      return { success: true };
    });
    return result ? res.json(result) : res.status(409).json({ error: 'This item is busy, already resolved, or still has a reply or effect requiring reconciliation.' });
  } catch (error) { next(error); }
}
