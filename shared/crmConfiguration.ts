export type CrmStageType = 'entry' | 'active' | 'won' | 'lost';

export interface CrmStage {
  key: string;
  label: string;
  type: CrmStageType;
  color: string;
  inFlow: boolean;
}

export const CRM_DATE_RANGES = [
  { value: '7d', label: 'Last 7 Days', days: 7 },
  { value: '30d', label: 'Last 30 Days', days: 30 },
  { value: '90d', label: 'Last 90 Days', days: 90 },
  { value: 'all', label: 'All Time', days: null },
  { value: 'custom', label: 'Custom Dates', days: null },
] as const;

export const CRM_PLATFORMS = [
  { value: 'all', label: 'All Platforms' },
  { value: 'email', label: 'Email' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'twitter', label: 'Twitter / X' },
  { value: 'sms', label: 'SMS' },
  { value: 'web', label: 'Web Chat' },
] as const;

/** Recorded provider channels can be drilled into without changing saved platform preferences. */
export const CRM_REPORT_PLATFORMS = [...CRM_PLATFORMS, { value: 'gmail', label: 'Gmail' }] as const;

export type CrmPlatform = typeof CRM_PLATFORMS[number]['value'];

export interface CrmPreferences {
  dateRange: typeof CRM_DATE_RANGES[number]['value'];
  /** Inclusive calendar dates in UTC, used only when dateRange is custom. */
  dateStart?: string;
  dateEnd?: string;
  // Accept the original single-platform setting when reading existing profiles.
  platform: CrmPlatform | CrmPlatform[];
  stuckThreshold: number;
  topFlows: number;
  minFlowCount: number;
}

export interface CrmConfiguration {
  stages: CrmStage[];
  preferences: CrmPreferences;
  /** Read revision used to prevent overwriting another editor's changes. */
  revision?: string;
}

// Keep the existing status keys so contact history and automatic transitions
// continue to refer to the same stages when their display names change.
export const DEFAULT_CRM_STAGES: CrmStage[] = [
  { key: 'new', label: 'Not Categorized', type: 'entry', color: '#6b7280', inFlow: true },
  { key: 'contacted', label: 'Ongoing', type: 'active', color: '#8b5cf6', inFlow: true },
  { key: 'interested', label: 'Interested', type: 'active', color: '#6366f1', inFlow: true },
  { key: 'negotiations', label: 'Negotiation', type: 'active', color: '#f97316', inFlow: true },
  { key: 'demo', label: 'Demo', type: 'active', color: '#0ea5e9', inFlow: true },
  { key: 'proposal_sent', label: 'Proposal Sent', type: 'active', color: '#06b6d4', inFlow: true },
  { key: 'ticket_open', label: 'Ticket Open', type: 'active', color: '#eab308', inFlow: true },
  { key: 'ticket_close', label: 'Ticket Closed', type: 'active', color: '#64748b', inFlow: true },
  { key: 'won', label: 'Won', type: 'won', color: '#10b981', inFlow: true },
  { key: 'lost', label: 'Lost', type: 'lost', color: '#f59e0b', inFlow: true },
];

export const DEFAULT_CRM_CONFIGURATION: CrmConfiguration = {
  stages: DEFAULT_CRM_STAGES,
  preferences: { dateRange: '30d', platform: ['all'], stuckThreshold: 7, topFlows: 5, minFlowCount: 3 },
};

export function crmSelectedPlatforms(preferences: Pick<CrmPreferences, 'platform'>): CrmPlatform[] {
  return Array.isArray(preferences.platform) ? [...preferences.platform] : [preferences.platform];
}

export function crmPlatformLabel(preferences: Pick<CrmPreferences, 'platform'>): string {
  const selected = crmSelectedPlatforms(preferences);
  return CRM_PLATFORMS.filter(platform => selected.includes(platform.value)).map(platform => platform.label).join(', ');
}

export function crmDateRangeLabel(preferences: Pick<CrmPreferences, 'dateRange' | 'dateStart' | 'dateEnd'>): string {
  if (preferences.dateRange === 'custom') return `${preferences.dateStart || 'Start date'} – ${preferences.dateEnd || 'End date'} (UTC)`;
  return CRM_DATE_RANGES.find(range => range.value === preferences.dateRange)?.label || 'Date range';
}

export function isCrmCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeCrmConfiguration(configuration: CrmConfiguration): CrmConfiguration {
  return { ...configuration, preferences: { ...configuration.preferences, platform: crmSelectedPlatforms(configuration.preferences) } };
}

export const CRM_STAGE_LIMIT = 30;
export const CRM_STAGE_COLORS = ['#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#0ea5e9', '#ec4899', '#6366f1', '#14b8a6'];

export interface CrmConfigurationIssue {
  section: 'stages' | 'preferences';
  message: string;
}

export function crmConfigurationIssues(configuration: CrmConfiguration): CrmConfigurationIssue[] {
  const issues: CrmConfigurationIssue[] = [];
  const stages = configuration.stages;
  const addStageIssue = (message: string) => issues.push({ section: 'stages', message });
  if (!stages.length || stages.length > CRM_STAGE_LIMIT) addStageIssue(`Use between 1 and ${CRM_STAGE_LIMIT} stages.`);
  if (stages[0]?.key !== 'new' || stages[0]?.type !== 'entry' || stages.filter(stage => stage.type === 'entry').length !== 1) {
    addStageIssue('Keep Not Categorized as the first and only entry stage.');
  }
  if (new Set(stages.map(stage => stage.key)).size !== stages.length) addStageIssue('Each stage must have a unique identifier.');
  const names = new Set<string>();
  for (const [index, stage] of stages.entries()) {
    const name = stage.label.trim();
    if (!name || name.length > 80) addStageIssue(`Stage ${index + 1} needs a name of 1 to 80 characters.`);
    else if (names.has(name.toLocaleLowerCase())) addStageIssue(`The stage name “${name}” is already used.`);
    names.add(name.toLocaleLowerCase());
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(stage.key)) addStageIssue(`Stage ${index + 1} has an invalid identifier.`);
    if (!['entry', 'active', 'won', 'lost'].includes(stage.type)) addStageIssue(`Choose a valid type for stage ${index + 1}.`);
    if (!/^#[0-9a-f]{6}$/i.test(stage.color)) addStageIssue(`Choose a valid color for stage ${index + 1}.`);
    if (typeof stage.inFlow !== 'boolean') addStageIssue(`Choose whether stage ${index + 1} is in the flow.`);
  }
  if (!stages.some(stage => stage.inFlow)) addStageIssue('Include at least one stage in the flow.');
  const preferences = configuration.preferences;
  const addPreferenceIssue = (message: string) => issues.push({ section: 'preferences', message });
  if (!CRM_DATE_RANGES.some(range => range.value === preferences.dateRange)) addPreferenceIssue('Choose a valid date range.');
  if (preferences.dateRange === 'custom') {
    if (!isCrmCalendarDate(preferences.dateStart) || !isCrmCalendarDate(preferences.dateEnd)) addPreferenceIssue('Choose valid start and end dates for the custom range.');
    else if (preferences.dateStart > preferences.dateEnd) addPreferenceIssue('The end date must be on or after the start date.');
  }
  const platforms = crmSelectedPlatforms(preferences);
  if (!platforms.length || platforms.some(selected => !CRM_PLATFORMS.some(platform => platform.value === selected))) {
    addPreferenceIssue('Select at least one valid platform.');
  }
  if (new Set(platforms).size !== platforms.length) addPreferenceIssue('Select each platform only once.');
  if (platforms.includes('all') && platforms.length > 1) addPreferenceIssue('Choose All Platforms or individual platforms.');
  if (!Number.isInteger(preferences.stuckThreshold) || preferences.stuckThreshold < 1 || preferences.stuckThreshold > 365) {
    addPreferenceIssue('Stuck threshold must be a whole number from 1 to 365 days.');
  }
  if (!Number.isInteger(preferences.topFlows) || preferences.topFlows < 1 || preferences.topFlows > 20) {
    addPreferenceIssue('Top flows must be a whole number from 1 to 20.');
  }
  if (!Number.isInteger(preferences.minFlowCount) || preferences.minFlowCount < 1 || preferences.minFlowCount > 1000) {
    addPreferenceIssue('Minimum flow count must be a whole number from 1 to 1,000.');
  }
  return issues;
}

/** Always keep contacts in an old or automatically assigned stage discoverable. */
export function crmStagesForStatuses(stages: CrmStage[], statuses: string[]): CrmStage[] {
  const result = [...stages];
  const keys = new Set(stages.map(stage => stage.key));
  for (const status of statuses) {
    const key = status || 'new';
    if (keys.has(key)) continue;
    keys.add(key);
    const existing = DEFAULT_CRM_STAGES.find(stage => stage.key === key);
    result.push(existing ? { ...existing, inFlow: false } : {
      key, label: key.replaceAll('_', ' '), type: 'active', color: '#6b7280', inFlow: false,
    });
  }
  return result;
}
