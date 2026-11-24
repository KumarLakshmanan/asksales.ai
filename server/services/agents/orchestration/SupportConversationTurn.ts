import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import { logger } from '../../../utils/logger.js';

const channels = new Set(['whatsapp', 'instagram', 'facebook', 'web']);
const jobs: Record<string, string> = {
  process_whatsapp_webhook: 'whatsapp', process_instagram_webhook: 'instagram',
  process_facebook_webhook: 'facebook', process_support_widget_turn: 'web',
};
type Executor = Pick<typeof db, 'execute'>;
type Payload = Record<string, any>;
export interface SupportTurnIdentity { scopeKey: string; id: string; revision: number }
interface ActiveTurn extends SupportTurnIdentity {
  userId: number; conversationId: number; channel: string; token: string; sealed: boolean;
  messageIds: number[]; messages: string[]; lostLease: boolean;
  messageVaultIds: Array<number | null>;
  providerMessageId?: string;
  ownership: string;
}
const active = new AsyncLocalStorage<ActiveTurn>();
const retryLease = new AsyncLocalStorage<{ scopeKey: string; token: string }>();
export async function supportOwnershipSnapshot(userId: number, conversationId: number, channel: string, executor: Executor = db): Promise<string> {
  const result = channel === 'web'
    ? await executor.execute(sql`SELECT automation_mode,metadata->'ownershipResolution' AS ownership FROM support_chat_sessions
        WHERE id=${-conversationId}`)
    : await executor.execute(sql`SELECT automation_mode,metadata->'ownershipResolution' AS ownership FROM outreach_conversations
        WHERE id=${conversationId} AND user_id=${userId}`);
  const handoffs = await executor.execute(sql`SELECT id,status,ai_reply_enabled FROM handoff_queue
    WHERE user_id=${userId} AND conversation_id=${conversationId} AND status IN ('waiting','assigned','in_progress') ORDER BY id`);
  return JSON.stringify({ mode: result.rows[0] || null, handoffs: handoffs.rows });
}
async function restoreProposal(tx: Executor, id: string, baseline: any[], userId: number, conversationId: number) {
  // Release the active-run uniqueness slot before restoring a replaced run.
  const retained = `{${baseline.map(previous => Number(previous.id)).join(',')}}`;
  await tx.execute(sql`UPDATE support_playbook_runs SET status='superseded',updated_at=NOW()
    WHERE user_id=${userId} AND conversation_id=${conversationId} AND state->>'coordinatedTurnId'=${id}
      AND id<>ALL(${retained}::bigint[])`);
  for (const previous of baseline) await tx.execute(sql`UPDATE support_playbook_runs SET state=${JSON.stringify(previous.state)}::jsonb,
    current_node_id=${previous.current_node_id},status=${previous.status},updated_at=NOW()
    WHERE id=${Number(previous.id)} AND user_id=${userId} AND conversation_id=${conversationId}
      AND state->>'coordinatedTurnId'=${id}`);
}
export class SupersededSupportTurn extends Error { constructor() { super('Support turn superseded by newer input or ownership.'); } }
export class BusySupportTurn extends Error { constructor() { super('Another worker owns this support conversation.'); } }

/** Empty by default: migrate, test on staging, then enable channels explicitly. */
export function supportConversationTurnsEnabled(channel: string): boolean {
  return channels.has(channel) && (process.env.SUPPORT_CONVERSATION_TURN_CHANNELS || '')
    .split(',').map(value => value.trim()).includes(channel);
}
export function supportTurnScope(userId: number, channel: string, conversationId: number, account = ''): string {
  return createHash('sha256').update(JSON.stringify([userId, channel, account, conversationId])).digest('hex');
}
export function currentSupportTurn() { return active.getStore(); }
/** Internal turn IDs are idempotency keys, never provider reply contexts. */
export function supportTurnProviderReplyId(fallback?: string | null): string | undefined {
  const value = active.getStore()?.providerMessageId || fallback || undefined;
  return value?.startsWith('turn:') ? undefined : value;
}
export function supportTurnDeliveryMetadata(): Record<string, unknown> {
  const turn = active.getStore();
  return turn ? { supportTurn: { scopeKey: turn.scopeKey, id: turn.id, revision: turn.revision } } : {};
}

/** Called before enqueue: database inbox survives Redis/enqueue/process failures. */
export async function registerSupportTurnInput(jobName: string, input: Payload, ready = true): Promise<string | null> {
  const channel = jobs[jobName];
  if (!supportConversationTurnsEnabled(channel)) return null;
  const messageId = Number(input.inboundMessageId || input.widgetMessageId);
  const conversationId = channel === 'web' ? -Number(input.sessionId) : Number(input.conversationId);
  const userId = Number(input.userId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0 || !Number.isSafeInteger(userId) || userId <= 0
    || !Number.isSafeInteger(conversationId) || !conversationId) throw new Error('Stable owned support message identity required.');
  // Validate ownership/account using durable data, never trust queue payloads.
  const owner = channel === 'web'
    ? await db.execute(sql`SELECT s.id FROM support_chat_sessions s JOIN team_members m ON m.id=s.member_id
        JOIN support_chat_messages msg ON msg.session_id=s.id
        WHERE s.id=${-conversationId} AND m.user_id=${userId} AND msg.id=${messageId} AND msg.role='user'`)
    : await db.execute(sql`SELECT c.id,c.provider_account_id FROM outreach_conversations c JOIN outreach_messages m
        ON m.conversation_id=c.id AND m.user_id=c.user_id
        WHERE c.id=${conversationId} AND c.user_id=${userId} AND c.channel=${channel}
          AND m.id=${messageId} AND m.direction='inbound'
          AND (( ${channel === 'whatsapp'} AND (c.provider_account_id IS NULL OR c.provider_account_id=${String(input.phoneNumberId || '')}))
            OR (${channel !== 'whatsapp'} AND c.provider_account_id=${String(input.providerAccountId || '')}))`);
  if (!owner.rows.length) throw new Error('Support turn message ownership mismatch.');
  // A missing/changed queue hint must not create two locks for the same chat.
  const account = String(owner.rows[0].provider_account_id || '');
  const scopeKey = supportTurnScope(userId, channel, conversationId, account);
  const sourceKey = `${channel}:${messageId}`;
  // Whitelist queue fields. No widget session credentials, arbitrary raw webhook
  // payloads, or unprotected customer text are copied into the durable inbox.
  const payload: Payload = { userId, conversationId, channel, inboundMessageId: messageId };
  for (const key of ['phoneNumberId', 'senderId', 'messageId', 'providerAccountId', 'voiceReplyRequested', 'privacyPreprotected', 'sessionId', 'widgetMessageId']) {
    if (input[key] !== undefined) payload[key] = input[key];
  }
  const { redactPiiWithStableTokens } = await import('./PrivacyVaultService.js');
  payload.inboundText = redactPiiWithStableTokens(String(input.inboundText || '')).redactedText;
  await db.transaction(async (tx: Executor) => {
    await tx.execute(sql`INSERT INTO support_conversation_turns(scope_key,user_id,conversation_id,channel,provider_account_id)
      VALUES(${scopeKey},${userId},${conversationId},${channel},${account}) ON CONFLICT DO NOTHING`);
    const locked = await tx.execute(sql`SELECT revision FROM support_conversation_turns WHERE scope_key=${scopeKey} FOR UPDATE`);
    const revision = Number(locked.rows[0].revision) + 1;
    const inserted = await tx.execute(sql`INSERT INTO support_conversation_turn_inputs(scope_key,source_key,revision,message_id,job_name,payload,ready)
      VALUES(${scopeKey},${sourceKey},${revision},${messageId},${jobName},${JSON.stringify(payload)}::jsonb,${ready})
      ON CONFLICT(scope_key,source_key) DO UPDATE SET payload=EXCLUDED.payload,ready=TRUE
        WHERE NOT support_conversation_turn_inputs.ready AND EXCLUDED.ready RETURNING revision`);
    if (inserted.rows.length) await tx.execute(sql`UPDATE support_conversation_turns SET
      revision=GREATEST(revision,${Number(inserted.rows[0].revision)}),updated_at=NOW() WHERE scope_key=${scopeKey}`);
  });
  return scopeKey;
}

/** Check before every pipeline stage and at the final effect/delivery boundary. */
export async function assertSupportTurnFresh(executor: Executor = db): Promise<void> {
  const turn = active.getStore();
  if (!turn) return;
  if (turn.lostLease) throw new SupersededSupportTurn();
  const result = await executor.execute(sql`SELECT revision FROM support_conversation_turns
    WHERE scope_key=${turn.scopeKey} AND lease_token=${turn.token}::uuid AND lease_expires_at>NOW()`);
  if (!result.rows.length || (!turn.sealed && Number(result.rows[0].revision) !== turn.revision)) throw new SupersededSupportTurn();
}

/** Once an external effect starts, it cannot be undone. Later input belongs to
 * the next turn, and the current turn must finish recording its real receipt. */
export async function sealSupportTurn(): Promise<void> {
  const turn = active.getStore();
  if (!turn) return;
  await db.transaction(async (tx: Executor) => {
    await tx.execute(sql`SELECT scope_key FROM support_conversation_turns WHERE scope_key=${turn.scopeKey} FOR UPDATE`);
    await assertSupportTurnFresh(tx);
    if (!turn.sealed && await supportOwnershipSnapshot(turn.userId, turn.conversationId, turn.channel, tx) !== turn.ownership) {
      throw new SupersededSupportTurn();
    }
    if (!turn.sealed) {
      // Media/privacy preparation may still be running after the webhook
      // persisted a newer message but before it registered its queue input.
      // Do not deliver a draft from an earlier snapshot during that gap.
      const latestIncluded = Math.max(...turn.messageIds);
      const newer = turn.channel === 'web'
        ? await tx.execute(sql`SELECT id FROM support_chat_messages WHERE session_id=${-turn.conversationId}
            AND role='user' AND id>${latestIncluded} LIMIT 1`)
        : await tx.execute(sql`SELECT id FROM outreach_messages WHERE conversation_id=${turn.conversationId}
            AND user_id=${turn.userId} AND direction='inbound' AND id>${latestIncluded} LIMIT 1`);
      if (newer.rows.length) throw new Error('Newer customer input is still being prepared; retry this turn.');
    }
    await tx.execute(sql`UPDATE support_conversation_turn_runs SET status='dispatching',updated_at=NOW() WHERE id=${turn.id}::uuid`);
  });
  turn.sealed = true;
}

/** An unsent retry must never resurrect an old answer after newer input. */
export async function supportTurnRetryAllowed(metadata: Record<string, any> | undefined): Promise<boolean> {
  const identity = metadata?.supportTurn;
  if (!identity) return true;
  if (active.getStore()?.id === identity.id && active.getStore()?.sealed) {
    await assertSupportTurnFresh();
    return true;
  }
  const retry = retryLease.getStore();
  const result = await db.execute(sql`SELECT r.status,r.ownership_snapshot,s.revision,s.user_id,s.conversation_id,s.channel FROM support_conversation_turn_runs r
    JOIN support_conversation_turns s ON s.scope_key=r.scope_key
    WHERE r.id=${identity.id}::uuid AND r.scope_key=${identity.scopeKey}
      AND (${!retry} OR (s.lease_token=${retry?.token || null}::uuid AND s.lease_expires_at>NOW()))`);
  const row = result.rows[0];
  return Boolean(row && Number(row.revision) === Number(identity.revision)
    && !['superseded', 'uncertain'].includes(String(row.status))
    && row.ownership_snapshot === await supportOwnershipSnapshot(Number(row.user_id), Number(row.conversation_id), String(row.channel)));
}

/** Durable outbox retries share the same ownership lease as AI generation. */
export async function withSupportTurnRetryLease(metadata: Record<string, any> | undefined, execute: () => Promise<void>): Promise<void> {
  const identity = metadata?.supportTurn;
  if (!identity || active.getStore()) return execute();
  const token = randomUUID();
  const claim = await db.execute(sql`UPDATE support_conversation_turns s SET lease_token=${token}::uuid,
    lease_expires_at=NOW()+INTERVAL '90 seconds' WHERE s.scope_key=${identity.scopeKey}
      AND s.revision=${Number(identity.revision)} AND s.consumed_revision>=${Number(identity.revision)}
      AND (s.lease_expires_at IS NULL OR s.lease_expires_at<NOW())
      AND EXISTS(SELECT 1 FROM support_conversation_turn_runs r WHERE r.id=${identity.id}::uuid
        AND r.scope_key=s.scope_key AND r.status='completed') RETURNING s.scope_key`);
  if (!claim.rows.length) return; // Busy, newer input, or reconciliation: never resend blindly.
  const timer = setInterval(async () => {
    try {
      await db.execute(sql`UPDATE support_conversation_turns SET lease_expires_at=NOW()+INTERVAL '90 seconds'
        WHERE scope_key=${identity.scopeKey} AND lease_token=${token}::uuid AND lease_expires_at>NOW()`);
    } catch (error) { logger.warn({ err: error, scopeKey: identity.scopeKey }, '[SupportTurn] Delivery retry lease renewal failed'); }
  }, 20_000);
  timer.unref();
  try { await retryLease.run({ scopeKey: identity.scopeKey, token }, execute); }
  finally {
    clearInterval(timer);
    await db.execute(sql`UPDATE support_conversation_turns SET lease_token=NULL,lease_expires_at=NULL
      WHERE scope_key=${identity.scopeKey} AND lease_token=${token}::uuid`);
  }
}

export async function runSupportConversationJob<T>(jobName: string, payload: Payload, execute: (input: Payload) => Promise<T>): Promise<T | { success: true; method: 'coalesced' }> {
  if (active.getStore() || !supportConversationTurnsEnabled(jobs[jobName])) return execute(payload);
  const scopeKey = await registerSupportTurnInput(jobName, payload);
  if (!scopeKey) return execute(payload);
  const token = randomUUID();
  const claim = await db.execute(sql`UPDATE support_conversation_turns SET lease_token=${token}::uuid,
    lease_expires_at=NOW()+INTERVAL '90 seconds' WHERE scope_key=${scopeKey}
    AND (lease_expires_at IS NULL OR lease_expires_at<NOW()) RETURNING *`);
  if (!claim.rows.length) throw new BusySupportTurn();
  let heartbeatBusy = false;
  let leaseLost = false;
  const timer = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      const renewed = await db.execute(sql`UPDATE support_conversation_turns SET lease_expires_at=NOW()+INTERVAL '90 seconds'
        WHERE scope_key=${scopeKey} AND lease_token=${token}::uuid AND lease_expires_at>NOW() RETURNING scope_key`);
      if (!renewed.rows.length) leaseLost = true;
    } catch { leaseLost = true; }
    finally { heartbeatBusy = false; }
  }, 20_000);
  timer.unref();
  let lastResult: T | undefined;
  try {
    // A dead worker may have proposed fields but never authorized any external
    // effect. Restore that attempt before reading a new pipeline snapshot.
    const abandoned = (await db.execute(sql`SELECT r.* FROM support_conversation_turn_runs r
      JOIN support_conversation_turns s ON s.scope_key=r.scope_key
      WHERE r.scope_key=${scopeKey} AND r.status IN ('processing','failed')
        AND r.last_revision>s.consumed_revision ORDER BY r.created_at`)).rows;
    for (const previous of abandoned) await db.transaction(async (tx: Executor) => {
      const owned = await tx.execute(sql`SELECT * FROM support_conversation_turns WHERE scope_key=${scopeKey}
        AND lease_token=${token}::uuid AND lease_expires_at>NOW() FOR UPDATE`);
      if (!owned.rows.length) throw new SupersededSupportTurn();
      await restoreProposal(tx, previous.id, previous.playbook_baseline, Number(owned.rows[0].user_id), Number(owned.rows[0].conversation_id));
      await tx.execute(sql`UPDATE support_conversation_turn_runs SET status='failed',updated_at=NOW() WHERE id=${previous.id}::uuid`);
    });
    // Drain durable pending input, not just the message that woke this worker.
    // Recovery cron schedules another wake-up if this fairness bound is reached.
    for (let iteration = 0; iteration < 20; iteration++) {
      if (leaseLost) throw new SupersededSupportTurn();
      const state = (await db.execute(sql`SELECT * FROM support_conversation_turns WHERE scope_key=${scopeKey} AND lease_token=${token}::uuid`)).rows[0];
      if (!state) throw new SupersededSupportTurn();
      if (Number(state.revision) <= Number(state.consumed_revision)) break;
      const uncertain = await db.execute(sql`SELECT id FROM support_conversation_turn_runs WHERE scope_key=${scopeKey}
        AND status IN ('dispatching','uncertain') AND last_revision>${Number(state.consumed_revision)} LIMIT 1`);
      if (uncertain.rows.length) throw new Error('Support turn requires delivery/effect reconciliation; automatic replay suppressed.');
      const inputs = (await db.execute(sql`SELECT * FROM support_conversation_turn_inputs WHERE scope_key=${scopeKey}
        AND revision>${Number(state.consumed_revision)} AND revision<=${Number(state.revision)} ORDER BY message_id,revision LIMIT 100`)).rows;
      if (!inputs.length) throw new Error('Support turn inbox is incomplete.');
      if (inputs.some((item: any) => !item.ready)) throw new Error('Customer input preparation is still pending; retry this turn.');
      if (Number(state.revision) - Number(state.consumed_revision) > 100) throw new Error('Support turn exceeds automatic input limit; review required.');
      const texts = inputs.map((item: any) => String(item.payload.inboundText || ''));
      if (texts.join('\n').length > 100_000) throw new Error('Support turn exceeds automatic text limit; review required.');
      const baseline = (await db.execute(sql`SELECT id,state,current_node_id,status FROM support_playbook_runs
        WHERE user_id=${Number(state.user_id)} AND conversation_id=${Number(state.conversation_id)} AND status='active'`)).rows;
      const ownership = await supportOwnershipSnapshot(Number(state.user_id), Number(state.conversation_id), state.channel);
      const run = (await db.execute(sql`INSERT INTO support_conversation_turn_runs(id,scope_key,first_revision,last_revision,message_ids,playbook_baseline,ownership_snapshot)
        VALUES(${randomUUID()}::uuid,${scopeKey},${Math.min(...inputs.map((item: any) => Number(item.revision)))},${Number(state.revision)},${JSON.stringify(inputs.map((item: any) => Number(item.message_id)))}::jsonb,${JSON.stringify(baseline)}::jsonb,${ownership})
        ON CONFLICT(scope_key,first_revision,last_revision) DO UPDATE SET status='processing',playbook_baseline=EXCLUDED.playbook_baseline,ownership_snapshot=EXCLUDED.ownership_snapshot,updated_at=NOW() RETURNING *`)).rows[0];
      const turn: ActiveTurn = { scopeKey, id: run.id, revision: Number(state.revision), userId: Number(state.user_id),
        conversationId: Number(state.conversation_id), channel: state.channel, token, sealed: false,
        messageIds: inputs.map((item: any) => Number(item.message_id)), messages: texts, lostLease: false,
        messageVaultIds: inputs.map((item: any) => Number(item.payload.privacyPreprotected?.vaultId) || null),
        providerMessageId: typeof inputs.at(-1).payload.messageId === 'string' ? inputs.at(-1).payload.messageId : undefined,
        ownership };
      try {
        lastResult = await active.run(turn, async () => {
          const latest = inputs.at(-1).payload;
          const protectedInputs = inputs.map((item: any) => item.payload.privacyPreprotected).filter(Boolean);
          const privacyPreprotected = protectedInputs.length ? {
            vaultId: turn.messageVaultIds.filter(Boolean).at(-1) || null,
            piiTypes: [...new Set(protectedInputs.flatMap((item: any) => item.piiTypes || []))],
            tokenCount: protectedInputs.reduce((sum: number, item: any) => sum + (Number(item.tokenCount) || 0), 0),
          } : undefined;
          const result = await execute({ ...latest, ...(privacyPreprotected ? { privacyPreprotected } : {}),
            inboundText: texts.join('\n'), messageId: `turn:${turn.id}` });
          if (result && typeof result === 'object' && 'success' in result && result.success === false) {
            throw new Error('Support turn processing failed; input remains pending.');
          }
          if (result && typeof result === 'object' && 'deliveryStatus' in result && result.deliveryStatus === 'uncertain') {
            throw new Error('Support delivery outcome is uncertain; reconciliation required.');
          }
          await assertSupportTurnFresh();
          await db.transaction(async (tx: Executor) => {
            await tx.execute(sql`SELECT scope_key FROM support_conversation_turns WHERE scope_key=${scopeKey} FOR UPDATE`);
            await assertSupportTurnFresh(tx);
            await tx.execute(sql`UPDATE support_conversation_turn_runs SET status='completed',updated_at=NOW() WHERE id=${turn.id}::uuid`);
            await tx.execute(sql`UPDATE support_conversation_turns SET consumed_revision=${turn.revision},updated_at=NOW()
              WHERE scope_key=${scopeKey} AND lease_token=${token}::uuid`);
          });
          return result;
        });
      } catch (error) {
        if (!turn.sealed && !leaseLost) {
          // Restore only this attempt's uncommitted proposal. A fenced-out
          // worker cannot touch another owner's playbook state.
          await db.transaction(async (tx: Executor) => {
            const owned = await tx.execute(sql`SELECT scope_key FROM support_conversation_turns WHERE scope_key=${scopeKey}
              AND lease_token=${token}::uuid AND lease_expires_at>NOW() FOR UPDATE`);
            if (!owned.rows.length) throw error;
            await restoreProposal(tx, turn.id, baseline, turn.userId, turn.conversationId);
            await tx.execute(sql`UPDATE support_conversation_turn_runs SET status=${error instanceof SupersededSupportTurn ? 'superseded' : 'failed'},updated_at=NOW() WHERE id=${turn.id}::uuid`);
          });
          if (error instanceof SupersededSupportTurn) {
            logger.info({ scopeKey, turnId: turn.id }, '[SupportTurn] Suppressed superseded draft');
            continue;
          }
          throw error;
        }
        await db.execute(sql`UPDATE support_conversation_turn_runs SET status=${turn.sealed ? 'uncertain' : 'failed'},updated_at=NOW()
          WHERE id=${turn.id}::uuid AND EXISTS(SELECT 1 FROM support_conversation_turns WHERE scope_key=${scopeKey} AND lease_token=${token}::uuid)`);
        throw error;
      }
    }
    return lastResult ?? { success: true, method: 'coalesced' };
  } finally {
    clearInterval(timer);
    await db.execute(sql`UPDATE support_conversation_turns SET lease_token=NULL,lease_expires_at=NULL
      WHERE scope_key=${scopeKey} AND lease_token=${token}::uuid`);
  }
}

export async function recoverSupportConversationTurns(): Promise<number> {
  if (!(process.env.SUPPORT_CONVERSATION_TURN_CHANNELS || '').trim()) return 0;
  const pending = await db.execute(sql`SELECT i.job_name,i.payload FROM support_conversation_turns s
    JOIN LATERAL (SELECT job_name,payload FROM support_conversation_turn_inputs WHERE scope_key=s.scope_key ORDER BY revision DESC LIMIT 1) i ON TRUE
    WHERE s.revision>s.consumed_revision AND (s.lease_expires_at IS NULL OR s.lease_expires_at<NOW())
      AND NOT EXISTS(SELECT 1 FROM support_conversation_turn_runs r WHERE r.scope_key=s.scope_key
        AND r.last_revision>s.consumed_revision AND r.status IN ('dispatching','uncertain'))
      AND NOT EXISTS(SELECT 1 FROM support_conversation_turn_inputs p WHERE p.scope_key=s.scope_key
        AND p.revision>s.consumed_revision AND NOT p.ready)
      AND s.updated_at<NOW()-INTERVAL '1 minute' ORDER BY s.updated_at LIMIT 50`);
  const { jobDispatcher } = await import('../../../queues/JobDispatcher.js');
  for (const row of pending.rows) await jobDispatcher.dispatch(row.job_name, row.payload);
  return pending.rows.length;
}
