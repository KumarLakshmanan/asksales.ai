import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { currentBusinessScope } from '../tenancy/businessContext.js';
import { sha256Json as conversationRequestHash } from '../utils/sha256.js';
export { conversationRequestHash };

export class ConversationRequestError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); }
}
export interface ConversationRequestIdentity {
  userId: number; kind: string; conversationId: number; requestId: string; input: unknown;
}
interface ActiveRequest extends ConversationRequestIdentity {
  id: number; signal: AbortSignal; checkpoint: () => Promise<void>; bind: (conversationId: number) => Promise<void>;
  workflowRunId?: string; workflowTurnId?: string;
}
const active = new AsyncLocalStorage<ActiveRequest>();
export function currentConversationRequest() { return active.getStore(); }
export function bindConversationWorkflow(runId: string, turnId?: string) {
  const request = active.getStore();
  if (request) { request.workflowRunId = runId; request.workflowTurnId = turnId; }
}
export function assertConversationRequestActive() {
  const signal = active.getStore()?.signal;
  if (signal?.aborted) throw signal.reason instanceof ConversationRequestError ? signal.reason
    : new ConversationRequestError('cancelled', 'Stopped before the next action.');
}
export async function checkpointConversationRequest() { await active.getStore()?.checkpoint(); }
export async function bindConversationRequest(conversationId: number) {
  const turn = active.getStore();
  if (turn) { await turn.bind(conversationId); turn.conversationId = conversationId; }
}
export function validConversationRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{8,140}$/.test(value);
}

/** Durable FIFO ownership and response replay. Payloads stay in their existing
 * owned message stores; failed/uncertain mutations are never replayed blindly. */
export class ConversationRequestCoordinator {
  constructor(private readonly database = db) {}
  async run<T>(identity: ConversationRequestIdentity, execute: () => Promise<T>): Promise<T> {
    if (!validConversationRequestId(identity.requestId)) throw new ConversationRequestError('invalid_request_id', 'Invalid message identity.', 400);
    const scope = `${identity.userId}:${currentBusinessScope()?.businessProfileId ?? 'unselected'}:${identity.kind}:${identity.kind === 'campaign_init' ? identity.requestId : identity.conversationId}`;
    const digest = conversationRequestHash(identity.input);
    const token = randomUUID();
    await this.database.execute(sql`INSERT INTO conversation_request_scopes(scope_key) VALUES(${scope}) ON CONFLICT DO NOTHING`);
    await this.database.execute(sql`INSERT INTO conversation_requests(user_id,scope_key,kind,conversation_id,request_id,input_hash)
      VALUES(${identity.userId},${scope},${identity.kind},${identity.conversationId},${identity.requestId},${digest}) ON CONFLICT DO NOTHING`);
    const deadline = Date.now() + 150_000;
    let id = 0;
    while (true) {
      const claim = await this.database.transaction(async (tx: typeof db) => {
        const lock = (await tx.execute(sql`SELECT * FROM conversation_request_scopes WHERE scope_key=${scope} FOR UPDATE`)).rows[0];
        const row = (await tx.execute(sql`SELECT * FROM conversation_requests WHERE scope_key=${scope} AND request_id=${identity.requestId}`)).rows[0];
        if (row.input_hash !== digest) throw new ConversationRequestError('request_conflict', 'This message identity was already used for different content.');
        if (row.status === 'completed') return { replay: true, response: row.response, id: Number(row.id) };
        if (row.cancel_requested && row.status === 'queued') {
          await tx.execute(sql`UPDATE conversation_requests SET status='cancelled',updated_at=NOW() WHERE id=${row.id}`);
          throw new ConversationRequestError('cancelled', 'The queued message was cancelled.');
        }
        if (row.status === 'cancelled' && ['queue_expired', 'queue_timeout'].includes(row.error_code)) {
          await tx.execute(sql`UPDATE conversation_requests SET status='queued',cancel_requested=FALSE,error_code=NULL,updated_at=NOW() WHERE id=${row.id}`);
          row.status = 'queued';
        }
        if (['uncertain', 'failed', 'cancelled', 'reconciled'].includes(row.status)) throw new ConversationRequestError(row.status,
          row.status === 'cancelled' ? 'The message was stopped.' : 'The previous attempt needs review. Check the saved conversation before starting a new message.');
        // Only a live request handler can own a queued payload. Reclaim an
        // abandoned waiter without ever replaying a started turn.
        await tx.execute(sql`UPDATE conversation_requests SET status='cancelled',error_code='queue_expired',updated_at=NOW()
          WHERE scope_key=${scope} AND status='queued' AND id<>${row.id} AND updated_at<NOW()-INTERVAL '30 seconds'`);
        if (row.status === 'queued') await tx.execute(sql`UPDATE conversation_requests SET updated_at=NOW() WHERE id=${row.id}`);
        if (lock.lease_expires_at && new Date(lock.lease_expires_at).getTime() > Date.now()) return null;
        // A dead owner may already have executed an action. Preserve its receipt
        // boundary and block later context-dependent work until reconciled.
        await tx.execute(sql`UPDATE conversation_requests SET status='uncertain',error_code='lease_expired',updated_at=NOW()
          WHERE scope_key=${scope} AND status='running'`);
        const uncertain = await tx.execute(sql`SELECT id FROM conversation_requests WHERE scope_key=${scope} AND status='uncertain' LIMIT 1`);
        if (uncertain.rows.length) return { blocked: true as const };
        // Unclaimed requests can be resumed with their original client identity.
        const first = (await tx.execute(sql`SELECT id FROM conversation_requests WHERE scope_key=${scope} AND status='queued' ORDER BY id LIMIT 1`)).rows[0];
        if (Number(first?.id) !== Number(row.id)) return null;
        await tx.execute(sql`UPDATE conversation_request_scopes SET lease_token=${token}::uuid,lease_expires_at=NOW()+INTERVAL '90 seconds' WHERE scope_key=${scope}`);
        await tx.execute(sql`UPDATE conversation_requests SET status='running',updated_at=NOW() WHERE id=${row.id}`);
        return { replay: false, id: Number(row.id), response: undefined };
      });
      if (claim && 'blocked' in claim) throw new ConversationRequestError('uncertain', 'A previous turn needs reconciliation before this conversation can continue.');
      if (claim?.replay) return claim.response as T;
      if (claim) { id = claim.id; break; }
      if (Date.now() >= deadline) {
        await this.database.execute(sql`UPDATE conversation_requests SET status='cancelled',error_code='queue_timeout',updated_at=NOW()
          WHERE scope_key=${scope} AND request_id=${identity.requestId} AND status='queued'`);
        throw new ConversationRequestError('queued', 'The queue wait expired. Retry this message to resume it with the same identity.');
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const controller = new AbortController();
    let renewing = false;
    const heartbeat = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        const renewed = await this.database.execute(sql`UPDATE conversation_request_scopes SET lease_expires_at=NOW()+INTERVAL '90 seconds'
          WHERE scope_key=${scope} AND lease_token=${token}::uuid AND lease_expires_at>NOW() RETURNING scope_key`);
        const cancellation = await this.database.execute(sql`SELECT cancel_requested FROM conversation_requests WHERE id=${id}`);
        if (!renewed.rows.length) controller.abort(new ConversationRequestError('uncertain', 'Turn ownership expired. Review the saved results.'));
        else if (cancellation.rows[0]?.cancel_requested) controller.abort(new ConversationRequestError('cancelled', 'Stopped before the next action.'));
      } catch { controller.abort(new ConversationRequestError('uncertain', 'Turn ownership could not be verified. Review the saved results.')); }
      finally { renewing = false; }
    }, 1000);
    heartbeat.unref();
    const turn: ActiveRequest = { ...identity, id, signal: controller.signal,
      checkpoint: async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        const owned = await this.database.execute(sql`SELECT r.cancel_requested FROM conversation_requests r
          JOIN conversation_request_scopes s ON s.scope_key=r.scope_key
          WHERE r.id=${id} AND r.status='running' AND s.lease_token=${token}::uuid AND s.lease_expires_at>NOW()`);
        if (!owned.rows.length) { controller.abort(); throw new ConversationRequestError('uncertain', 'Turn ownership expired. Review the saved results.'); }
        if (owned.rows[0].cancel_requested) { controller.abort(); throw new ConversationRequestError('cancelled', 'Stopped before the next action.'); }
      },
      bind: async conversationId => {
        await this.database.execute(sql`UPDATE conversation_requests SET conversation_id=${conversationId},updated_at=NOW() WHERE id=${id} AND status='running'`);
      },
    };
    try {
      const result = await active.run(turn, execute);
      const saved = await this.database.execute(sql`UPDATE conversation_requests SET status='completed',conversation_id=${turn.conversationId},response=${JSON.stringify(result)}::jsonb,updated_at=NOW()
        WHERE id=${id} AND EXISTS(SELECT 1 FROM conversation_request_scopes WHERE scope_key=${scope} AND lease_token=${token}::uuid AND lease_expires_at>NOW()) RETURNING id`);
      if (!saved.rows.length) throw new ConversationRequestError('uncertain', 'The turn result needs reconciliation.');
      return result;
    } catch (error) {
      const cancelled = error instanceof ConversationRequestError && error.code === 'cancelled';
      await this.database.execute(sql`UPDATE conversation_requests SET status=${cancelled ? 'cancelled' : 'uncertain'},
        error_code=${cancelled ? 'cancelled' : 'execution_interrupted'},updated_at=NOW() WHERE id=${id} AND status='running'`);
      throw error;
    } finally {
      clearInterval(heartbeat);
      await this.database.execute(sql`UPDATE conversation_request_scopes SET lease_token=NULL,lease_expires_at=NULL
        WHERE scope_key=${scope} AND lease_token=${token}::uuid`);
    }
  }
  async list(userId: number, kind: string, conversationId: number) {
    await this.database.execute(sql`UPDATE conversation_requests r SET status='uncertain',error_code='lease_expired',updated_at=NOW()
      FROM conversation_request_scopes s WHERE r.scope_key=s.scope_key AND r.user_id=${userId} AND r.kind=${kind}
        AND r.conversation_id=${conversationId} AND r.status='running' AND (s.lease_expires_at IS NULL OR s.lease_expires_at<NOW())`);
    return (await this.database.execute(sql`SELECT id,request_id,status,cancel_requested,error_code,created_at,updated_at,resolution_note,resolved_at
      FROM conversation_requests WHERE user_id=${userId} AND kind=${kind} AND conversation_id=${conversationId} ORDER BY id DESC LIMIT 30`)).rows;
  }
  /** Operator acknowledgement releases the queue; it never executes or
   * fabricates a result for the interrupted request. */
  async reconcile(userId: number, kind: string, conversationId: number, requestId: string, note: string) {
    if (!validConversationRequestId(requestId) || note.trim().length < 3 || note.length > 500) {
      throw new ConversationRequestError('invalid_resolution', 'Add a short note describing the saved results you reviewed.', 400);
    }
    return this.database.transaction(async (tx: typeof db) => {
      const row = (await tx.execute(sql`SELECT r.*,s.lease_expires_at FROM conversation_requests r
        JOIN conversation_request_scopes s ON s.scope_key=r.scope_key
        WHERE r.user_id=${userId} AND r.kind=${kind} AND r.conversation_id=${conversationId} AND r.request_id=${requestId} FOR UPDATE OF s,r`)).rows[0];
      if (!row) throw new ConversationRequestError('not_found', 'Turn not found.', 404);
      if (row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now()) throw new ConversationRequestError('busy', 'Wait for the active turn to finish.');
      if (!['uncertain','running'].includes(row.status)) throw new ConversationRequestError('not_uncertain', 'This turn does not need reconciliation.');
      await tx.execute(sql`UPDATE conversation_requests SET status='reconciled',resolution_note=${note.trim()},resolved_at=NOW(),updated_at=NOW() WHERE id=${row.id}`);
      return { status: 'reconciled' };
    });
  }
  async cancel(userId: number, kind: string, conversationId: number, requestId?: string) {
    return (await this.database.execute(sql`UPDATE conversation_requests SET cancel_requested=TRUE,
      status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=NOW()
      WHERE user_id=${userId} AND kind=${kind} AND conversation_id=${conversationId} AND status IN ('queued','running')
        AND ((${requestId == null} AND status='running') OR request_id=${requestId || ''}) RETURNING id,status`)).rows;
  }
}
export const conversationRequests = new ConversationRequestCoordinator();
