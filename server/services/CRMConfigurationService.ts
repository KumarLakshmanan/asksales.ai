import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../models/db.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';
import { DEFAULT_CRM_CONFIGURATION, normalizeCrmConfiguration, type CrmConfiguration } from '../../shared/crmConfiguration.js';
import { crmStageForOutcome } from '../../shared/crmPipeline.js';

export class CrmConfigurationError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

function configurationScope(userId: number) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new CrmConfigurationError('Business profile does not belong to this account.', 403);
  return scope;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  return value;
}

function withRevision(configuration: CrmConfiguration): CrmConfiguration {
  const normalized = normalizeCrmConfiguration(configuration);
  const { revision: _revision, ...value } = normalized;
  return { ...value, revision: createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex') };
}

export async function getCrmConfiguration(userId: number, executor: Pick<typeof db, 'execute'> = db, lock = false): Promise<CrmConfiguration> {
  const scope = configurationScope(userId);
  const result = await executor.execute(sql`
    SELECT crm_configuration FROM company_settings
    WHERE id = ${scope.businessProfileId} AND user_id = ${userId} LIMIT 1 ${lock ? sql`FOR SHARE` : sql``}
  `);
  if (!result.rows.length) throw new CrmConfigurationError('Business profile not found.', 404);
  return withRevision(result.rows[0].crm_configuration ?? structuredClone(DEFAULT_CRM_CONFIGURATION));
}

export async function saveCrmConfiguration(userId: number, configuration: CrmConfiguration): Promise<CrmConfiguration> {
  const scope = configurationScope(userId);
  configuration = normalizeCrmConfiguration(configuration);
  return db.transaction(async (tx: typeof db) => {
    const current = await tx.execute(sql`
      SELECT crm_configuration FROM company_settings
      WHERE id = ${scope.businessProfileId} AND user_id = ${userId} FOR UPDATE
    `);
    if (!current.rows.length) throw new CrmConfigurationError('Business profile not found.', 404);
    const previous = withRevision(current.rows[0].crm_configuration ?? DEFAULT_CRM_CONFIGURATION);
    if (configuration.revision && configuration.revision !== previous.revision) {
      throw new CrmConfigurationError('CRM configuration changed while you were editing. Your draft is preserved. Reload the saved configuration and review those changes before saving again.', 409);
    }
    const removed = previous.stages.filter(stage => !configuration.stages.some(candidate => candidate.key === stage.key));
    if (removed.length) {
      const keys = removed.map(stage => stage.key);
      const replyKey = previous.stages.find(stage => stage.type === 'active')?.key || 'new';
      const virtualStage = sql`CASE
        WHEN lead.status IN ('won', 'converted') THEN ${crmStageForOutcome(previous.stages, 'won')?.key || 'new'}
        WHEN lead.status IN ('lost', 'rejected') THEN ${crmStageForOutcome(previous.stages, 'lost')?.key || 'new'}
        WHEN lead.status <> 'new' AND lead.status = ANY(${sql.param(previous.stages.map(stage => stage.key))}::text[]) THEN lead.status
        WHEN EXISTS (SELECT 1 FROM outreach_conversations conversation
          WHERE conversation.lead_id = lead.id AND conversation.user_id = ${userId}) THEN ${replyKey}
        ELSE 'new' END`;
      const references = await tx.execute(sql`
        SELECT DISTINCT COALESCE(pipeline_status, 'new') AS key FROM crm_contacts
        WHERE user_id = ${userId} AND business_profile_id = ${scope.businessProfileId}
          AND deleted_at IS NULL AND COALESCE(pipeline_status, 'new') = ANY(${sql.param(keys)}::text[])
        UNION
        SELECT DISTINCT ${virtualStage} AS key
        FROM leads lead
        WHERE lead.user_id = ${userId} AND lead.business_profile_id = ${scope.businessProfileId}
          AND lead.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM crm_contacts contact WHERE contact.lead_id = lead.id AND contact.user_id = ${userId})
          AND (${virtualStage}) = ANY(${sql.param(keys)}::text[])
      `);
      const rules = await tx.execute(sql`
        SELECT trigger_config AS config, action_config, condition, definition FROM crm_pipeline_automations
        WHERE user_id = ${userId} AND business_profile_id = ${scope.businessProfileId} AND deleted_at IS NULL
        UNION ALL
        SELECT conditions AS config, NULL::jsonb AS action_config, NULL::jsonb AS condition, NULL::jsonb AS definition FROM crm_alerts
          WHERE user_id = ${userId} AND business_profile_id = ${scope.businessProfileId}
      `);
      const runtimeTable=await tx.execute(sql`SELECT to_regclass('crm_automation_runs') AS run_table`);
      const queuedRuns=runtimeTable.rows[0]?.run_table ? await tx.execute(sql`SELECT definition FROM crm_automation_runs
        WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND status IN ('queued','running','retry')`) : null;
      const hasReference = (value: unknown, key: string): boolean => {
        if (value === key) return true;
        if (Array.isArray(value)) return value.some(item => hasReference(item, key));
        return !!value && typeof value === 'object' && Object.values(value).some(item => hasReference(item, key));
      };
      const blocked = removed.filter(stage => references.rows.some((row: { key: string }) => row.key === stage.key)
        || rules.rows.some((row: unknown) => hasReference(row, stage.key))
        || queuedRuns?.rows.some((row: unknown)=>hasReference(row,stage.key)));
      if (blocked.length) {
        throw new CrmConfigurationError(`“${blocked.map(stage => stage.label).join('”, “')}” is used by contacts or CRM rules. Move those contacts and update the rules first, or switch off In flow instead.`, 409);
      }
    }
    const { revision: _revision, ...stored } = configuration;
    await tx.execute(sql`
      UPDATE company_settings SET crm_configuration = ${JSON.stringify(stored)}::jsonb, updated_at = NOW()
      WHERE id = ${scope.businessProfileId} AND user_id = ${userId}
    `);
    return withRevision(stored);
  });
}
