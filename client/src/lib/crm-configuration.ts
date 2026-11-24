export * from '../../../shared/crmConfiguration';

import { crmConfigurationIssues, type CrmConfiguration, type CrmStage } from '../../../shared/crmConfiguration';

export const CRM_CONFIGURATION_API = '/api/crm/configuration';

export function isCrmConfiguration(value: unknown): value is CrmConfiguration {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as CrmConfiguration;
  if (!Array.isArray(candidate.stages) || !candidate.preferences || typeof candidate.preferences !== 'object') return false;
  if (!candidate.stages.every(stage => stage && typeof stage.key === 'string' && typeof stage.label === 'string'
    && typeof stage.type === 'string' && typeof stage.color === 'string' && typeof stage.inFlow === 'boolean')) return false;
  return crmConfigurationIssues(candidate).length === 0;
}

export function crmStageBadgeStyle(stage?: CrmStage) {
  return stage ? { color: stage.color, borderColor: `${stage.color}40`, backgroundColor: `${stage.color}15` } : undefined;
}
