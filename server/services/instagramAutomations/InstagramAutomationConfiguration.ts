import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import {
  requireBusinessScope,
  withBusinessScope,
  withSystemScope,
} from '../../tenancy/businessContext.js';
import {
  emptyInstagramProfile,
  validateInstagramProfile,
  validateInstagramRule,
  sortInstagramRules,
  matchInstagramRule,
  renderInstagramText,
  instagramFollowPrompt,
  type InstagramProfileKind,
  type InstagramProfileConfig,
  type InstagramAutomationRule,
  type InstagramAutomationProfile,
  type InstagramRuleDefinition,
} from '../../../shared/instagramAutomations.js';
import { instagramActivationIssues, instagramAutomationSummary } from '../../../shared/instagramAutomationTools.js';
import {
  InstagramAutomationError,
  InstagramAutomationProvider,
  instagramAutomationReadiness,
  requireInstagramAutomationAccount,
} from './InstagramAutomationProvider.js';

export const ruleSelection = sql`id,account_id AS "accountId",definition,status,priority,revision,created_at AS "createdAt",updated_at AS "updatedAt"`;
const profileSelection = sql`kind,config,published_config AS "publishedConfig",revision,sync_status AS "syncStatus",sync_error AS "syncError",synced_at AS "syncedAt"`;
export function automationScope(userId: number) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId)
    throw new InstagramAutomationError('Business account mismatch.', 403);
  return scope;
}
export async function listInstagramRules(userId: number, accountId: string) {
  const scope = automationScope(userId);
  const rows =
    await db.execute(sql`SELECT ${ruleSelection} FROM instagram_automation_rules WHERE user_id=${userId}
    AND business_profile_id=${scope.businessProfileId} AND account_id=${accountId} AND deleted_at IS NULL ORDER BY priority,id`);
  return sortInstagramRules(rows.rows as unknown as InstagramAutomationRule[]);
}
export async function getInstagramProfile(
  userId: number,
  accountId: string,
  kind: InstagramProfileKind
) {
  const scope = automationScope(userId);
  const rows =
    await db.execute(sql`SELECT ${profileSelection} FROM instagram_automation_profiles WHERE user_id=${userId}
    AND business_profile_id=${scope.businessProfileId} AND account_id=${accountId} AND kind=${kind}`);
  return rows.rows[0] as unknown as InstagramAutomationProfile | undefined;
}
export async function getInstagramAutomationOverview(userId: number, accountId: string) {
  const account = await requireInstagramAutomationAccount(userId, accountId),
    scope = automationScope(userId);
  const [rules, profiles, counts, readiness] = await Promise.all([
    listInstagramRules(userId, accountId),
    db.execute(
      sql`SELECT ${profileSelection} FROM instagram_automation_profiles WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND account_id=${accountId}`
    ),
    db.execute(sql`SELECT count(*) FILTER(WHERE status<>'unmatched')::integer AS triggers,
      COALESCE(sum((SELECT count(*) FROM instagram_automation_effects e WHERE e.run_id=instagram_automation_runs.id AND e.status='sent')),0)::integer AS sent,
      count(*) FILTER(WHERE status='failed' OR EXISTS(SELECT 1 FROM instagram_automation_effects e WHERE e.run_id=instagram_automation_runs.id AND e.status='failed'))::integer AS failed,count(*) FILTER(WHERE status='skipped')::integer AS skipped,
      count(*) FILTER(WHERE status IN ('queued','running','reserved','waiting_follow','fulfilling','recovering'))::integer AS pending,
      count(*) FILTER(WHERE status='uncertain' OR EXISTS(SELECT 1 FROM instagram_automation_effects e WHERE e.run_id=instagram_automation_runs.id AND e.status='uncertain'))::integer AS uncertain FROM instagram_automation_runs
      WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND account_id=${accountId}`),
    instagramAutomationReadiness(account),
  ]);
  return {
    account: {
      id: accountId,
      username: account.connection?.instagramUsername || account.credential.accountName,
    },
    readiness,
    profiles: profiles.rows,
    rules,
    stats: counts.rows[0],
  };
}
export async function saveInstagramProfile(
  userId: number,
  accountId: string,
  kind: InstagramProfileKind,
  config: InstagramProfileConfig,
  revision: number,
  publish: boolean,
  remove = false
) {
  const account = await requireInstagramAutomationAccount(userId, accountId),
    scope = automationScope(userId);
  const errors = remove ? [] : validateInstagramProfile(kind, config);
  if (errors.length) throw new InstagramAutomationError(errors.join(' '));
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new InstagramAutomationError('Reload the profile before saving.');
  const draft = remove ? emptyInstagramProfile() : config;
  const saved = await db.transaction(async (tx: Pick<NodePgDatabase, 'execute'>) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ig-profile:${scope.businessProfileId}:${accountId}:${kind}`},0))`
    );
    const existing = await tx.execute(
      sql`SELECT revision,sync_status FROM instagram_automation_profiles WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND account_id=${accountId} AND kind=${kind} FOR UPDATE`
    );
    if (Number(existing.rows[0]?.revision || 0) !== revision)
      throw new InstagramAutomationError(
        'This profile changed in another editor. Reload before saving.',
        409
      );
    if (['syncing', 'reconciling'].includes(String(existing.rows[0]?.sync_status)))
      throw new InstagramAutomationError(
        'Instagram publication is still being verified. Refresh shortly before editing again.',
        409
      );
    const result =
      await tx.execute(sql`INSERT INTO instagram_automation_profiles(user_id,business_profile_id,account_id,kind,config,sync_status,sync_remove)
      VALUES(${userId},${scope.businessProfileId},${accountId},${kind},${JSON.stringify(draft)}::jsonb,${publish || remove ? 'syncing' : 'draft'},${remove})
      ON CONFLICT(business_profile_id,user_id,account_id,kind) DO UPDATE SET config=excluded.config,revision=instagram_automation_profiles.revision+1,
        sync_status=excluded.sync_status,sync_remove=excluded.sync_remove,sync_error=NULL,updated_at=now() RETURNING id,revision`);
    return { id: Number(result.rows[0].id), revision: Number(result.rows[0].revision) };
  });
  // Commit the response mapping and pending publication before Meta can expose it.
  // A crash leaves a durable pending revision for the read-only recovery sweep.
  if (publish || remove)
    await finalizeInstagramProfile(userId, saved.id, saved.revision, draft, remove, () =>
      new InstagramAutomationProvider(account).publishProfile(kind, draft, remove)
    );
  return getInstagramProfile(userId, accountId, kind);
}
async function finalizeInstagramProfile(
  userId: number,
  id: number,
  revision: number,
  config: InstagramProfileConfig,
  remove: boolean,
  verify: () => Promise<void>
) {
  const scope = automationScope(userId);
  let error: string | null = null;
  try {
    await verify();
  } catch (cause) {
    error =
      cause instanceof InstagramAutomationError
        ? cause.message
        : 'Instagram publication could not be verified. Review and publish the saved draft again.';
  }
  await db.execute(sql`UPDATE instagram_automation_profiles SET
    published_config=CASE WHEN ${error}::text IS NULL THEN ${remove ? null : JSON.stringify(config)}::jsonb ELSE published_config END,
    sync_status=${error ? 'error' : remove ? 'draft' : 'published'},sync_error=${error},
    synced_at=CASE WHEN ${error}::text IS NULL THEN now() ELSE synced_at END,updated_at=now()
    WHERE id=${id} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND revision=${revision} AND sync_status IN ('syncing','reconciling')`);
}
export async function recoverInstagramProfilePublications() {
  return withSystemScope('Instagram pending profile publication inventory', async () => {
    const rows =
      await db.execute(sql`SELECT id,user_id,business_profile_id FROM instagram_automation_profiles
      WHERE sync_status IN ('syncing','reconciling') AND updated_at<now()-interval '5 minutes' ORDER BY id LIMIT 50`);
    for (const row of rows.rows)
      await withBusinessScope(
        { userId: Number(row.user_id), businessProfileId: Number(row.business_profile_id) },
        async () => {
          const pending =
            await db.execute(sql`UPDATE instagram_automation_profiles SET sync_status='reconciling',updated_at=now()
        WHERE id=${row.id} AND user_id=${row.user_id} AND business_profile_id=${row.business_profile_id}
          AND sync_status IN ('syncing','reconciling') AND updated_at<now()-interval '5 minutes' RETURNING *`);
          const profile = pending.rows[0];
          if (!profile) return;
          await finalizeInstagramProfile(
            Number(profile.user_id),
            Number(profile.id),
            Number(profile.revision),
            profile.config as InstagramProfileConfig,
            Boolean(profile.sync_remove),
            async () => {
              const account = await requireInstagramAutomationAccount(
                Number(profile.user_id),
                String(profile.account_id)
              );
              await new InstagramAutomationProvider(account).verifyProfile(
                profile.kind as InstagramProfileKind,
                profile.config as InstagramProfileConfig,
                Boolean(profile.sync_remove)
              );
            }
          );
        }
      );
  });
}

export async function saveInstagramRule(
  userId: number,
  accountId: string,
  definition: InstagramRuleDefinition,
  id?: number,
  status: 'active' | 'paused' = 'paused',
  revision?: number
) {
  const account = await requireInstagramAutomationAccount(userId, accountId),
    scope = automationScope(userId);
  const errors = validateInstagramRule(definition);
  if (errors.length) throw new InstagramAutomationError(errors.join(' '));
  if (id && (!Number.isSafeInteger(revision) || Number(revision) < 1))
    throw new InstagramAutomationError('Reload the rule before saving.');
  if (!['active', 'paused'].includes(status))
    throw new InstagramAutomationError('Choose paused or active status.');
  if (id && status === 'active') {
    const provider = new InstagramAutomationProvider(account);
    await provider.assertReady(definition.kind === 'comment_dm' ? 'comment_dm' : 'comments');
    if (definition.trigger.scope === 'specific')
      await provider.verifyMedia(definition.trigger.mediaIds);
  }
  const result = id
    ? await db.execute(sql`UPDATE instagram_automation_rules SET definition=${JSON.stringify(definition)}::jsonb,status=${status},revision=revision+1,updated_at=now()
      WHERE id=${id} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND account_id=${accountId} AND revision=${revision!} AND deleted_at IS NULL RETURNING ${ruleSelection}`)
    : await db.execute(sql`INSERT INTO instagram_automation_rules(user_id,business_profile_id,account_id,definition,priority)
      VALUES(${userId},${scope.businessProfileId},${accountId},${JSON.stringify(definition)}::jsonb,
        (SELECT COALESCE(max(priority),0)+1 FROM instagram_automation_rules WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND account_id=${accountId})) RETURNING ${ruleSelection}`);
  if (!result.rows.length)
    throw new InstagramAutomationError(
      'This rule changed or was removed. Reload before saving.',
      409
    );
  return result.rows[0];
}
export async function duplicateInstagramRule(userId: number, accountId: string, id: number, revision: number) {
  const rules = await listInstagramRules(userId, accountId);
  const source = rules.find(rule => rule.id === id);
  if (!source) throw new InstagramAutomationError('Automation not found in this account.', 404);
  if (source.revision !== revision) throw new InstagramAutomationError('This automation changed. Refresh before duplicating.', 409);
  const definition = structuredClone(source.definition);
  const base = definition.name.slice(0, 108);
  let name = base + ' (copy)', number = 2;
  while (rules.some(rule => rule.definition.name === name)) name = base + ' (copy ' + number++ + ')';
  definition.name = name;
  return saveInstagramRule(userId, accountId, definition);
}
export async function testInstagramRule(userId: number, accountId: string, id: number, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InstagramAutomationError('Provide a sample comment.');
  const comment = input as { text?: unknown; mediaId?: unknown; isReel?: unknown };
  if (typeof comment.text !== 'string' || !comment.text.trim() || comment.text.length > 2000 || typeof comment.mediaId !== 'string' || comment.mediaId.length > 255 || typeof comment.isReel !== 'boolean') throw new InstagramAutomationError('Provide a comment up to 2,000 characters, a media identifier and a post/reel choice.');
  const sample = { text: comment.text, mediaId: comment.mediaId, isReel: comment.isReel };
  const rules = await listInstagramRules(userId, accountId), target = rules.find(rule => rule.id === id);
  if (!target) throw new InstagramAutomationError('Automation not found in this account.', 404);
  const keyword = matchInstagramRule(target.definition, sample);
  const winner = sortInstagramRules(rules.filter(rule => rule.status === 'active' || rule.id === id)).find(rule => matchInstagramRule(rule.definition, sample));
  const readiness = await instagramAutomationReadiness(await requireInstagramAutomationAccount(userId, accountId));
  const definition = target.definition;
  return {
    matched: keyword !== null, targetWins: winner?.id === id,
    winner: winner ? { id: winner.id, name: winner.definition.name } : null, keyword,
    firstResponse: keyword ? renderInstagramText(definition.kind === 'comment_reply' ? definition.publicReplies[0] : definition.followGate.enabled ? instagramFollowPrompt(definition.followGate.prompt) : definition.message.text, { keyword, username: 'test_person', name: 'Test person' }) : null,
    summary: instagramAutomationSummary(definition),
    warnings: [
      'Simulation uses the saved setup, with this automation treated as active. It sends nothing to Instagram.',
      'Media type and identifier are sample inputs. Live execution verifies account ownership when needed.',
      ...(target.status === 'paused' ? ['This automation is paused; activate it before testing on Instagram.'] : []),
      ...instagramActivationIssues(definition, readiness),
      'Audience checks, recipient limits, opt-outs, messaging windows and Meta acceptance are evaluated only during live delivery.',
      ...(definition.kind === 'comment_reply' && definition.publicReplies.length > 1 ? ['The first reply variation is shown; live delivery may select another variation.'] : []),
    ],
  };
}
export async function deleteInstagramRule(
  userId: number,
  accountId: string,
  id: number,
  revision: number
) {
  const scope = automationScope(userId);
  const result =
    await db.execute(sql`UPDATE instagram_automation_rules SET deleted_at=now(),status='paused',revision=revision+1,updated_at=now()
    WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND account_id=${accountId} AND id=${id} AND revision=${revision} AND deleted_at IS NULL RETURNING id`);
  if (!result.rows.length)
    throw new InstagramAutomationError(
      'This rule changed or was removed. Reload before deleting.',
      409
    );
}
export async function reorderInstagramRules(userId: number, accountId: string, ids: number[]) {
  const scope = automationScope(userId);
  if (
    !Array.isArray(ids) ||
    ids.length > 1000 ||
    new Set(ids).size !== ids.length ||
    !ids.every((x) => Number.isSafeInteger(x) && x > 0)
  )
    throw new InstagramAutomationError('Provide each rule once in the desired order.');
  await db.transaction(async (tx: Pick<NodePgDatabase, 'execute'>) => {
    const rows = await tx.execute(
      sql`SELECT id FROM instagram_automation_rules WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND account_id=${accountId} AND deleted_at IS NULL FOR UPDATE`
    );
    if (rows.rows.length !== ids.length || rows.rows.some((row) => !ids.includes(Number(row.id))))
      throw new InstagramAutomationError('The rule list changed. Reload before reordering.', 409);
    for (const [priority, id] of ids.entries())
      await tx.execute(
        sql`UPDATE instagram_automation_rules SET priority=${priority},revision=revision+1,updated_at=now() WHERE id=${id} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND account_id=${accountId}`
      );
  });
  return listInstagramRules(userId, accountId);
}
