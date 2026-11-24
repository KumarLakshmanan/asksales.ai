import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import {
  businessAuditActor,
  requireBusinessScope,
} from "../../tenancy/businessContext.js";
import {
  assistantBindingKey,
  emptyAssistantDraft,
  type AssistantDraft,
  type AssistantReadiness,
  type OutreachAssistant,
  type AssistantBindingInput,
} from "../../../shared/outreachAssistants.js";
import {
  assistantCatalog,
  assistantPlatformReadiness,
  availableAssistantModels,
} from "./AssistantCatalogService.js";
import {
  assistantReadiness,
  parseAssistantDraft,
} from "./AssistantConfiguration.js";
import { redactPiiWithStableTokens } from "../agents/orchestration/PrivacyVaultService.js";
import { assistantsRuntimeEnabled } from "./AssistantContext.js";
import { supportAutoReplyEnabled } from "../../../shared/supportAutoReplies.js";
import { boundedPageLimit, encodeAssistantCursor, decodeAssistantCursor } from './AssistantPagination.js';
import { AssistantManagementError } from './AssistantManagementError.js';
export { AssistantManagementError } from './AssistantManagementError.js';

type Row = Record<string, any>;
type Executor = Pick<typeof db, "execute">;
function validId(id: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new AssistantManagementError("Invalid assistant ID.");
}
export async function assistantRow(
  id: string,
  tx: Executor = db,
  lock = false,
): Promise<Row> {
  validId(id);
  const scope = requireBusinessScope();
  const result =
    await tx.execute(sql`SELECT a.*,r.configuration AS published FROM outreach_assistants a
    LEFT JOIN outreach_assistant_revisions r ON r.assistant_id=a.id AND r.revision=a.published_revision
    WHERE a.id=${id}::uuid AND a.user_id=${scope.userId} AND a.business_profile_id=${scope.businessProfileId}
    ${lock ? sql`FOR UPDATE OF a` : sql``}`);
  if (!result.rows[0])
    throw new AssistantManagementError(
      "Assistant not found in this business.",
      404,
    );
  return result.rows[0];
}
async function audit(
  tx: Executor,
  id: string,
  action: string,
  details: unknown = {},
) {
  const scope = requireBusinessScope();
  await tx.execute(sql`INSERT INTO outreach_assistant_audit(user_id,assistant_id,actor_user_id,action,details)
    VALUES(${scope.userId},${id}::uuid,${businessAuditActor(scope.userId)},${action},${JSON.stringify(details)}::jsonb)`);
}
function protectedDraft(input: unknown): AssistantDraft {
  try {
    const draft = parseAssistantDraft(input);
    draft.demonstrations = draft.demonstrations.map((d) => ({
      customer: redactPiiWithStableTokens(d.customer).redactedText,
      assistant: redactPiiWithStableTokens(d.assistant).redactedText,
    }));
    return draft;
  } catch (error) {
    throw new AssistantManagementError(
      error instanceof Error
        ? error.message
        : "Invalid assistant configuration.",
    );
  }
}
async function readiness(
  draft: AssistantDraft,
  enabledBindings?: AssistantBindingInput[],
): Promise<AssistantReadiness> {
  const [catalog, platform] = await Promise.all([
    assistantCatalog(),
    assistantPlatformReadiness(),
  ]);
  return assistantReadiness(draft, catalog, platform, enabledBindings);
}
async function assertSelectedModelsAvailable(draft: AssistantDraft): Promise<void> {
  const selected = [draft.replyModel, ...draft.fallbackModels].filter(Boolean);
  if (!selected.length) return;
  const models = await availableAssistantModels();
  if (selected.some(selection => !models.some(model => model.provider === selection?.provider && model.model === selection?.model)))
    throw new AssistantManagementError('A selected reply or fallback model is unavailable. Choose an enabled model before saving.', 400);
}
async function serialize(row: Row, context?: { catalog: Awaited<ReturnType<typeof assistantCatalog>>; platform: Awaited<ReturnType<typeof assistantPlatformReadiness>>; bindings: Row[] }): Promise<OutreachAssistant> {
  const checks = context ? assistantReadiness(row.draft as AssistantDraft, context.catalog, context.platform) : await readiness(row.draft as AssistantDraft);
  const scope = requireBusinessScope();
  const bindings = context ? { rows: context.bindings.filter(b => String(b.assistant_id) === String(row.id) && Number(b.revision) === Number(row.published_revision || 0)) } :
    await db.execute(sql`SELECT channel,surface,account_id FROM outreach_assistant_bindings WHERE assistant_id=${row.id}::uuid
    AND business_profile_id=${scope.businessProfileId} AND enabled AND revision=${Number(row.published_revision || 0)}`);
  let state = row.state as OutreachAssistant["state"];
  if (state === "live") {
    const live = row.published
      ? context ? assistantReadiness(row.published as AssistantDraft, context.catalog, context.platform, bindings.rows.map((b: Row) => ({ channel: b.channel, surface: b.surface, accountId: b.account_id }))) : await readiness(
          row.published as AssistantDraft,
          bindings.rows.map((b: Row) => ({
            channel: b.channel,
            surface: b.surface,
            accountId: b.account_id,
          })),
        )
      : { ready: false };
    if (!live.ready || !bindings.rows.length || !assistantsRuntimeEnabled()) state = "needs_attention";
  }
  return {
    id: String(row.id),
    businessProfileId: Number(row.business_profile_id),
    state,
    draft: row.draft,
    draftVersion: Number(row.draft_version),
    publishedRevision:
      row.published_revision == null ? null : Number(row.published_revision),
    enabledBindings: bindings.rows.map((b: Row) => ({
      channel: b.channel,
      surface: b.surface,
      accountId: b.account_id,
    })),
    published: row.published || null,
    readiness: checks,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Cancel only unsent work. Provider calls already started retain their actual receipt/reconciliation. */
export async function invalidateAssistantBinding(
  tx: Executor,
  binding: Row,
  reason = "assistant_reassigned",
) {
  const scope = requireBusinessScope();
  const selector =
    binding.channel === "web"
      ? sql`SELECT -s.id FROM support_chat_sessions s JOIN team_members m ON m.id=s.member_id
        WHERE s.business_profile_id=${scope.businessProfileId} AND m.user_id=${scope.userId} AND ('team:' || m.team_id::text)=${binding.account_id}`
      : sql`SELECT c.id FROM outreach_conversations c WHERE c.user_id=${scope.userId} AND c.business_profile_id=${scope.businessProfileId}
        AND c.channel=${binding.channel} AND c.provider_account_id=${binding.account_id}`;
  // Provenance is authoritative, even when a legacy conversation did not persist its sender account.
  await tx.execute(sql`UPDATE support_delivery_outbox SET status='cancelled',next_attempt_at=NULL,last_error=${reason},updated_at=NOW()
    WHERE user_id=${scope.userId} AND status IN ('pending','failed','drafted')
      AND (payload->'metadata'->'assistant'->>'bindingId'=${String(binding.id)}
        OR (payload->'metadata'->'assistant' IS NULL AND ${binding.surface === "private"} AND conversation_id IN (${selector})))`);
  await tx.execute(sql`UPDATE social_follow_up_schedules SET status='cancelled',cancelled_at=NOW(),cancellation_reason=${reason},
    version=version+1,updated_at=NOW() WHERE user_id=${scope.userId} AND status IN ('active','queued')
      AND (assistant_provenance->>'bindingId'=${String(binding.id)}
        OR (assistant_provenance IS NULL AND ${binding.surface === "private"} AND conversation_id IN (${selector})))`);
  await tx.execute(sql`UPDATE outreach_assistant_follow_up_schedules SET status='cancelled',version=version+1,cancellation_reason=${reason},updated_at=NOW()
    WHERE user_id=${scope.userId} AND binding_id=${Number(binding.id)} AND status IN ('active','queued')`);
  await tx.execute(sql`UPDATE outreach_messages SET status='cancelled',updated_at=NOW()
    WHERE user_id=${scope.userId} AND status IN ('pending','scheduled','queued','draft','drafted','failed')
      AND COALESCE(provider_call_state,'not_started')='not_started' AND message_kind IN ('reply','follow_up')
      AND (metadata->'assistant'->>'bindingId'=${String(binding.id)}
        OR (metadata->'assistant' IS NULL AND ${binding.surface === "private"} AND conversation_id IN (${selector})))`);
  await tx.execute(sql`UPDATE support_playbook_runs SET status='superseded',updated_at=NOW()
    WHERE user_id=${scope.userId} AND status='active' AND
      (state->>'assistantBindingId'=${String(binding.id)} OR
        (state->>'assistantBindingId' IS NULL AND ${binding.surface === "private"} AND conversation_id IN (${selector})))`);
  await tx.execute(sql`UPDATE tool_approvals SET status='expired',is_expired=TRUE,resume_status='cancelled',updated_at=NOW()
    WHERE user_id=${scope.userId} AND status IN ('pending','approved') AND
      (assistant_provenance->>'bindingId'=${String(binding.id)} OR
        (assistant_provenance IS NULL AND ${binding.surface === "private"} AND thread_id IN (${selector})))`);
  await tx.execute(sql`UPDATE support_conversation_turns SET revision=revision+1,updated_at=NOW()
    WHERE user_id=${scope.userId} AND ${binding.surface === "private"} AND conversation_id IN (${selector})`);
}

export const assistantService = {
  async listPage(query: Record<string,unknown>) {
    const scope=requireBusinessScope(),limit=boundedPageLimit(query.limit,24);
    const search=query.search===undefined?'':String(query.search).trim();
    const state=query.state===undefined||query.state==='all'?null:String(query.state);
    if(search.length>120 || (state&&!['draft','live','paused','needs_attention'].includes(state))) throw new AssistantManagementError('Invalid assistant list filter.');
    const source=`list:${scope.businessProfileId}:${search}:${state || ''}`,cursor=decodeAssistantCursor(query.cursor,source);
    const [catalog,platform]=await Promise.all([assistantCatalog(),assistantPlatformReadiness()]);
    const namedBindings=catalog.accounts.filter(a=>`${a.label} ${a.accountId}`.toLowerCase().includes(search.toLowerCase())).map(assistantBindingKey);
    const namedBindingArray=sql`ARRAY[${sql.join(namedBindings.map(key=>sql`${key}`),sql`, `)}]::text[]`;
    const rows=await db.execute(sql`SELECT a.*,r.configuration AS published FROM outreach_assistants a LEFT JOIN outreach_assistant_revisions r
      ON r.assistant_id=a.id AND r.revision=a.published_revision AND r.business_profile_id=a.business_profile_id
      WHERE a.user_id=${scope.userId} AND a.business_profile_id=${scope.businessProfileId}
      AND (${search}='' OR strpos(lower(concat_ws(' ',a.draft->>'name',a.draft->>'description',a.draft->'replyModel'->>'model',
        r.configuration->>'name',r.configuration->>'description',r.configuration->'replyModel'->>'model')),lower(${search}))>0
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(a.draft->'bindings','[]'::jsonb)) input
          WHERE strpos(lower(input->>'accountId'),lower(${search}))>0 OR ((input->>'channel')||':'||(input->>'surface')||':'||(input->>'accountId'))=ANY(${namedBindingArray}))
        OR EXISTS(SELECT 1 FROM outreach_assistant_bindings b WHERE b.assistant_id=a.id AND b.user_id=a.user_id AND b.business_profile_id=a.business_profile_id
          AND b.enabled AND (strpos(lower(b.account_id),lower(${search}))>0 OR (b.channel||':'||b.surface||':'||b.account_id)=ANY(${namedBindingArray}))))
      ${state==='needs_attention'?sql`AND a.state IN ('live','needs_attention')`:state?sql`AND a.state=${state}`:sql``}
      ${cursor?sql`AND (date_trunc('milliseconds',a.updated_at),a.id::text)<(${cursor.date}::timestamptz,${cursor.key})`:sql``}
      ORDER BY date_trunc('milliseconds',a.updated_at) DESC,a.id::text DESC LIMIT ${limit+1}`);
    const page=rows.rows.slice(0,limit) as Row[],ids=page.map((r:Row)=>String(r.id));
    const bindings=await db.execute(sql`SELECT assistant_id,revision,channel,surface,account_id
      FROM outreach_assistant_bindings WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND enabled
      ${ids.length?sql`AND assistant_id::text IN (${sql.join(ids.map((id:string)=>sql`${id}`),sql`,`)})`:sql`AND FALSE`}`);
    const assistants=(await Promise.all(page.map((row:Row)=>serialize(row,{catalog,platform,bindings:bindings.rows})))).filter(a=>!state||a.state===state);
    const last=page.at(-1);
    return {assistants,runtimeEnabled:assistantsRuntimeEnabled(),nextCursor:rows.rows.length>limit&&last?encodeAssistantCursor(new Date(last.updated_at as any).toISOString(),String(last.id),source):null};
  },
  async list(preloaded?: {catalog: Awaited<ReturnType<typeof assistantCatalog>>;platform: Awaited<ReturnType<typeof assistantPlatformReadiness>>}) {
    const scope = requireBusinessScope();
    const rows =
      await db.execute(sql`SELECT a.*,r.configuration AS published FROM outreach_assistants a LEFT JOIN outreach_assistant_revisions r
      ON r.assistant_id=a.id AND r.revision=a.published_revision WHERE a.user_id=${scope.userId}
      AND a.business_profile_id=${scope.businessProfileId} ORDER BY a.updated_at DESC,a.id`);
    const [catalog, platform, bindings] = await Promise.all([preloaded?.catalog || assistantCatalog(), preloaded?.platform || assistantPlatformReadiness(), db.execute(sql`SELECT assistant_id,revision,channel,surface,account_id FROM outreach_assistant_bindings WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND enabled`)]);
    return Promise.all(rows.rows.map((row: Row) => serialize(row, {catalog,platform,bindings:bindings.rows})));
  },
  async get(id: string) {
    return serialize(await assistantRow(id));
  },
  async create(input: unknown) {
    const draft = protectedDraft(input),
      scope = requireBusinessScope(),
      id = randomUUID();
    await assertSelectedModelsAvailable(draft);
    await db.transaction(async (tx: Executor) => {
      await tx.execute(
        sql`INSERT INTO outreach_assistants(id,user_id,draft) VALUES(${id}::uuid,${scope.userId},${JSON.stringify(draft)}::jsonb)`,
      );
      await audit(tx, id, "create_draft");
    });
    return this.get(id);
  },
  async save(id: string, input: unknown, expectedVersion: number) {
    const draft = protectedDraft(input);
    await assertSelectedModelsAvailable(draft);
    await db.transaction(async (tx: Executor) => {
      const row = await assistantRow(id, tx, true);
      if (Number(row.draft_version) !== expectedVersion)
        throw new AssistantManagementError(
          "This draft changed. Reload before saving.",
          409,
        );
      await tx.execute(sql`UPDATE outreach_assistants SET draft=${JSON.stringify(draft)}::jsonb,draft_version=draft_version+1,
        updated_at=NOW() WHERE id=${id}::uuid`);
      await audit(tx, id, "save_draft", { draftVersion: expectedVersion + 1 });
    });
    return this.get(id);
  },
  async readiness(id: string) {
    return readiness((await assistantRow(id)).draft);
  },
  async publish(
    id: string,
    expectedVersion: number,
    reassign = false,
    rollbackRevision?: number,
  ) {
    // A reviewed configuration may be prepared before runtime activation.
    // Delivery still checks runtime at admission and at the provider boundary.
    // Existing resume/rollback behavior remains restricted to enabled runtime.
    if (rollbackRevision !== undefined && !assistantsRuntimeEnabled())
      throw new AssistantManagementError(
        "Assistant routing is not enabled for this business yet. Drafts and simulator tests remain available.",
        409,
      );
    await db.transaction(async (tx: Executor) => {
      const scope = requireBusinessScope();
      // Serialize publishes/reassignments for the whole business, including competing assistants.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(20260929,${scope.businessProfileId})`,
      );
      const row = await assistantRow(id, tx, true);
      if (Number(row.draft_version) !== expectedVersion)
        throw new AssistantManagementError(
          "This draft changed. Reload and review it again.",
          409,
        );
      let draft = protectedDraft(row.draft);
      if (rollbackRevision !== undefined) {
        const previous = await tx.execute(
          sql`SELECT configuration FROM outreach_assistant_revisions WHERE assistant_id=${id}::uuid AND revision=${rollbackRevision}`,
        );
        if (!previous.rows[0])
          throw new AssistantManagementError(
            "Published revision not found.",
            404,
          );
        draft = protectedDraft(previous.rows[0].configuration);
      }
      const checks = await readiness(draft);
      if (!checks.ready)
        throw new AssistantManagementError(
          "Assistant is not ready to publish.",
          422,
          checks,
        );
      const existing = await tx.execute(
        sql`SELECT * FROM outreach_assistant_bindings WHERE business_profile_id=${scope.businessProfileId} AND enabled FOR UPDATE`,
      );
      const wanted = new Set(draft.bindings.map(assistantBindingKey));
      const conflicts = existing.rows.filter(
        (b: Row) =>
          b.assistant_id !== id &&
          wanted.has(
            assistantBindingKey({
              channel: b.channel,
              surface: b.surface,
              accountId: b.account_id,
            }),
          ),
      );
      if (conflicts.length && !reassign)
        throw new AssistantManagementError(
          "These accounts already have an assistant. Confirm reassignment to replace it.",
          409,
          {
            bindings: conflicts.map((b: Row) => ({
              channel: b.channel,
              surface: b.surface,
              accountId: b.account_id,
              assistantId: b.assistant_id,
            })),
          },
        );
      const affected = existing.rows.filter(
        (b: Row) => b.assistant_id === id || conflicts.includes(b),
      );
      for (const binding of affected) {
        await invalidateAssistantBinding(tx, binding);
        await tx.execute(
          sql`UPDATE outreach_assistant_bindings SET enabled=FALSE,version=version+1,updated_at=NOW() WHERE id=${Number(binding.id)}`,
        );
      }
      const max = await tx.execute(
        sql`SELECT COALESCE(MAX(revision),0)::int AS n FROM outreach_assistant_revisions WHERE assistant_id=${id}::uuid`,
      );
      const revision = Number(max.rows[0].n) + 1;
      const configuration = JSON.stringify(draft);
      await tx.execute(sql`INSERT INTO outreach_assistant_revisions(user_id,assistant_id,revision,configuration,checksum,published_by)
        VALUES(${scope.userId},${id}::uuid,${revision},${configuration}::jsonb,${createHash("sha256").update(configuration).digest("hex")},${businessAuditActor(scope.userId)})`);
      for (const binding of draft.bindings) {
        await tx.execute(sql`INSERT INTO outreach_assistant_bindings(user_id,assistant_id,revision,channel,surface,account_id)
          VALUES(${scope.userId},${id}::uuid,${revision},${binding.channel},${binding.surface},${binding.accountId})`);
      }
      for (const conflict of conflicts)
        await tx.execute(sql`UPDATE outreach_assistants SET state='paused',updated_at=NOW()
        WHERE id=${conflict.assistant_id}::uuid AND NOT EXISTS(SELECT 1 FROM outreach_assistant_bindings WHERE assistant_id=${conflict.assistant_id}::uuid AND enabled)`);
      await tx.execute(sql`UPDATE outreach_assistants SET published_revision=${revision},state='live',migration_review_required=FALSE,
        updated_at=NOW() WHERE id=${id}::uuid`);
      await audit(
        tx,
        id,
        rollbackRevision === undefined ? "publish" : "rollback",
        {
          revision,
          rollbackRevision,
          previousBindings: affected.map((b: Row) => ({
            assistantId: b.assistant_id,
            revision: b.revision,
            channel: b.channel,
            surface: b.surface,
            accountId: b.account_id,
          })),
        },
      );
    });
    return this.get(id);
  },
  async pause(id: string) {
    await db.transaction(async (tx: Executor) => {
      const scope = requireBusinessScope();
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(20260929,${scope.businessProfileId})`,
      );
      await assistantRow(id, tx, true);
      const bindings = await tx.execute(
        sql`SELECT * FROM outreach_assistant_bindings WHERE assistant_id=${id}::uuid AND enabled FOR UPDATE`,
      );
      for (const binding of bindings.rows) {
        await invalidateAssistantBinding(tx, binding, "assistant_paused");
        await tx.execute(
          sql`UPDATE outreach_assistant_bindings SET enabled=FALSE,version=version+1,updated_at=NOW() WHERE id=${Number(binding.id)}`,
        );
      }
      await tx.execute(
        sql`UPDATE outreach_assistants SET state='paused',updated_at=NOW() WHERE id=${id}::uuid`,
      );
      await audit(tx, id, "pause");
    });
    return this.get(id);
  },
  async resume(id: string) {
    const row = await assistantRow(id);
    if (!row.published_revision)
      throw new AssistantManagementError(
        "Publish a reviewed draft before enabling replies.",
        422,
      );
    return this.publish(
      id,
      Number(row.draft_version),
      false,
      Number(row.published_revision),
    );
  },
  async rollbackBindings(id: string, expectedPublishedRevision: number) {
    if (!assistantsRuntimeEnabled())
      throw new AssistantManagementError(
        "Assistant routing is not enabled for this business.",
        409,
      );
    await db.transaction(async (tx: Executor) => {
      const scope = requireBusinessScope();
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(20260929,${scope.businessProfileId})`,
      );
      const current = await assistantRow(id, tx, true);
      if (Number(current.published_revision) !== expectedPublishedRevision)
        throw new AssistantManagementError(
          "The published assignment changed. Reload before rolling back.",
          409,
        );
      const last =
        await tx.execute(sql`SELECT details FROM outreach_assistant_audit WHERE assistant_id=${id}::uuid
        AND action IN ('publish','rollback') AND (details->>'revision')::int=${expectedPublishedRevision} ORDER BY id DESC LIMIT 1`);
      if (
        !last.rows[0] ||
        !Array.isArray((last.rows[0].details as Row).previousBindings)
      )
        throw new AssistantManagementError(
          "No previous binding snapshot exists.",
          404,
        );
      const previous = (last.rows[0].details as Row).previousBindings as Row[];
      const enabled = await tx.execute(
        sql`SELECT * FROM outreach_assistant_bindings WHERE business_profile_id=${scope.businessProfileId} AND enabled FOR UPDATE`,
      );
      const snapshots = new Map<
        string,
        { revision: number; configuration: AssistantDraft }
      >();
      for (const binding of previous) {
        const other = enabled.rows.find(
          (b: Row) =>
            assistantBindingKey({
              channel: b.channel,
              surface: b.surface,
              accountId: b.account_id,
            }) === assistantBindingKey(binding as any),
        );
        if (other && other.assistant_id !== id)
          throw new AssistantManagementError(
            "An account was reassigned after this release. Review its current assignment instead of overwriting it.",
            409,
          );
        if (snapshots.has(binding.assistantId)) continue;
        const old = await assistantRow(binding.assistantId, tx, true);
        if (
          binding.assistantId !== id &&
          Number(old.published_revision) !== Number(binding.revision)
        )
          throw new AssistantManagementError(
            "A previous assistant changed after reassignment. Review its configuration before restoring bindings.",
            409,
          );
        const revision = await tx.execute(
          sql`SELECT configuration FROM outreach_assistant_revisions WHERE assistant_id=${binding.assistantId}::uuid AND revision=${Number(binding.revision)}`,
        );
        if (!revision.rows[0])
          throw new AssistantManagementError(
            "Previous published configuration is unavailable.",
            409,
          );
        const configuration = protectedDraft(revision.rows[0].configuration),
          checks = await readiness(configuration);
        if (!checks.ready)
          throw new AssistantManagementError(
            "A previous assistant is no longer ready. Resolve its readiness checks before rollback.",
            422,
            checks,
          );
        snapshots.set(binding.assistantId, {
          revision: Number(binding.revision),
          configuration,
        });
      }
      for (const binding of enabled.rows.filter(
        (b: Row) => b.assistant_id === id,
      )) {
        await invalidateAssistantBinding(
          tx,
          binding,
          "assistant_binding_rollback",
        );
        await tx.execute(
          sql`UPDATE outreach_assistant_bindings SET enabled=FALSE,version=version+1,updated_at=NOW() WHERE id=${Number(binding.id)}`,
        );
      }
      for (const binding of previous)
        await tx.execute(sql`INSERT INTO outreach_assistant_bindings(user_id,assistant_id,revision,channel,surface,account_id)
        VALUES(${scope.userId},${binding.assistantId}::uuid,${Number(binding.revision)},${binding.channel},${binding.surface},${binding.accountId})`);
      if (!snapshots.has(id))
        await tx.execute(
          sql`UPDATE outreach_assistants SET state='paused',updated_at=NOW() WHERE id=${id}::uuid`,
        );
      for (const [assistantId, snapshot] of snapshots) {
        await tx.execute(
          sql`UPDATE outreach_assistants SET published_revision=${snapshot.revision},state='live',updated_at=NOW() WHERE id=${assistantId}::uuid`,
        );
        await audit(tx, assistantId, "restore_bindings", {
          fromAssistantId: id,
          fromRevision: expectedPublishedRevision,
          revision: snapshot.revision,
        });
      }
      await audit(tx, id, "rollback_bindings", {
        fromRevision: expectedPublishedRevision,
        restoredBindings: previous,
      });
    });
    return this.list();
  },
  async remove(id: string) {
    const row = await assistantRow(id);
    if (row.published_revision || row.state === "live")
      throw new AssistantManagementError(
        "Published assistants retain CRM/audit history. Pause this assistant instead.",
        409,
      );
    await db.transaction(async (tx: Executor) => {
      await tx.execute(
        sql`DELETE FROM outreach_assistant_audit WHERE assistant_id=${id}::uuid`,
      );
      await tx.execute(
        sql`DELETE FROM outreach_assistants WHERE id=${id}::uuid`,
      );
    });
  },
  async history(id: string) {
    await assistantRow(id);
    const scope = requireBusinessScope();
    const rows =
      await db.execute(sql`SELECT m.id,c.channel,m.status,m.created_at,COALESCE(m.redacted_content,m.content) AS content FROM outreach_messages m
      JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
      WHERE m.user_id=${scope.userId} AND m.business_profile_id=${scope.businessProfileId} AND m.message_kind='follow_up'
        AND m.metadata->'assistant'->>'assistantId'=${id} ORDER BY m.created_at DESC,m.id DESC LIMIT 100`);
    return {
      history: rows.rows.map((r: Row) => ({
        id: Number(r.id),
        channel: String(r.channel),
        status: String(r.status),
        createdAt: new Date(r.created_at).toISOString(),
        content: r.content
          ? redactPiiWithStableTokens(String(r.content)).redactedText
          : null,
      })),
    };
  },
  /** Legacy migration is explicit and conservative: copy approved owner settings into a review-required draft, never enable guesses. */
  async migrateLegacy() {
    const scope = requireBusinessScope(),
      catalog = await assistantCatalog();
    const rows = await db.execute(
      sql`SELECT * FROM ai_agent_configs WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND enabled`,
    );
    const [assignments, settings] = await Promise.all([
      db.execute(
        sql`SELECT * FROM support_playbook_assignments WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND enabled`,
      ),
      db.execute(
        sql`SELECT channel_follow_ups,enable_auto_follow_up,follow_up_steps FROM outreach_settings WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}`,
      ),
    ]);
    for (const row of rows.rows as Row[]) {
      const draft = emptyAssistantDraft();
      draft.name = String(row.display_name || "Imported support assistant");
      draft.agentType = String(row.agent_type);
      draft.instructions = String(row.system_prompt || "");
      draft.description = String(row.description || "");
      draft.policies = Array.isArray(row.escalation_rules)
        ? { rules: row.escalation_rules }
        : row.escalation_rules || {};
      draft.tools = {
        mode:
          Array.isArray(row.tools_enabled) && row.tools_enabled.length
            ? "selected"
            : "none",
        names: row.tools_enabled || [],
        approvalRequired: catalog.tools
          .filter(
            (t) => t.approvalRequired && row.tools_enabled?.includes(t.name),
          )
          .map((t) => t.name),
      };
      const model = row.model_override
        ? catalog.models.find((m) => m.model === row.model_override)
        : catalog.models[0];
      if (model)
        draft.replyModel = { provider: model.provider, model: model.model };
      draft.demonstrations = (
        Array.isArray(row.metadata?.trainingConversations)
          ? row.metadata.trainingConversations
          : []
      )
        .slice(0, 50)
        .map((d: Row) => ({
          customer: redactPiiWithStableTokens(String(d.userMessage || ""))
            .redactedText,
          assistant: redactPiiWithStableTokens(String(d.agentReply || ""))
            .redactedText,
        }));
      // A single active legacy configuration has a determinate receiving
      // mapping. Multiple enabled rows were resolved with LIMIT 1: do not
      // guess which row formerly owned an account in that situation.
      if (rows.rows.length === 1)
        draft.bindings = catalog.accounts
          .filter(
            (a) =>
              a.connected &&
              supportAutoReplyEnabled(
                { channelScope: row.channel_scope, metadata: row.metadata },
                a.surface === "public_comment"
                  ? `${a.channel}_comment`
                  : a.channel,
              ) &&
              (a.surface === "private" ||
                row.channel_scope?.includes(`${a.channel}_comment`)),
          )
          .map(({ channel, surface, accountId }) => ({
            channel,
            surface,
            accountId,
          }));
      const publishedAssignments = (assignments.rows as Row[]).filter(
        (a) =>
          Number(a.traffic_percent) === 100 &&
          (!a.agent_type || a.agent_type === row.agent_type) &&
          catalog.playbooks.some((p) => p.id === Number(a.playbook_id)),
      );
      const importedPlaybooks = publishedAssignments.flatMap((a) =>
        draft.bindings
          .filter((b) =>
            !a.channel
              ? b.surface === "private"
              : a.channel ===
                (b.surface === "public_comment"
                  ? `${b.channel}_comment`
                  : b.channel),
          )
          .map((b) => ({
            playbookId: Number(a.playbook_id),
            channel: b.channel,
            surface: b.surface,
            intent: a.intent || null,
            priority: Number(a.priority || 100),
          })),
      );
      if (importedPlaybooks.length) {
        draft.playbooks = {
          mode: "selected",
          assignments: [
            ...new Map(
              importedPlaybooks.map((a) => [
                `${a.playbookId}:${a.channel}:${a.surface}:${a.intent}`,
                a,
              ]),
            ).values(),
          ],
        };
        draft.privacy.permittedCollectionFields = [
          ...new Set(
            draft.playbooks.assignments.flatMap(
              (a) =>
                catalog.playbooks.find((p) => p.id === a.playbookId)
                  ?.collectionFields || [],
            ),
          ),
        ];
      } else if (!assignments.rows.length)
        draft.playbooks = { mode: "none", assignments: [] };
      const follow = (settings.rows[0]?.channel_follow_ups || {}) as Row;
      let followResolved = true;
      const sequences: AssistantDraft["followUps"]["sequences"] = [];
      for (const channel of [
        "whatsapp",
        "instagram",
        "facebook",
        "email",
      ] as const) {
        if (
          !draft.bindings.some(
            (b) => b.channel === channel && b.surface === "private",
          )
        )
          continue;
        const legacyEmail = settings.rows[0];
        const selected =
          follow[channel] ||
          (channel === "email" && legacyEmail?.enable_auto_follow_up === true
            ? { enabled: true, followUps: legacyEmail.follow_up_steps }
            : null);
        if (!selected || selected.enabled !== true) continue;
        const enabled = (
          Array.isArray(selected.followUps) ? selected.followUps : []
        ).filter((s: Row) => s.enabled !== false);
        if (!enabled.length || enabled.length > 3) {
          followResolved = false;
          continue;
        }
        const steps = enabled.map((s: Row) => ({
          templateId: Number(s.templateId),
          delayMinutes:
            Number(s.delayDays || 0) * 1440 +
            Number(s.delayHours || 0) * 60 +
            Number(s.delayMinutes || 0),
        }));
        if (
          steps.some(
            (s: { templateId: number; delayMinutes: number }) =>
              !catalog.templates.some(
                (t) => t.id === s.templateId && t.channels.includes(channel),
              ) ||
              !Number.isSafeInteger(s.delayMinutes) ||
              s.delayMinutes < 1,
          )
        ) {
          followResolved = false;
          continue;
        }
        sequences.push({ channel, steps });
      }
      // Preserve approved template-driven steps; generic AI/custom-body legacy
      // reminders remain unconfigured for review rather than broadening access.
      if (followResolved)
        draft.followUps = {
          mode: sequences.length ? "selected" : "none",
          sequences,
        };
      // Existing runtime used business-wide knowledge/media. Enumerate approved resources explicitly, but require review before publishing.
      for (const key of ["knowledge", "documents", "galleries"] as const)
        draft[key] = {
          mode: catalog[key].length ? "selected" : "none",
          ids: catalog[key].map((r) => r.id),
        };
      const id = randomUUID();
      await db.transaction(async (tx: Executor) => {
        const imported =
          await tx.execute(sql`INSERT INTO outreach_assistants(id,user_id,draft,state,legacy_config_id,migration_review_required)
          VALUES(${id}::uuid,${scope.userId},${JSON.stringify(draft)}::jsonb,'paused',${Number(row.id)},TRUE)
          ON CONFLICT(business_profile_id,legacy_config_id) DO NOTHING RETURNING id`);
        if (imported.rows.length)
          await audit(tx, id, "import_legacy", {
            legacyConfigId: row.id,
            requiresReview: true,
            ambiguousLegacyMapping: rows.rows.length !== 1,
            unresolvedFollowUps: !followResolved,
            importedBindingCount: draft.bindings.length,
          });
      });
    }
    return this.list();
  },
};
