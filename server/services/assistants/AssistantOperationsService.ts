import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { businessAuditActor, requireBusinessScope } from '../../tenancy/businessContext.js';
import { ASSISTANT_CHANNELS, type AssistantChannel } from '../../../shared/outreachAssistants.js';
import type { AssistantActivity, AssistantConversationContext, AssistantOperationalReport, AssistantTestScenario } from '../../../shared/assistantOperations.js';
import { assistantRow, assistantService, AssistantManagementError } from './AssistantService.js';
import { assistantCatalog, assistantPlatformReadiness } from './AssistantCatalogService.js';
import { assistantReadiness } from './AssistantConfiguration.js';
import { assistantsRuntimeEnabled } from './AssistantContext.js';
import { redactPiiWithStableTokens } from '../agents/orchestration/PrivacyVaultService.js';
import { boundedPageLimit, encodeAssistantCursor, decodeAssistantCursor } from './AssistantPagination.js';
import { parsePositiveId as provenanceNumber } from '../../utils/paramParsers.js';

type Row = Record<string, any>;
type Query = Record<string, unknown>;
const safeText = (value: unknown) => typeof value === 'string' ? redactPiiWithStableTokens(value.slice(0, 8000)).redactedText : null;
const iso = (value: any): string => new Date(value).toISOString();
function channelFilter(value: unknown): string | null {
  if (value === undefined || value === '' || value === 'all') return null;
  if (typeof value !== 'string' || !ASSISTANT_CHANNELS.includes(value as AssistantChannel)) throw new AssistantManagementError('Invalid channel filter.');
  return value;
}
function activity(row: Row): AssistantActivity {
  return {
    key: row.key, id: Number(row.id), kind: row.kind, conversationId: Number(row.conversation_id), channel: row.channel,
    accountId: row.account_id || null, status: row.status, createdAt: iso(row.created_at), scheduledAt: row.scheduled_at ? iso(row.scheduled_at) : null,
    content: safeText(row.content), reason: safeText(row.reason), providerMessageId: row.provider_message_id || null,
    assistantId: row.assistant_id || null, assistantRevision: provenanceNumber(row.assistant_revision), step: provenanceNumber(row.step),
    resourceId: provenanceNumber(row.resource_id),
  };
}

/** Every arm carries both owner and profile predicates; no ambiguous legacy chat IDs. */
async function activityPage(query: Query, assistantId: string | null, conversationId: number | null) {
  const scope = requireBusinessScope(), limit = boundedPageLimit(query.limit), channel = channelFilter(query.channel);
  const status = query.status === undefined || query.status === '' || query.status === 'all' ? null : String(query.status);
  if (status && !/^[a-z_]{1,40}$/.test(status)) throw new AssistantManagementError('Invalid status filter.');
  const source = `activity:${scope.businessProfileId}:${assistantId || conversationId}:${channel || ''}:${status || ''}`;
  const cursor = decodeAssistantCursor(query.cursor, source);
  const rows = await db.execute(sql`WITH activity AS (
    SELECT 'message:'||m.id::text AS key,m.id::bigint,'message'::text AS kind,m.conversation_id,c.channel,c.provider_account_id AS account_id,m.status,
      m.created_at AT TIME ZONE 'UTC' AS created_at,NULL::timestamptz AS scheduled_at,COALESCE(m.redacted_content,m.content) AS content,m.error_message AS reason,
      m.provider_message_id,m.metadata->'assistant'->>'assistantId' AS assistant_id,m.metadata->'assistant'->>'revision' AS assistant_revision,
      m.follow_up_step::text AS step,NULL::integer AS resource_id
    FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id AND c.business_profile_id=m.business_profile_id AND c.user_id=m.user_id
    WHERE m.user_id=${scope.userId} AND m.business_profile_id=${scope.businessProfileId}
      AND (${conversationId}::integer IS NULL OR m.conversation_id=${conversationId})
      AND (${assistantId}::text IS NULL OR (m.message_kind='follow_up' AND m.metadata->'assistant'->>'assistantId'=${assistantId}))
    UNION ALL
    SELECT 'schedule:'||s.id::text,s.id,'schedule',s.conversation_id,c.channel,c.provider_account_id,s.status,s.updated_at,s.next_run_at,
      'Support follow-up schedule',s.cancellation_reason,NULL,s.assistant_provenance->>'assistantId',s.assistant_provenance->>'revision',(s.next_step+1)::text,NULL
    FROM outreach_assistant_follow_up_schedules s JOIN outreach_conversations c ON c.id=s.conversation_id AND c.business_profile_id=s.business_profile_id AND c.user_id=s.user_id
    WHERE s.user_id=${scope.userId} AND s.business_profile_id=${scope.businessProfileId}
      AND (${conversationId}::integer IS NULL OR s.conversation_id=${conversationId}) AND (${assistantId}::text IS NULL OR s.assistant_provenance->>'assistantId'=${assistantId})
    UNION ALL
    SELECT 'delivery:'||d.id::text,d.id,'delivery',d.conversation_id,d.channel,COALESCE(d.payload->'metadata'->'assistant'->>'accountId',c.provider_account_id),d.status,
      d.updated_at AT TIME ZONE 'UTC',COALESCE(d.next_attempt_at,d.available_at) AT TIME ZONE 'UTC',
      CASE WHEN d.payload->'metadata'->>'dispatchKind'='support_document' THEN 'Approved PDF delivery' WHEN d.payload->'metadata'->>'dispatchKind'='proposal_delivery' THEN 'Proposal delivery' ELSE d.payload->>'text' END,
      d.last_error,d.provider_message_id,d.payload->'metadata'->'assistant'->>'assistantId',d.payload->'metadata'->'assistant'->>'revision',NULL,NULL
    FROM support_delivery_outbox d LEFT JOIN outreach_conversations c ON c.id=d.conversation_id AND c.business_profile_id=d.business_profile_id AND c.user_id=d.user_id
    WHERE d.user_id=${scope.userId} AND d.business_profile_id=${scope.businessProfileId}
      AND (${conversationId}::integer IS NULL OR d.conversation_id=${conversationId})
      AND (${assistantId}::text IS NULL OR (d.payload->'metadata'->>'dispatchKind'='assistant_follow_up' AND d.payload->'metadata'->'assistant'->>'assistantId'=${assistantId}))
    UNION ALL
    SELECT 'playbook:'||r.id::text,r.id,'playbook',r.conversation_id,c.channel,c.provider_account_id,r.status,r.updated_at AT TIME ZONE 'UTC',NULL,
      p.name,NULL,NULL,r.state->>'assistantId',r.state->>'assistantRevision',NULL,NULL
    FROM support_playbook_runs r JOIN outreach_conversations c ON c.id=r.conversation_id AND c.business_profile_id=r.business_profile_id AND c.user_id=r.user_id
    JOIN support_playbooks p ON p.id=r.playbook_id AND p.business_profile_id=r.business_profile_id AND p.user_id=r.user_id
    WHERE ${conversationId}::integer IS NOT NULL AND r.conversation_id=${conversationId} AND r.user_id=${scope.userId} AND r.business_profile_id=${scope.businessProfileId}
    UNION ALL
    SELECT 'approval:'||a.id::text,a.id::bigint,'approval',a.thread_id,c.channel,c.provider_account_id,a.status,a.updated_at AT TIME ZONE 'UTC',NULL,
      'Approval: '||a.tool_name,a.resume_error,NULL,a.assistant_provenance->>'assistantId',a.assistant_provenance->>'revision',NULL,NULL
    FROM tool_approvals a JOIN outreach_conversations c ON c.id=a.thread_id AND c.business_profile_id=a.business_profile_id AND c.user_id=a.user_id
    WHERE ${conversationId}::integer IS NOT NULL AND a.thread_id=${conversationId} AND a.user_id=${scope.userId} AND a.business_profile_id=${scope.businessProfileId}
      AND (a.resume_payload->>'conversationId'=c.id::text OR (a.assistant_provenance->>'accountId'=c.provider_account_id AND a.assistant_provenance->>'channel'=c.channel))
    UNION ALL
    SELECT 'proposal:'||p.id::text,p.id::bigint,'proposal',p.outreach_conversation_id,c.channel,c.provider_account_id,p.status,p.updated_at AT TIME ZONE 'UTC',NULL,
      p.title,NULL,NULL,NULL,NULL,NULL,p.id
    FROM proposals p JOIN outreach_conversations c ON c.id=p.outreach_conversation_id AND c.business_profile_id=p.business_profile_id AND c.user_id=p.user_id
    WHERE ${conversationId}::integer IS NOT NULL AND p.outreach_conversation_id=${conversationId} AND p.user_id=${scope.userId} AND p.business_profile_id=${scope.businessProfileId}
    UNION ALL
    SELECT 'session:start:'||c.id::text,c.id::bigint,'session',c.id,c.channel,c.provider_account_id,'started',c.created_at AT TIME ZONE 'UTC',NULL,
      'Conversation session started',NULL,NULL,NULL,NULL,NULL,NULL
    FROM outreach_conversations c WHERE ${conversationId}::integer IS NOT NULL AND c.id=${conversationId} AND c.user_id=${scope.userId} AND c.business_profile_id=${scope.businessProfileId}
    UNION ALL
    SELECT 'session:end:'||c.id::text,c.id::bigint,'session',c.id,c.channel,c.provider_account_id,'ended',c.session_ended_at AT TIME ZONE 'UTC',NULL,
      'Conversation session ended',NULL,NULL,NULL,NULL,NULL,NULL
    FROM outreach_conversations c WHERE ${conversationId}::integer IS NOT NULL AND c.id=${conversationId} AND c.user_id=${scope.userId}
      AND c.business_profile_id=${scope.businessProfileId} AND c.session_ended_at IS NOT NULL
  ) SELECT * FROM activity WHERE (${channel}::text IS NULL OR channel=${channel}) AND (${status}::text IS NULL OR status=${status})
    ${cursor ? sql`AND (date_trunc('milliseconds',created_at),key)<(${cursor.date}::timestamptz,${cursor.key})` : sql``}
    ORDER BY date_trunc('milliseconds',created_at) DESC,key DESC LIMIT ${limit + 1}`);
  const items = rows.rows.slice(0, limit).map(activity), last = items.at(-1);
  return { items, nextCursor: rows.rows.length > limit && last ? encodeAssistantCursor(last.createdAt,last.key,source) : null };
}

export const assistantOperations = {
  async history(id: string, query: Query) {
    await assistantRow(id);
    const page = await activityPage(query,id,null);
    return { history: page.items, nextCursor: page.nextCursor };
  },
  async revisions(id: string, query: Query) {
    const assistant = await assistantRow(id), scope = requireBusinessScope(), limit = boundedPageLimit(query.limit);
    const before = query.cursor === undefined ? null : Number(query.cursor);
    if (before !== null && (!Number.isSafeInteger(before) || before < 1 || before > 2147483647)) throw new AssistantManagementError('Invalid revision cursor.');
    const rows = await db.execute(sql`SELECT revision,published_at,configuration FROM outreach_assistant_revisions
      WHERE assistant_id=${id}::uuid AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
      AND (${before}::integer IS NULL OR revision<${before}) ORDER BY revision DESC LIMIT ${limit + 1}`);
    const items = rows.rows.slice(0,limit).map((r: Row) => ({revision:Number(r.revision),publishedAt:iso(r.published_at),configuration:r.configuration,current:Number(r.revision)===Number(assistant.published_revision)}));
    return {items,nextCursor:rows.rows.length>limit ? String(items.at(-1)!.revision) : null};
  },
  async scenarios(id: string) {
    await assistantRow(id);
    const scope = requireBusinessScope();
    const rows = await db.execute(sql`SELECT * FROM (SELECT DISTINCT ON (details->>'id') action,details,created_at FROM outreach_assistant_audit
      WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND assistant_id=${id}::uuid
      AND action IN ('scenario_saved','scenario_deleted') ORDER BY details->>'id',id DESC) current
      WHERE action='scenario_saved' ORDER BY created_at DESC LIMIT 100`);
    return {items:rows.rows.map((r: Row) => ({...r.details,updatedAt:iso(r.created_at)})) as AssistantTestScenario[]};
  },
  async saveScenario(id: string, input: any) {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length>120 || !ASSISTANT_CHANNELS.includes(input.channel)
      || !Array.isArray(input.messages) || input.messages.length<1 || input.messages.length>20 || input.messages.some((m: unknown) => typeof m!=='string' || !m.trim() || m.length>8000))
      throw new AssistantManagementError('Provide a scenario name, channel, and 1–20 bounded messages.');
    const expected=input.expected || {};
    if (!Array.isArray(expected.replyIncludes || []) || (expected.replyIncludes || []).length>20 || (expected.replyIncludes || []).some((v: any) => typeof v!=='string' || v.length>500)
      || (expected.outcome != null && (typeof expected.outcome!=='string' || !/^[a-z_]{1,80}$/.test(expected.outcome)))
      || (expected.playbookId != null && (typeof expected.playbookId!=='number' || !Number.isSafeInteger(expected.playbookId) || expected.playbookId<1 || expected.playbookId>2147483647))) throw new AssistantManagementError('Invalid scenario assertions.');
    const scenario: Omit<AssistantTestScenario,'updatedAt'> = {id:input.id || randomUUID(),name:safeText(input.name.trim())!,channel:input.channel,messages:input.messages.map(safeText),
      expected:{replyIncludes:(expected.replyIncludes || []).map(safeText),outcome:expected.outcome || null,playbookId:expected.playbookId || null}};
    if (typeof scenario.id!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scenario.id)) throw new AssistantManagementError('Invalid scenario ID.');
    await db.transaction(async (tx: Pick<typeof db,'execute'>) => {
      await assistantRow(id,tx,true);
      const current=await this.scenarios(id);
      if (input.id && !current.items.some(s=>s.id===scenario.id)) throw new AssistantManagementError('Scenario not found.',404);
      if (!input.id && current.items.length>=100) throw new AssistantManagementError('Remove a scenario before saving more than 100.',409);
      const scope=requireBusinessScope();
      await tx.execute(sql`INSERT INTO outreach_assistant_audit(user_id,assistant_id,actor_user_id,action,details)
        VALUES(${scope.userId},${id}::uuid,${businessAuditActor(scope.userId)},'scenario_saved',${JSON.stringify(scenario)}::jsonb)`);
    });
    return (await this.scenarios(id)).items.find(s=>s.id===scenario.id)!;
  },
  async deleteScenario(id: string, scenarioId: string) {
    await assistantRow(id);
    if (!(await this.scenarios(id)).items.some(s=>s.id===scenarioId)) throw new AssistantManagementError('Scenario not found.',404);
    const scope=requireBusinessScope();
    await db.execute(sql`INSERT INTO outreach_assistant_audit(user_id,assistant_id,actor_user_id,action,details)
      VALUES(${scope.userId},${id}::uuid,${businessAuditActor(scope.userId)},'scenario_deleted',${JSON.stringify({id:scenarioId})}::jsonb)`);
  },
  async reviewGap(id: string, input: any) {
    await assistantRow(id);
    if (!input || !/^[a-f0-9]{40}$/.test(input.key) || !['open','reviewed'].includes(input.review) || (input.note != null && (typeof input.note!=='string' || input.note.length>2000)))
      throw new AssistantManagementError('Invalid knowledge gap review.');
    const scope=requireBusinessScope();
    await db.execute(sql`INSERT INTO outreach_assistant_audit(user_id,assistant_id,actor_user_id,action,details)
      VALUES(${scope.userId},${id}::uuid,${businessAuditActor(scope.userId)},'knowledge_gap_review',${JSON.stringify({key:input.key,review:input.review,note:safeText(input.note)})}::jsonb)`);
    return {review:input.review};
  },
  async conversation(id: number, query: Query) {
    if (!Number.isSafeInteger(id) || id<1 || id>2147483647) throw new AssistantManagementError('A canonical outreach conversation is required.');
    const scope=requireBusinessScope();
    const rows=await db.execute(sql`SELECT * FROM outreach_conversations WHERE id=${id} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}`);
    const c=rows.rows[0];
    if (!c) throw new AssistantManagementError('Conversation not found in this business.',404);
    const [binding,run,schedule,page]=await Promise.all([
      db.execute(sql`SELECT b.assistant_id,b.revision,a.state,r.configuration->>'name' AS name FROM outreach_assistant_bindings b
        JOIN outreach_assistants a ON a.id=b.assistant_id AND a.user_id=b.user_id AND a.business_profile_id=b.business_profile_id
        JOIN outreach_assistant_revisions r ON r.assistant_id=b.assistant_id AND r.revision=b.revision AND r.business_profile_id=b.business_profile_id
        WHERE b.user_id=${scope.userId} AND b.business_profile_id=${scope.businessProfileId} AND b.channel=${c.channel} AND b.surface='private'
        AND b.account_id=${c.provider_account_id || ''} AND b.enabled AND a.state='live' AND a.published_revision=b.revision LIMIT 1`),
      db.execute(sql`SELECT r.playbook_id,p.name,r.current_node_id,r.status FROM support_playbook_runs r JOIN support_playbooks p
        ON p.id=r.playbook_id AND p.user_id=r.user_id AND p.business_profile_id=r.business_profile_id WHERE r.user_id=${scope.userId}
        AND r.business_profile_id=${scope.businessProfileId} AND r.conversation_id=${id} AND r.status='active' ORDER BY r.updated_at DESC LIMIT 1`),
      db.execute(sql`SELECT status,next_run_at FROM outreach_assistant_follow_up_schedules WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
        AND conversation_id=${id} AND status IN ('active','queued','uncertain') LIMIT 1`),
      activityPage(query,null,id),
    ]);
    const b=assistantsRuntimeEnabled()?binding.rows[0]:null, p=run.rows[0], s=schedule.rows[0];
    const context: AssistantConversationContext={assistantId:b?String(b.assistant_id):null,name:b?.name || null,revision:b?Number(b.revision):null,
      channel:String(c.channel),accountId:c.provider_account_id || null,mode:String(c.automation_mode || 'ai_active'),sessionStatus:c.session_ended_at?'ended':String(c.status),
      playbook:p?{id:Number(p.playbook_id),name:String(p.name),nodeId:p.current_node_id || null,status:String(p.status)}:null,
      followUp:s?{status:String(s.status),scheduledAt:s.next_run_at?iso(s.next_run_at):null}:null};
    return {...page,context};
  },
  async diagnostics(query: Query): Promise<AssistantOperationalReport> {
    const scope=requireBusinessScope(), channel=channelFilter(query.channel), days=query.days===undefined?30:Number(query.days);
    const canViewCosts=(scope.actorUserId ?? scope.userId)===scope.userId;
    if (!Number.isInteger(days) || days<1 || days>90) throw new AssistantManagementError('Choose a reporting period from 1 to 90 days.');
    const id=query.assistantId===undefined || query.assistantId==='all' || query.assistantId===''?null:String(query.assistantId);
    if (id) await assistantRow(id);
    const account=query.accountId===undefined || query.accountId==='all' || query.accountId===''?null:String(query.accountId);
    if (account && account.length>255) throw new AssistantManagementError('Invalid account filter.');
    const [catalog,platform,auditRows,reviews,costRows]=await Promise.all([
      assistantCatalog(),assistantPlatformReadiness(),
      db.execute(sql`SELECT l.trace->'resolvedAssistant'->>'assistantId' AS assistant_id,l.trace->'resolvedAssistant'->>'revision' AS revision,
        l.channel,l.provider_name,l.provider_model,l.intent,
        max(l.created_at) AT TIME ZONE 'UTC' AS created_at,to_char(l.created_at,'YYYY-MM-DD') AS day,
        count(*) AS calls,sum(COALESCE(l.llm_tokens_used,0)) AS tokens,
        count(*) FILTER (WHERE l.outcome='auto_sent') AS replies,count(*) FILTER (WHERE l.outcome IN ('error','blocked','failed')) AS failures,
        count(*) FILTER (WHERE l.outcome='human_handoff') AS handoffs,
        sum(l.duration_ms) AS duration_sum,count(l.duration_ms) AS duration_count,sum(l.confidence) AS confidence_sum,count(l.confidence) AS confidence_count,
        (array_agg(DISTINCT l.conversation_id) FILTER (WHERE l.conversation_id>0))[1:20] AS conversation_ids,
        (array_agg(DISTINCT l.trace->>'redactedQuestion') FILTER (WHERE l.trace->>'redactedQuestion' IS NOT NULL))[1:3] AS question_samples,
        l.trace->>'knowledgeRetrievalStatus' AS retrieval,l.trace->>'knowledgeUncertaintyReply' AS uncertainty,
        l.trace->'answerVerification'->>'mayDeliver' AS verified,l.trace->'rejectedKnowledgeVerification' IS NOT NULL AND l.trace->'rejectedKnowledgeVerification'<>'null'::jsonb AS rejected,
        l.trace->'resolvedAssistant'->>'accountId' AS account_id
        FROM agent_audit_logs l WHERE l.user_id=${scope.userId} AND l.business_profile_id=${scope.businessProfileId}
        AND l.created_at>=(NOW()-${days}*INTERVAL '1 day') AT TIME ZONE 'UTC' AND l.decision_status='finalized'
        AND COALESCE(l.trace->>'executionMode','customer') NOT IN ('preview','advisory') AND COALESCE(l.trace->>'simulated','false')<>'true'
        AND l.trace->'resolvedAssistant'->>'assistantId' IS NOT NULL
        AND (${id}::text IS NULL OR l.trace->'resolvedAssistant'->>'assistantId'=${id})
        AND (${channel}::text IS NULL OR l.channel=${channel}) AND (${account}::text IS NULL OR l.trace->'resolvedAssistant'->>'accountId'=${account})
        GROUP BY l.trace->'resolvedAssistant'->>'assistantId',l.trace->'resolvedAssistant'->>'revision',l.channel,l.provider_name,l.provider_model,l.intent,
          to_char(l.created_at,'YYYY-MM-DD'),l.trace->>'knowledgeRetrievalStatus',l.trace->>'knowledgeUncertaintyReply',l.trace->'resolvedAssistant'->>'accountId',
          l.trace->'answerVerification'->>'mayDeliver',l.trace->'rejectedKnowledgeVerification'
        ORDER BY max(l.created_at) DESC`),
      db.execute(sql`SELECT DISTINCT ON (assistant_id,details->>'key') assistant_id,details,created_at FROM outreach_assistant_audit
        WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND action='knowledge_gap_review'
        ORDER BY assistant_id,details->>'key',id DESC`),
      db.execute(sql`WITH usage AS (
        SELECT metadata,provider,model,total_tokens,estimated_cost_cents,created_at,user_id,business_profile_id FROM openai_usages
        WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND created_at>=(NOW()-${days}*INTERVAL '1 day') AT TIME ZONE 'UTC'
      ) SELECT metadata->'_assistant'->>'assistantId' AS assistant_id,metadata->'_assistant'->>'revision' AS revision,provider,model,
        count(*) AS calls,sum(COALESCE(total_tokens,0)) AS tokens,CASE WHEN ${canViewCosts} THEN sum(estimated_cost_cents)::numeric/100 END AS cost,
        CASE WHEN ${canViewCosts} THEN count(estimated_cost_cents) ELSE 0 END AS cost_recorded_calls
        FROM usage WHERE metadata->'_assistant'->>'businessProfileId'=${String(scope.businessProfileId)} AND metadata->'_assistant'->>'preview'='false'
        AND (${id}::text IS NULL OR metadata->'_assistant'->>'assistantId'=${id})
        AND (${channel}::text IS NULL OR metadata->'_assistant'->>'channel'=${channel}) AND (${account}::text IS NULL OR metadata->'_assistant'->>'accountId'=${account})
        GROUP BY metadata->'_assistant'->>'assistantId',metadata->'_assistant'->>'revision',provider,model`),
    ]);
    const assistants=await assistantService.list({catalog,platform});
    const byId=new Map(assistants.map(a=>[a.id,a])), runtimeEnabled=assistantsRuntimeEnabled();
    const assignments=catalog.accounts.filter(a=>a.connected&&(!channel||a.channel===channel)&&(!account||a.accountId===account)&&(!id||a.assignedAssistantId===id)).map(a=>{
      const assistant=a.assignedAssistantId?byId.get(a.assignedAssistantId):null;
      const checks=assistant?.published?assistantReadiness(assistant.published,catalog,platform,assistant.enabledBindings).checks:[];
      return {...a,assistantId:assistant?.id || null,assistantName:assistant?.published?.name || assistant?.draft.name || null,revision:assistant?.publishedRevision || null,
        state:assistant?.state || 'unassigned' as const,runtimeEnabled,checks};
    });
    const metrics=new Map<string,any>(),usage=new Map<string,any>(),gaps=new Map<string,any>();
    for (const l of auditRows.rows as Row[]) {
      if (!byId.has(l.assistant_id)) continue;
      const name=byId.get(l.assistant_id)!.published?.name || byId.get(l.assistant_id)!.draft.name, day=l.day;
      const metricKey=JSON.stringify([l.assistant_id,l.channel,l.account_id,day]);
      const m=metrics.get(metricKey)||{assistantId:l.assistant_id,name,channel:l.channel,accountId:l.account_id || null,day,replies:0,failures:0,handoffs:0,durationSum:0,durationCount:0,confidenceSum:0,confidenceCount:0};
      m.replies+=Number(l.replies);m.failures+=Number(l.failures);m.handoffs+=Number(l.handoffs);
      m.durationSum+=Number(l.duration_sum || 0);m.durationCount+=Number(l.duration_count);m.confidenceSum+=Number(l.confidence_sum || 0);m.confidenceCount+=Number(l.confidence_count);metrics.set(metricKey,m);
      if (l.provider_name && l.provider_model) {
        const usageKey=JSON.stringify([l.assistant_id,l.revision,l.provider_name,l.provider_model]);
        const u=usage.get(usageKey)||{assistantId:l.assistant_id,revision:provenanceNumber(l.revision)||0,provider:l.provider_name,model:l.provider_model,calls:0,totalTokens:0,cost:null,currency:null,source:'reply_audit',costRecordedCalls:0};
        u.calls+=Number(l.calls);u.totalTokens+=Number(l.tokens || 0);usage.set(usageKey,u);
      }
      if (l.uncertainty==='true'||l.verified==='false'||l.rejected===true||['unavailable','retrieval_unavailable','conflict_detected','stale_only'].includes(l.retrieval)) {
        const intent=safeText(l.intent)||'unclassified',reason=l.retrieval==='conflict_detected'?'Assigned knowledge contains conflicting information: review and reconcile the published sources.':l.retrieval==='stale_only'?'Only stale knowledge was found: refresh and republish the source.':['unavailable','retrieval_unavailable'].includes(l.retrieval)?'Knowledge service unavailable: investigate retrieval health.':'Answer could not be verified against assigned knowledge.';
        const key=createHash('sha1').update(JSON.stringify([l.assistant_id,intent,reason])).digest('hex');
        const review=reviews.rows.find((r: Row)=>String(r.assistant_id)===l.assistant_id&&r.details.key===key);
        const g=gaps.get(key)||{key,assistantId:l.assistant_id,assistantName:name,intent,count:0,latestAt:iso(l.created_at),conversationIds:[],conversations:[],dailyCounts:[],questionSamples:[],reason,
          review:review&&iso(review.created_at)>=iso(l.created_at)?review.details.review:'open',note:safeText(review?.details.note)};
        g.count+=Number(l.calls);
        const daily=g.dailyCounts.find((item: {day:string})=>item.day===day);
        if(daily) daily.count+=Number(l.calls); else g.dailyCounts.push({day,count:Number(l.calls)});
        for(const sample of l.question_samples || []) {const text=safeText(sample);if(text&&!g.questionSamples.includes(text)&&g.questionSamples.length<3) g.questionSamples.push(text);}
        for(const conversationId of l.conversation_ids || []) if(!g.conversationIds.includes(Number(conversationId))&&g.conversationIds.length<20) {
          g.conversationIds.push(Number(conversationId));g.conversations.push({id:Number(conversationId),channel:l.channel});
        } gaps.set(key,g);
      }
    }
    for (const row of costRows.rows as Row[]) if(byId.has(row.assistant_id)) {
      const key=JSON.stringify([row.assistant_id,row.revision,row.provider,row.model]);
      usage.set(key,{assistantId:row.assistant_id,revision:provenanceNumber(row.revision)||0,provider:row.provider,model:row.model,calls:Number(row.calls),totalTokens:Number(row.tokens),
        cost:row.cost==null?null:Number(row.cost),currency:row.cost==null?null:'USD',source:'model_usage',costRecordedCalls:Number(row.cost_recorded_calls)});
    }
    return {days,assignments,metrics:[...metrics.values()].map(({durationSum,durationCount,confidenceSum,confidenceCount,...m})=>({...m,averageDurationMs:durationCount?durationSum/durationCount:null,averageConfidence:confidenceCount?confidenceSum/confidenceCount:null})),
      knowledgeGaps:[...gaps.values()],usage:[...usage.values()]};
  },
};
