import { assistantDraftIssues, type AssistantCatalog, type AssistantDraft } from '@/lib/outreach-assistants';

export const RECOVERY_TTL = 24 * 60 * 60 * 1000;
/** Free text can contain customer data. Recover only structural selections. */
export function recoverableAssistantDraft(draft: AssistantDraft) {
  let timezone = 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: draft.availability.timezone }); timezone = draft.availability.timezone; } catch { /* Invalid free text is not kept in browser recovery. */ }
  return {
    agentType: draft.agentType,
    bindings: draft.bindings, replyModel: draft.replyModel, fallbackModels: draft.fallbackModels,
    response: draft.response, knowledge: draft.knowledge, playbooks: { ...draft.playbooks, assignments: draft.playbooks.assignments.filter(a => a.intent === null || /^[a-z][a-z0-9_:-]{0,79}$/i.test(a.intent)) },
    followUps: draft.followUps, documents: draft.documents, galleries: draft.galleries, tools: draft.tools,
    privacy: { permittedCollectionFields: draft.privacy.permittedCollectionFields, minimumConfidence: draft.privacy.minimumConfidence, handoff: draft.privacy.handoff },
    availability: { enabled: draft.availability.enabled, timezone, weekly: draft.availability.weekly },
  };
}
export function restoreAssistantDraft(saved: AssistantDraft, raw: unknown): AssistantDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as ReturnType<typeof recoverableAssistantDraft>;
  const list = (v: unknown): v is unknown[] => Array.isArray(v) && v.length <= 500;
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const string = (v: unknown) => typeof v === 'string' && v.length <= 255;
  const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const selection = (v: unknown) => object(v) && ['unconfigured', 'none', 'selected'].includes(String(v.mode)) && list(v.ids) && v.ids.every(id => Number.isSafeInteger(id) && Number(id) > 0);
  const model = (v: unknown) => object(v) && string(v.provider) && string(v.model);
  if (!list(value.bindings) || !list(value.fallbackModels) || !value.response || !value.privacy || !value.availability
    || !list(value.availability.weekly) || !list(value.privacy.permittedCollectionFields)
    || !value.knowledge || !value.documents || !value.galleries || !value.tools || !value.followUps || !value.playbooks
    || !list(value.knowledge.ids) || !list(value.documents.ids) || !list(value.galleries.ids)
    || !list(value.playbooks.assignments) || !list(value.followUps.sequences) || !list(value.tools.names) || !list(value.tools.approvalRequired)) return null;
  if (typeof value.agentType !== 'string' || !/^[a-z0-9_:-]*$/i.test(value.agentType) || !value.bindings.every(b => object(b) && ['whatsapp', 'instagram', 'facebook', 'email', 'web'].includes(String(b.channel)) && ['private', 'public_comment'].includes(String(b.surface)) && string(b.accountId))
    || !(value.replyModel === null || model(value.replyModel)) || !value.fallbackModels.every(model)
    || !number(value.response.maxReplyTokens) || !selection(value.knowledge) || !selection(value.documents) || !selection(value.galleries)
    || !value.tools.names.every(string) || !value.tools.approvalRequired.every(string)
    || !value.privacy.permittedCollectionFields.every(string) || !number(value.privacy.minimumConfidence) || !['offer', 'customer_request'].includes(value.privacy.handoff)
    || !['unconfigured', 'none', 'selected'].includes(value.playbooks.mode) || !['unconfigured', 'none', 'selected'].includes(value.followUps.mode) || !['unconfigured', 'none', 'selected'].includes(value.tools.mode)
    || !value.playbooks.assignments.every(a => object(a) && Number.isSafeInteger(a.playbookId) && number(a.priority) && string(a.channel) && string(a.surface) && (a.intent === null || typeof a.intent === 'string'))
    || !value.followUps.sequences.every(s => object(s) && string(s.channel) && list(s.steps) && s.steps.every(step => object(step) && number(step.delayMinutes) && number(step.templateId) && (step.messageMode === undefined || ['template', 'ai'].includes(step.messageMode))))
    || typeof value.availability.enabled !== 'boolean' || !string(value.availability.timezone)
    || !value.availability.weekly.every(day => object(day) && number(day.day) && list(day.ranges) && day.ranges.every(range => object(range) && typeof range.start === 'string' && typeof range.end === 'string' && /^\d\d:\d\d$/.test(range.start) && /^\d\d:\d\d$/.test(range.end)))) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: value.availability.timezone }); } catch { return null; }
  // The stored copy is not trusted: never spread unknown top-level properties or free text.
  const structural = recoverableAssistantDraft({ ...saved, ...value, privacy: { ...saved.privacy, ...value.privacy }, availability: { ...saved.availability, ...value.availability } });
  return { ...saved, ...structural, privacy: { ...saved.privacy, ...structural.privacy }, availability: { ...saved.availability, ...structural.availability } };
}
export function assistantSetupSections(draft: AssistantDraft, catalog: AssistantCatalog) {
  const issues = assistantDraftIssues(draft, catalog);
  const categories = [
    { tab: 'basic', label: 'Identity & accounts', matches: /name|preset|receiving account|account assignment/i },
    { tab: 'ai', label: 'Reply model & examples', matches: /model|response control|reply-length|temperature|Top P|demonstration/i },
    { tab: 'knowledge', label: 'Knowledge', matches: /knowledge/i },
    { tab: 'privacy', label: 'Privacy & policies', matches: /confidence|uncertainty|collection field/i },
    { tab: 'playbooks', label: 'Playbooks', matches: /playbook/i },
    { tab: 'followups', label: 'Follow-ups', matches: /follow-up|template/i },
    { tab: 'tools', label: 'Tools & media', matches: /tools|documents|galleries|approval/i },
    { tab: 'availability', label: 'Availability', matches: /availability|timezone|weekday/i },
  ];
  return categories.map(category => ({ ...category, issues: issues.filter(issue => category.matches.test(issue)) }));
}
export function assistantRevisionChanges(before: AssistantDraft, after: AssistantDraft) {
  return (Object.keys(after) as (keyof AssistantDraft)[]).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
/** Runtime orders exact intent, brochure FAQ, then any-intent; lower priority and ID break ties. */
export function previewPlaybookAssignments(draft: AssistantDraft, channel: string, surface: string, intent: string, brochure = false) {
  if (draft.playbooks.mode !== 'selected') return [];
  const rank = (value: string | null) => value === intent ? 0 : value === 'faq' && brochure ? 1 : 2;
  return draft.playbooks.assignments.filter(a => a.channel === channel && a.surface === surface && (a.intent === intent || a.intent === null || (brochure && a.intent === 'faq')))
    .slice().sort((a, b) => rank(a.intent) - rank(b.intent) || a.priority - b.priority || a.playbookId - b.playbookId);
}
