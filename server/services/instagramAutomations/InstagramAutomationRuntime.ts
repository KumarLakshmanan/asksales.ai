import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { CustomerDeliverySetupError, deliverySetupFailure } from '../assistants/CustomerDeliveryGate.js';
import { db } from '../../models/db.js';
import { withBusinessScope, withSystemScope } from '../../tenancy/businessContext.js';
import { currentBillingScope, withBillingScope } from '../../tenancy/billingContext.js';
import { captureJobBusiness } from '../../tenancy/jobBusinessScope.js';
import { BillingOrganizationError } from '../billing/organizations.js';
import { jobDispatcher } from '../../queues/JobDispatcher.js';
import { logger } from '../../utils/logger.js';
import {
  emptyInstagramMessage,
  matchInstagramRule,
  renderInstagramText,
  instagramFollowPrompt,
  instagramFollowRetryMessage,
  type InstagramMessage,
  type InstagramRuleDefinition,
} from '../../../shared/instagramAutomations.js';
import {
  automationScope,
  getInstagramProfile,
  listInstagramRules,
  recoverInstagramProfilePublications,
} from './InstagramAutomationConfiguration.js';
import {
  InstagramAutomationError,
  InstagramProviderError,
  InstagramAutomationProvider,
  instagramAutomationsEnabled,
  requireInstagramAutomationAccount,
} from './InstagramAutomationProvider.js';

interface Input {
  providerAccountId?: string;
  externalSenderId: string;
  messageId: string;
  messageText: string;
  eventType: string;
  timestamp?: number;
  senderName?: string;
  rawData: Record<string, any>;
}
interface Context {
  commentId?: string;
  mediaId?: string;
  keyword?: string;
  username?: string;
  name?: string;
  occurredAt: number;
  parentId?: number;
  reelLookupUnconfirmed?: boolean;
  notBefore?: number;
  suppressAI?: boolean;
  queueIdentity?: QueueIdentity;
}
interface QueueIdentity {
  version: 1;
  userId: number;
  businessProfileId: number;
  businessActorUserId: number;
  billingOrganizationId: number;
  billingActorUserId: number;
}
type Definition =
  | InstagramRuleDefinition
  | { kind: 'menu'; message: InstagramMessage }
  | { kind: 'follow_check'; parentId: number }
  | { kind: 'unmatched' };
interface Run {
  id: number;
  user_id: number;
  business_profile_id: number;
  account_id: string;
  source_key: string;
  rule_id: number | null;
  rule_name: string;
  definition: Definition;
  context: Context;
  conversation_id: number;
  sender_id: string;
  recipient_id: string | null;
  status: string;
  private_message_id: string | null;
  public_message_id: string | null;
  updated_at: Date;
}
const scopeWhere = (userId: number) => {
  const s = automationScope(userId);
  return sql`user_id=${userId} AND business_profile_id=${s.businessProfileId}`;
};
class InstagramQueueIdentityError extends InstagramAutomationError {}
function queueIdentity(value: unknown, userId: number, businessProfileId: number): QueueIdentity {
  const identity = value as Partial<QueueIdentity> | undefined;
  if (!identity || identity.version !== 1 || identity.userId !== userId ||
    identity.businessProfileId !== businessProfileId ||
    ![identity.userId, identity.businessProfileId, identity.businessActorUserId,
      identity.billingOrganizationId, identity.billingActorUserId].every(id => Number.isSafeInteger(id) && Number(id) > 0))
    throw new InstagramQueueIdentityError('The original execution identity is missing or inconsistent. Delivery is blocked; review this run.', 409);
  return identity as QueueIdentity;
}
function assertExecutionIdentity(run: Run) {
  const origin = queueIdentity(run.context?.queueIdentity, run.user_id, run.business_profile_id);
  const business = automationScope(run.user_id), billing = currentBillingScope();
  if ((business.actorUserId ?? business.userId) !== origin.businessActorUserId ||
    !billing || billing.organizationId !== origin.billingOrganizationId || billing.actorUserId !== origin.billingActorUserId ||
    (billing.businessProfileId !== undefined && billing.businessProfileId !== origin.businessProfileId) ||
    (billing.businessOwnerUserId !== undefined && billing.businessOwnerUserId !== origin.userId))
    throw new InstagramQueueIdentityError('The queued execution identity conflicts with its original run. Delivery is blocked; review this run.', 409);
}
async function blockQueuedIdentity(run: Run, reason: string) {
  await db.execute(sql`UPDATE instagram_automation_runs AS blocked SET
    status=CASE WHEN EXISTS(SELECT 1 FROM instagram_automation_effects e WHERE e.run_id=blocked.id
      AND e.user_id=blocked.user_id AND e.business_profile_id=blocked.business_profile_id AND e.status IN ('sending','uncertain'))
      THEN 'uncertain' ELSE 'failed' END,reason=${reason},claimed_at=NULL,updated_at=now()
    WHERE ${scopeWhere(run.user_id)} AND id=${run.id} AND status='queued'`);
}
async function enqueue(userId: number, runId: number) {
  const run = await loadRun(userId, runId);
  if (!run || run.status !== 'queued') return;
  try {
    const identity = queueIdentity(run.context?.queueIdentity, run.user_id, run.business_profile_id);
    const { version: _version, ...origin } = identity;
    // Capture must see the durable origin, never the recovery inventory owner.
    return await withBusinessScope({ userId, businessProfileId: identity.businessProfileId, actorUserId: identity.businessActorUserId }, () =>
      withBillingScope({ organizationId: identity.billingOrganizationId, actorUserId: identity.billingActorUserId,
        businessProfileId: identity.businessProfileId, businessOwnerUserId: userId }, () =>
        jobDispatcher.dispatch('process_instagram_automation', { ...origin, runId })));
  } catch (error) {
    if (error instanceof InstagramQueueIdentityError || error instanceof BillingOrganizationError ||
      (error instanceof Error && (error as Error & { status?: number }).status === 403)) {
      await blockQueuedIdentity(run, error instanceof InstagramQueueIdentityError ? error.message
        : 'The original execution identity is no longer authorized. Delivery is blocked; review this run.');
      return;
    }
    throw error;
  }
}
async function loadRun(userId: number, id: number): Promise<Run | undefined> {
  return (
    await db.execute(
      sql`SELECT * FROM instagram_automation_runs WHERE ${scopeWhere(userId)} AND id=${id}`
    )
  ).rows[0];
}
async function finish(run: Run, status: string, reason: string | null = null) {
  await db.execute(sql`UPDATE instagram_automation_runs SET status=${status},reason=${reason},claimed_at=NULL,updated_at=now() WHERE ${scopeWhere(run.user_id)} AND id=${run.id}
    AND NOT (status='sent' AND ${status}<>'sent')
    AND NOT (status IN ('fulfilling','failed','uncertain') AND ${status}='waiting_follow' AND context->>'fulfilling'='true')`);
}
export function instagramPostbackMessageId(event: {
  postback?: { mid?: string; payload?: string };
  sender?: { id?: string };
  timestamp?: number;
}): string {
  return (
    event.postback?.mid ||
    `ig-postback-${createHash('sha256')
      .update(JSON.stringify([event.sender?.id, event.timestamp, event.postback?.payload]))
      .digest('hex')}`
  );
}
export async function instagramPostbackText(
  userId: number,
  accountId: string,
  payload: string,
  fallback: string
): Promise<string> {
  if (!instagramAutomationsEnabled(accountId) || !payload.startsWith('IGA_START_')) return fallback;
  const profile = await getInstagramProfile(userId, accountId, 'icebreakers');
  return (
    profile?.publishedConfig?.locales
      .flatMap((l) => l.questions)
      .find((q) => `IGA_START_${q.id}` === payload)?.question || fallback
  );
}
/** Called after canonical inbox persistence, before AI dispatch. A recorded match always wins. */
export async function ingestInstagramAutomation(
  userId: number,
  conversationId: number,
  input: Input
): Promise<boolean> {
  const accountId = input.providerAccountId;
  if (!accountId) return false;
  const scope = automationScope(userId);
  const sourceKey = `${input.eventType}:${input.messageId}`;
  const prior = (
    await db.execute(
      sql`SELECT id,status,context->>'suppressAI' AS "suppressAI" FROM instagram_automation_runs WHERE ${scopeWhere(userId)} AND account_id=${accountId} AND source_key=${sourceKey}`
    )
  ).rows[0];
  if (prior) {
    if (prior.status === 'queued') await enqueue(userId, Number(prior.id));
    return prior.status !== 'unmatched' || prior.suppressAI === 'true';
  }
  if (!['comment', 'message'].includes(input.eventType)) return false;
  const enabled = instagramAutomationsEnabled(accountId);
  const account = await requireInstagramAutomationAccount(userId, accountId);
  if (input.externalSenderId === accountId) return false;
  let definition: Definition = { kind: 'unmatched' },
    ruleId: number | null = null,
    ruleName = 'No matching rule';
  const context: Context = { occurredAt: input.timestamp || Date.now() };
  if (enabled && input.eventType === 'comment') {
    const rules = (await listInstagramRules(userId, accountId)).filter(
      (r) => r.status === 'active'
    );
    const mediaId = String(input.rawData.media?.id || input.rawData.media_id || '');
    let isReel = input.rawData.media?.media_product_type === 'REELS';
    let checkedReel = Boolean(input.rawData.media?.media_product_type);
    for (const rule of rules) {
      if (rule.definition.trigger.scope === 'reels' && !checkedReel) {
        // Specific post rules have already had their turn. Only query Meta if
        // the keywords of this Reel rule match the comment.
        if (
          !mediaId ||
          matchInstagramRule(rule.definition, {
            text: typeof input.rawData.text === 'string' ? input.rawData.text : input.messageText,
            mediaId,
            isReel: true,
          }) === null
        )
          continue;
        checkedReel = true;
        try {
          isReel = await new InstagramAutomationProvider(account).mediaIsReel(mediaId);
        } catch {
          // Claim this possible match durably so retrying the webhook cannot
          // deliver a lower-priority rule or an AI reply by accident.
          context.reelLookupUnconfirmed = true;
          isReel = true;
        }
      }
      const keyword = matchInstagramRule(rule.definition, {
        text: typeof input.rawData.text === 'string' ? input.rawData.text : input.messageText,
        mediaId,
        isReel,
      });
      if (keyword === null) continue;
      definition = rule.definition;
      ruleId = rule.id;
      ruleName = rule.definition.name;
      Object.assign(context, {
        commentId: input.messageId,
        mediaId,
        keyword,
        username: input.rawData.from?.username || input.senderName || '',
        name: input.rawData.from?.name || '',
      });
      break;
    }
  } else if (enabled && input.eventType === 'message') {
    const payload = String(
      input.rawData.automationPayload ||
        input.rawData.postback?.payload ||
        input.rawData.message?.quick_reply?.payload ||
        ''
    );
    if (payload.startsWith('IGA_MENU_')) {
      const profile = await getInstagramProfile(userId, accountId, 'menu');
      const item = profile?.publishedConfig?.locales
        .flatMap((l) => l.items)
        .find((i) => i.type === 'action' && `IGA_MENU_${i.payload}` === payload);
      if (item) {
        definition = { kind: 'menu', message: item.response };
        ruleName = `Menu: ${item.title}`;
      } else {
        definition = {
          kind: 'menu',
          message: {
            ...emptyInstagramMessage(),
            text: 'This menu option has changed. Please reopen our Instagram chat to refresh the menu, or type your question here for help.',
          },
        };
        ruleName = 'Previous menu option';
      }
    } else if (/^IGA_FOLLOW:\d+$/.test(payload) || /^done$/i.test(input.messageText.trim())) {
      const requestedId = payload.startsWith('IGA_FOLLOW:') ? Number(payload.split(':')[1]) : null;
      const waiting =
        await db.execute(sql`SELECT id,rule_id,rule_name,context FROM instagram_automation_runs WHERE ${scopeWhere(userId)} AND account_id=${accountId}
        AND status='waiting_follow' AND (recipient_id=${input.externalSenderId} OR (recipient_id IS NULL AND sender_id=${input.externalSenderId}))
        AND (${requestedId}::integer IS NULL OR id=${requestedId}) ORDER BY id DESC LIMIT 1`);
      if (waiting.rows[0]) {
        definition = { kind: 'follow_check', parentId: Number(waiting.rows[0].id) };
        ruleName = `${String(waiting.rows[0].rule_name).slice(0, 106)}: follow check`;
        ruleId = Number(waiting.rows[0].rule_id);
        context.queueIdentity = waiting.rows[0].context?.queueIdentity;
      }
    }
    if (definition.kind === 'unmatched')
      context.suppressAI = payload.startsWith('IGA_MENU_') || payload.startsWith('IGA_FOLLOW:');
  }
  // Freeze every supported event's first routing decision, including disabled
  // rollout and unmatched messages. Replays must not acquire a newer rule or
  // follow request, or turn a suppressed internal callback into an AI reply.
  if (definition.kind !== 'unmatched' && definition.kind !== 'follow_check') {
    const billing = currentBillingScope();
    if (billing && ((billing.businessProfileId !== undefined && billing.businessProfileId !== scope.businessProfileId) ||
      (billing.businessOwnerUserId !== undefined && billing.businessOwnerUserId !== userId)))
      throw new InstagramQueueIdentityError('The originating billing scope conflicts with this business. Delivery is blocked.', 409);
    const captured: Partial<QueueIdentity> = await captureJobBusiness({ userId, businessProfileId: scope.businessProfileId,
      businessActorUserId: scope.actorUserId ?? userId,
      ...(billing ? { billingOrganizationId: billing.organizationId, billingActorUserId: billing.actorUserId } : {}) });
    // This JSON belongs to this immutable run snapshot. Recovery never infers it
    // from an owner, a current default profile, or a later event's ambient scope.
    context.queueIdentity = queueIdentity({ version: 1, userId: captured.userId,
      businessProfileId: captured.businessProfileId, businessActorUserId: captured.businessActorUserId,
      billingOrganizationId: captured.billingOrganizationId, billingActorUserId: captured.billingActorUserId }, userId, scope.businessProfileId);
  }
  const row = (
    await db.execute(sql`INSERT INTO instagram_automation_runs(user_id,business_profile_id,account_id,source_key,rule_id,rule_name,definition,context,conversation_id,sender_id,status)
    VALUES(${userId},${scope.businessProfileId},${accountId},${sourceKey},${ruleId},${ruleName},${JSON.stringify(definition)}::jsonb,${JSON.stringify(context)}::jsonb,
      ${conversationId},${input.externalSenderId},${definition.kind === 'unmatched' ? 'unmatched' : 'queued'})
    ON CONFLICT(business_profile_id,user_id,account_id,source_key) DO UPDATE SET source_key=excluded.source_key RETURNING id,status,context->>'suppressAI' AS "suppressAI"`)
  ).rows[0];
  if (row.status === 'queued') await enqueue(userId, Number(row.id));
  return row.status !== 'unmatched' || row.suppressAI === 'true';
}

type Receipt = { messageId: string; recipientId?: string | null };
class PrivateReplyDeferred extends Error {
  constructor(public notBefore: number) { super('Private reply budget reached. Waiting for the next available slot.'); }
}
class InstagramAutomationSuppressed extends InstagramAutomationError {}
async function assertEffectAllowed(run: Run) {
  assertExecutionIdentity(run);
  if (!instagramAutomationsEnabled(run.account_id) || !(await ruleStillActive(run)))
    throw new InstagramAutomationSuppressed('This automation is paused or unavailable.');
  if (!(await canContact(run)))
    throw new InstagramAutomationSuppressed('The recipient is unavailable or has opted out.');
}
/** The intent commits before the network call. An ambiguous outcome is never retried. */
async function effect(run: Run, key: string, send: () => Promise<Receipt>): Promise<Receipt> {
  await assertEffectAllowed(run);
  const s = automationScope(run.user_id);
  const insertIntent = (executor: Pick<NodePgDatabase, 'execute'>) => executor.execute(sql`INSERT INTO instagram_automation_effects(user_id,business_profile_id,run_id,effect_key)
    VALUES(${run.user_id},${s.businessProfileId},${run.id},${key}) ON CONFLICT(run_id,effect_key) DO NOTHING RETURNING id`);
  const inserted = key !== 'private' ? await insertIntent(db) : await db.transaction(async (tx: Pick<NodePgDatabase, 'execute'>) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ig-private-budget:${s.businessProfileId}:${run.account_id}`},0))`);
    const existing = await tx.execute(sql`SELECT id FROM instagram_automation_effects WHERE ${scopeWhere(run.user_id)} AND run_id=${run.id} AND effect_key=${key}`);
    if (existing.rows.length) return insertIntent(tx);
    // Reserve before IO. Count all intents, including rejected/uncertain attempts, across rules and recipients.
    // Keep headroom below Meta's 750 private replies/hour for other account activity.
    const budget = await tx.execute(sql`SELECT count(*)::integer AS used,min(e.created_at) AS oldest FROM instagram_automation_effects e
      JOIN instagram_automation_runs r ON r.id=e.run_id AND r.user_id=e.user_id AND r.business_profile_id=e.business_profile_id
      WHERE e.user_id=${run.user_id} AND e.business_profile_id=${s.businessProfileId} AND r.account_id=${run.account_id}
      AND e.effect_key='private' AND e.created_at>now()-interval '1 hour'`);
    if (Number(budget.rows[0].used) >= 700) throw new PrivateReplyDeferred(new Date(budget.rows[0].oldest as string).getTime() + 3601000);
    return insertIntent(tx);
  });
  if (!inserted.rows.length) {
    const row = (
      await db.execute(
        sql`SELECT * FROM instagram_automation_effects WHERE ${scopeWhere(run.user_id)} AND run_id=${run.id} AND effect_key=${key}`
      )
    ).rows[0];
    if (row?.status === 'sent')
      return { messageId: row.provider_message_id, recipientId: row.recipient_id };
    throw new InstagramProviderError(
      row?.error || 'A previous delivery has no confirmed receipt. Review this execution.',
      row?.status !== 'failed'
    );
  }
  const id = Number(inserted.rows[0].id);
  let result: Receipt;
  try {
    // Reserving an intent can wait on another worker. Recheck after that wait,
    // and after any earlier accepted effect, immediately before provider IO.
    await assertEffectAllowed(run);
    result = await send();
  } catch (error) {
    const uncertain =
      !deliverySetupFailure(error) && (!(error instanceof InstagramAutomationError) ||
      (error instanceof InstagramProviderError && error.uncertain));
    await db.execute(
      sql`UPDATE instagram_automation_effects SET status=${uncertain ? 'uncertain' : 'failed'},error=${deliverySetupFailure(error) ? JSON.stringify(deliverySetupFailure(error)) : error instanceof InstagramAutomationError ? error.message : 'Delivery could not be confirmed.'},updated_at=now() WHERE ${scopeWhere(run.user_id)} AND id=${id}`
    );
    throw deliverySetupFailure(error) || error instanceof InstagramProviderError || error instanceof InstagramAutomationSuppressed || error instanceof InstagramQueueIdentityError
      ? error
      : new InstagramProviderError(
          error instanceof InstagramAutomationError ? error.message : 'Delivery could not be confirmed.',
          uncertain
        );
  }
  // If this commit fails, leave 'sending'; recovery will flag uncertainty instead of calling Meta again.
  await db.execute(
    sql`UPDATE instagram_automation_effects SET status='sent',provider_message_id=${result.messageId},recipient_id=${result.recipientId || null},updated_at=now() WHERE ${scopeWhere(run.user_id)} AND id=${id}`
  );
  return result;
}
async function ruleStillActive(run: Run): Promise<boolean> {
  if (!run.rule_id) return true;
  return Boolean(
    (
      await db.execute(
        sql`SELECT id FROM instagram_automation_rules WHERE ${scopeWhere(run.user_id)} AND account_id=${run.account_id} AND id=${run.rule_id} AND status='active' AND deleted_at IS NULL`
      )
    ).rows.length
  );
}
async function canContact(run: Run): Promise<boolean> {
  const rows =
    await db.execute(sql`SELECT c.status,l.do_not_contact FROM outreach_conversations c LEFT JOIN leads l ON l.id=c.lead_id AND l.user_id=c.user_id AND l.business_profile_id=c.business_profile_id
    WHERE c.id=${run.conversation_id} AND c.user_id=${run.user_id} AND c.business_profile_id=${run.business_profile_id} AND c.provider_account_id=${run.account_id}`);
  return Boolean(
    rows.rows.length && rows.rows[0].status !== 'unsubscribed' && !rows.rows[0].do_not_contact
  );
}
async function tagContact(run: Run, tags: string[]) {
  if (!tags.length) return;
  await db.execute(sql`UPDATE crm_contacts contact SET tags=(SELECT COALESCE(jsonb_agg(DISTINCT tag),'[]'::jsonb) FROM jsonb_array_elements_text(COALESCE(contact.tags,'[]'::jsonb)||${JSON.stringify(tags)}::jsonb) AS t(tag)),updated_at=now()
    FROM outreach_conversations conversation WHERE conversation.id=${run.conversation_id} AND conversation.crm_contact_id=contact.id
      AND conversation.user_id=${run.user_id} AND conversation.business_profile_id=${run.business_profile_id}
      AND contact.user_id=${run.user_id} AND contact.business_profile_id=${run.business_profile_id} AND contact.deleted_at IS NULL`);
}
async function reserveLimits(run: Run, rule: InstagramRuleDefinition): Promise<string | null> {
  return db.transaction(async (tx: Pick<NodePgDatabase, 'execute'>) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ig-recipient:${run.business_profile_id}:${run.account_id}:${run.sender_id}`},0))`
    );
    const already = await tx.execute(
      sql`SELECT id FROM instagram_automation_effects WHERE ${scopeWhere(run.user_id)} AND run_id=${run.id} AND effect_key=${rule.kind === 'comment_dm' ? 'private' : 'public'} AND status='sent'`
    );
    if (already.rows.length) return null;
    const rows = await tx.execute(sql`SELECT count(*) FILTER(WHERE reserved)::integer AS previous,
      count(*) FILTER(WHERE reserved AND reserved_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::integer AS today,
      max(reserved_at) FILTER(WHERE reserved) AS latest FROM (
        SELECT reserved_at,(status IN ('reserved','waiting_follow','fulfilling','sent','uncertain') OR private_message_id IS NOT NULL OR public_message_id IS NOT NULL
          OR EXISTS(SELECT 1 FROM instagram_automation_effects e WHERE e.run_id=instagram_automation_runs.id AND e.status IN ('sending','sent','uncertain') AND e.effect_key IN ('private','public'))) AS reserved
        FROM instagram_automation_runs WHERE ${scopeWhere(run.user_id)} AND account_id=${run.account_id} AND rule_id=${run.rule_id}
          AND sender_id=${run.sender_id} AND id<>${run.id} AND definition->>'kind' IN ('comment_dm','comment_reply')
      ) recipient_runs`);
    const counts = rows.rows[0],
      f = rule.filters;
    if (f.skipPreviouslyMessaged && Number(counts.previous) > 0)
      return 'This person already received a response from this automation.';
    if (f.maxPerDay > 0 && Number(counts.today) >= f.maxPerDay)
      return 'Daily per-person limit reached (UTC).';
    if (
      f.cooldownMinutes > 0 &&
      counts.latest &&
      Date.now() - new Date(counts.latest as string).getTime() < f.cooldownMinutes * 60000
    )
      return 'This person is still in the cooldown period.';
    await tx.execute(
      sql`UPDATE instagram_automation_runs SET status='reserved',reserved_at=now(),updated_at=now() WHERE ${scopeWhere(run.user_id)} AND id=${run.id}`
    );
    return null;
  });
}
const plain = (text: string): InstagramMessage => ({ ...emptyInstagramMessage(), text });
async function publicReply(run: Run, text: string) {
  return effect(run, 'public', async () => {
    const { sendInstagramCommentReply } = await import('../../controllers/webhooksController.js');
    const r = await sendInstagramCommentReply(
      run.user_id,
      run.context.commentId!,
      text,
      run.account_id
    );
    if (r.code === 'ASSISTANT_SETUP_REQUIRED') throw new CustomerDeliverySetupError(r.reason || 'assignment_required', r.error || 'Assistant setup required.');
    if (!r.success || !r.providerMessageId)
      throw new InstagramProviderError(
        r.error || 'Instagram did not return a public reply receipt.',
        r.outcomeUncertain || r.success
      );
    return { messageId: r.providerMessageId };
  });
}
async function handleFollowCheck(run: Run, provider: InstagramAutomationProvider) {
  if (run.definition.kind !== 'follow_check') return;
  const parent = await loadRun(run.user_id, run.definition.parentId);
  if (
    !parent ||
    parent.account_id !== run.account_id ||
    parent.definition.kind !== 'comment_dm' ||
    (parent.recipient_id || parent.sender_id) !== run.sender_id ||
    parent.status !== 'waiting_follow'
  )
    return finish(run, 'skipped', 'This follow request is no longer pending.');
  if (!(await ruleStillActive(parent)))
    return finish(run, 'skipped', 'The automation is paused or removed.');
  const parentDefinition = parent.definition;
  if ((await provider.followStatus(run.sender_id)) !== true) {
    await effect(run, 'follow_retry', () =>
      provider.sendMessage(
        run.sender_id,
        plain(instagramFollowRetryMessage(parentDefinition.followGate.retryMessage))
      )
    );
    return finish(run, 'sent', 'Follow could not be verified; promised content remains pending.');
  }
  const claim =
    await db.execute(sql`UPDATE instagram_automation_runs SET status='fulfilling',context=context||'{"fulfilling":true}'::jsonb,claimed_at=now(),updated_at=now()
    WHERE ${scopeWhere(run.user_id)} AND id=${parent.id} AND status='waiting_follow' RETURNING id`);
  if (!claim.rows.length)
    return finish(run, 'skipped', 'Another follow check already handled this request.');
  let receipt: Receipt;
  try {
    receipt = await effect(parent, 'promised_content', () =>
      provider.sendMessage(run.sender_id, parentDefinition.message, parent.context)
    );
  } catch (error) {
    await finish(
      parent,
      error instanceof InstagramAutomationSuppressed ? 'skipped'
        : deliverySetupFailure(error) ? 'failed'
        : error instanceof InstagramQueueIdentityError ? 'failed'
        : error instanceof InstagramProviderError && !error.uncertain ? 'failed' : 'uncertain',
      deliverySetupFailure(error) ? JSON.stringify(deliverySetupFailure(error)) : error instanceof InstagramAutomationSuppressed || error instanceof InstagramQueueIdentityError ? error.message
        : 'Promised content delivery could not complete. Review its receipt before retrying.'
    );
    throw error;
  }
  await db.execute(
    sql`UPDATE instagram_automation_runs SET status='sent',reason=NULL,updated_at=now() WHERE ${scopeWhere(run.user_id)} AND id=${parent.id}`
  );
  await db.execute(
    sql`UPDATE instagram_automation_runs SET private_message_id=${receipt.messageId} WHERE ${scopeWhere(run.user_id)} AND id=${run.id}`
  );
  await finish(run, 'sent');
}
export async function processInstagramAutomationRun(userId: number, runId: number) {
  const run = await loadRun(userId, runId);
  if (!run || !['queued'].includes(run.status)) return;
  try {
    assertExecutionIdentity(run);
  } catch (error) {
    if (error instanceof InstagramQueueIdentityError) await blockQueuedIdentity(run, error.message);
    throw error;
  }
  if (run.context.notBefore && run.context.notBefore > Date.now()) return;
  const claimed = await db.execute(
    sql`UPDATE instagram_automation_runs SET status='running',claimed_at=now(),updated_at=now() WHERE ${scopeWhere(userId)} AND id=${runId} AND status='queued' RETURNING id`
  );
  if (!claimed.rows.length) return;
  try {
    if (!instagramAutomationsEnabled(run.account_id) || !(await ruleStillActive(run)))
      return await finish(run, 'skipped', 'This automation is paused or unavailable.');
    if (!(await canContact(run)))
      return await finish(run, 'skipped', 'The recipient is unavailable or has opted out.');
    if (run.context.reelLookupUnconfirmed)
      return await finish(run, 'skipped', 'Instagram could not confirm whether this media is a Reel.');
    const provider = new InstagramAutomationProvider(
      await requireInstagramAutomationAccount(userId, run.account_id)
    );
    const definition = run.definition;
    if (definition.kind === 'unmatched') return await finish(run, 'unmatched');
    const age = Date.now() - run.context.occurredAt;
    if (
      age < -60000 ||
      age >
        (definition.kind === 'comment_dm' || definition.kind === 'comment_reply'
          ? 7 * 86400000
          : 86400000)
    )
      return await finish(run, 'skipped', 'The reply window has expired.');
    await provider.assertReady(
      definition.kind === 'comment_dm'
        ? 'comment_dm'
        : definition.kind === 'comment_reply'
          ? 'comments'
          : 'messages'
    );
    if (definition.kind === 'follow_check') return await handleFollowCheck(run, provider);
    if (definition.kind === 'menu') {
      const receipt = await effect(run, 'menu_response', () =>
        provider.sendMessage(run.sender_id, definition.message)
      );
      await db.execute(
        sql`UPDATE instagram_automation_runs SET private_message_id=${receipt.messageId} WHERE ${scopeWhere(userId)} AND id=${runId}`
      );
      return await finish(run, 'sent');
    }
    await tagContact(run, definition.tags);
    const follow =
      definition.filters.followers !== 'any' ? await provider.followStatus(run.sender_id) : null;
    if (
      definition.filters.followers !== 'any' &&
      (follow === null || (definition.filters.followers === 'followers' ? !follow : follow))
    )
      return await finish(
        run,
        'skipped',
        follow === null
          ? 'Follower status could not be verified.'
          : 'The follower filter did not match.'
      );
    const limit = await reserveLimits(run, definition);
    if (limit) return await finish(run, 'skipped', limit);
    if (definition.kind === 'comment_dm') {
      const reply = definition.followGate.enabled
        ? instagramFollowPrompt(definition.followGate.prompt)
        : renderInstagramText(definition.message.text, run.context);
      const receipt = await effect(run, 'private', () =>
        provider.sendPrivateReply(run.context.commentId!, reply)
      );
      await db.execute(sql`UPDATE instagram_automation_runs SET private_message_id=${receipt.messageId},recipient_id=${receipt.recipientId || null},
        status=${definition.followGate.enabled ? 'waiting_follow' : 'reserved'},updated_at=now() WHERE ${scopeWhere(userId)} AND id=${runId}`);
    }
    if (definition.publicReplies.length) {
      const choice =
        Number.parseInt(createHash('sha256').update(run.source_key).digest('hex').slice(0, 8), 16) %
        definition.publicReplies.length;
      const receipt = await publicReply(
        run,
        renderInstagramText(definition.publicReplies[choice], run.context)
      );
      await db.execute(
        sql`UPDATE instagram_automation_runs SET public_message_id=${receipt.messageId},updated_at=now() WHERE ${scopeWhere(userId)} AND id=${runId}`
      );
    }
    await finish(
      run,
      definition.kind === 'comment_dm' && definition.followGate.enabled ? 'waiting_follow' : 'sent'
    );
  } catch (error) {
    if (error instanceof InstagramAutomationSuppressed)
      return await finish(run, 'skipped', error.message);
    const setup = deliverySetupFailure(error);
    if (setup) return await finish(run, 'failed', JSON.stringify(setup));
    if (error instanceof PrivateReplyDeferred) {
      await db.execute(sql`UPDATE instagram_automation_runs SET status='queued',reserved_at=NULL,reason=${error.message},context=context||${JSON.stringify({ notBefore: error.notBefore })}::jsonb,updated_at=now()
        WHERE ${scopeWhere(userId)} AND id=${runId}`);
      return;
    }
    const uncertain = error instanceof InstagramProviderError && error.uncertain;
    // A database failure after an effect may have lost the receipt commit. Inspect the effect ledger before deciding.
    const effects = await db.execute(
      sql`SELECT status FROM instagram_automation_effects WHERE ${scopeWhere(userId)} AND run_id=${runId}`
    );
    const unconfirmed = effects.rows.some((e: { status: string }) =>
      ['sending', 'uncertain'].includes(e.status)
    );
    const current = await loadRun(userId, runId);
    const gatePromptAccepted =
      run.definition.kind === 'comment_dm' &&
      run.definition.followGate.enabled &&
      current?.private_message_id;
    await finish(
      run,
      gatePromptAccepted ? 'waiting_follow' : uncertain || unconfirmed ? 'uncertain' : 'failed',
      error instanceof InstagramAutomationError
        ? error.message
        : 'The execution could not complete. Review its recorded delivery receipts.'
    );
    logger.warn(
      { runId, userId, uncertain: uncertain || unconfirmed },
      'Instagram automation did not complete'
    );
  }
}
/** Worker-only recovery: never blindly repeat an effect with a committed send intent. */
export async function recoverInstagramAutomationRuns(): Promise<number> {
  return withSystemScope('Instagram automation recovery inventory', async () => {
    if (
      process.env.INSTAGRAM_AUTOMATIONS_ENABLED !== 'true' &&
      !process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS
    )
      return 0;
    await recoverInstagramProfilePublications();
    const inventory =
      await db.execute(sql`SELECT id,user_id,business_profile_id FROM instagram_automation_runs
      WHERE (status='queued' AND COALESCE((context->>'notBefore')::numeric,0)<=extract(epoch from now())*1000)
        OR (status IN ('running','reserved','fulfilling','recovering') AND updated_at<now()-interval '5 minutes') ORDER BY id LIMIT 100`);
    for (const row of inventory.rows)
      // Owner scope permits inventory/receipt reconciliation. enqueue restores
      // the run's original business and billing actors before queue capture.
      await withBusinessScope(
        { userId: Number(row.user_id), businessProfileId: Number(row.business_profile_id) },
        async () => {
          const run = await loadRun(Number(row.user_id), Number(row.id));
          if (!run) return;
          if (run.status !== 'queued') {
            // Inventory is only a hint. Recheck the lease atomically after loading;
            // another worker may have claimed or completed the run in between.
            const claim =
              await db.execute(sql`UPDATE instagram_automation_runs SET status='recovering',updated_at=now()
          WHERE ${scopeWhere(run.user_id)} AND id=${run.id} AND status IN ('running','reserved','fulfilling','recovering')
            AND updated_at<now()-interval '5 minutes' RETURNING id`);
            if (!claim.rows.length) return;
            const effects = await db.execute(
              sql`SELECT status,effect_key FROM instagram_automation_effects WHERE ${scopeWhere(run.user_id)} AND run_id=${run.id}`
            );
            if (
              run.status === 'fulfilling' ||
              (run.context as Context & { fulfilling?: boolean }).fulfilling ||
              effects.rows.some((e: { effect_key: string }) => e.effect_key === 'promised_content')
            ) {
              const promised = effects.rows.find(
                (e: { effect_key: string }) => e.effect_key === 'promised_content'
              );
              await finish(
                run,
                !promised
                  ? 'waiting_follow'
                  : promised.status === 'sent'
                    ? 'sent'
                    : promised.status === 'failed'
                      ? 'failed'
                      : 'uncertain',
                !promised || promised.status === 'sent'
                  ? null
                  : 'Promised content delivery was interrupted and requires review.'
              );
              return;
            }
            if (
              effects.rows.some((e: { status: string }) =>
                ['sending', 'uncertain'].includes(e.status)
              )
            ) {
              await finish(
                run,
                'uncertain',
                'The worker stopped before a delivery receipt was recorded. Review this execution; it will not resend automatically.'
              );
              return;
            }
            if (effects.rows.some((e: { status: string }) => e.status === 'failed')) {
              await finish(
                run,
                'failed',
                'A provider operation was rejected before the worker stopped.'
              );
              return;
            }
            await finish(run, 'queued');
          }
          await enqueue(run.user_id, run.id);
        }
      );
    return inventory.rows.length;
  });
}
