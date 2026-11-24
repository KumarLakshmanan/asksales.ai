import { isRecord } from './records.js';
import { isEmailAddress } from './emailAddress.js';
export { isRecord };
/** Shared, dependency-free contracts for the CRM automation editor and runner. */
export const AUTOMATION_TRIGGERS = [
  { type: 'contact_created', group: 'CRM', label: 'Contact created', description: 'A new CRM contact is saved.', contact: true },
  { type: 'contact_updated', group: 'CRM', label: 'Contact updated', description: 'Contact details, tags, or ownership change.', contact: true },
  { type: 'status_change', group: 'CRM', label: 'Contact status changes', description: 'A contact moves to another lifecycle status.', contact: true },
  { type: 'pipeline_status_change', group: 'CRM', label: 'Pipeline stage changes', description: 'A contact moves between configured pipeline stages.', contact: true },
  ...(['whatsapp', 'instagram', 'facebook'] as const).flatMap(channel => {
    const group = channel === 'whatsapp' ? 'WhatsApp' : channel === 'instagram' ? 'Instagram' : 'Messenger';
    return [
      { type: `${channel}_message_received`, group, label: 'New message', description: `An incoming ${group} message is saved.`, contact: true },
      { type: `${channel}_message_sent`, group, label: 'Message sent', description: 'The provider confirms acceptance of an outbound message.', contact: true },
      { type: `${channel}_message_echo`, group, label: 'Message echo', description: 'An outbound message from the native app is received.', contact: true },
      { type: `${channel}_message_status`, group, label: 'Message status', description: 'Delivery, read, or failure status changes.', contact: true },
    ];
  }),
  { type: 'instagram_comment_received', group: 'Instagram', label: 'New comment', description: 'A new customer comment is saved.', contact: true },
  { type: 'ticket_created', group: 'Support and Inbox', label: 'Ticket created', description: 'A support ticket enters the queue.', contact: true },
  { type: 'ticket_assigned', group: 'Support and Inbox', label: 'Ticket assigned', description: 'A ticket is assigned or reassigned.', contact: true },
  { type: 'ticket_unassigned', group: 'Support and Inbox', label: 'Ticket unassigned', description: 'The assignee is removed from a ticket.', contact: true },
  { type: 'ticket_status_changed', group: 'Support and Inbox', label: 'Ticket status changes', description: 'A ticket changes status.', contact: true },
  { type: 'conversation_handoff', group: 'Support and Inbox', label: 'Conversation handoff', description: 'A conversation is handed to the support team.', contact: true },
  { type: 'conversation_status_changed', group: 'Support and Inbox', label: 'Conversation status changes', description: 'The inbox conversation changes status.', contact: true },
  { type: 'ai_response_sent', group: 'Support and Inbox', label: 'AI response sent', description: 'An AI reply is accepted by its channel provider.', contact: true },
  { type: 'follow_up_sent', group: 'Support and Inbox', label: 'Follow-up sent', description: 'A scheduled follow-up is accepted by its provider.', contact: true },
  { type: 'campaign_started', group: 'Outreach campaigns', label: 'Campaign started', description: 'An outreach campaign starts sending.', contact: false },
  { type: 'campaign_completed', group: 'Outreach campaigns', label: 'Campaign completed', description: 'An outreach campaign finishes sending.', contact: false },
  { type: 'campaign_failed', group: 'Outreach campaigns', label: 'Campaign failed', description: 'An outreach campaign enters a failed state.', contact: false },
  { type: 'campaign_message_sent', group: 'Outreach campaigns', label: 'Campaign message sent', description: 'An individual campaign message is accepted.', contact: true },
  { type: 'campaign_reply_received', group: 'Outreach campaigns', label: 'Campaign reply received', description: 'A reply is linked to a campaign.', contact: true },
] as const;

export const AUTOMATION_ACTIONS = [
  { type: 'create_ticket', label: 'Create support ticket', description: 'Create a ticket linked to the triggering contact.', contact: true },
  { type: 'update_pipeline_status', label: 'Move pipeline stage', description: 'Move the contact to a configured CRM stage.', contact: true },
  { type: 'update_tags', label: 'Add contact tags', description: 'Add tags without creating duplicates.', contact: true },
  { type: 'remove_tags', label: 'Remove contact tags', description: 'Remove the selected tags from the contact.', contact: true },
  { type: 'assign_user', label: 'Assign contact', description: 'Assign the contact to a workspace member.', contact: true },
  { type: 'webhook', label: 'Webhook', description: 'Send a JSON payload to an external HTTP endpoint.', contact: false },
  { type: 'send_notification', label: 'Send notification', description: 'Send an email, WhatsApp template, or SMS.', contact: false },
] as const;

export type AutomationActionType = (typeof AUTOMATION_ACTIONS)[number]['type'] | 'update_status';
export interface AutomationRecipient { mode: 'fixed' | 'contact'; value?: string }
export interface AutomationAction {
  id: string;
  type: AutomationActionType;
  config: Record<string, unknown>;
}
export const AUTOMATION_CONDITION_FIELDS = [
  { key: 'event.channel', label: 'Channel', kind: 'text' },
  { key: 'event.accountId', label: 'Receiving account', kind: 'text' },
  { key: 'event.oldValue', label: 'Previous status or stage', kind: 'text' },
  { key: 'event.newValue', label: 'New status or stage', kind: 'text' },
  { key: 'event.status', label: 'Message status', kind: 'text' },
  { key: 'contact.status', label: 'Contact status', kind: 'text' },
  { key: 'contact.pipelineStatus', label: 'Pipeline stage', kind: 'text' },
  { key: 'contact.tags', label: 'Contact tags', kind: 'tags' },
  { key: 'contact.dealValue', label: 'Deal value', kind: 'number' },
  { key: 'message.text', label: 'Message text', kind: 'text' },
  { key: 'campaign.id', label: 'Campaign', kind: 'number' },
  { key: 'ticket.priority', label: 'Ticket priority', kind: 'text' },
] as const;
export type AutomationConditionField = (typeof AUTOMATION_CONDITION_FIELDS)[number]['key'];
export type AutomationOperator = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'exists' | 'gte' | 'lte';
export interface AutomationCondition {
  id: string;
  field: AutomationConditionField;
  operator: AutomationOperator;
  value?: string | number;
}
export interface AutomationDefinition {
  version: 2;
  trigger: { type: string; config: { accountId?: string; campaignId?: number; fromStatus?: string; toStatus?: string } };
  conditions: { match: 'all' | 'any'; rules: AutomationCondition[] };
  actions: AutomationAction[];
}
export interface AutomationContext {
  event?: { channel?: string; accountId?: string; oldValue?: string; newValue?: string; status?: string };
  contact?: { id?: number; name?: string; email?: string | null; phone?: string | null; status?: string; pipelineStatus?: string; tags?: string[]; dealValue?: number | string | null };
  message?: { id?: number; text?: string; status?: string; direction?: string };
  ticket?: { id?: number; number?: string; subject?: string; priority?: string; status?: string };
  campaign?: { id?: number; name?: string; status?: string };
  conversation?: { id?: number; status?: string };
}
export interface AutomationEvent {
  type: string;
  sourceKey: string;
  occurredAt: string;
  origin?: string;
  contactId?: number | null;
  conversationId?: number | null;
  campaignId?: number | null;
  context: AutomationContext;
}
export interface AutomationRule {
  id: number; name: string; description?: string | null;
  definition: AutomationDefinition; revision: number; isActive: boolean;
  priority: number; executionCount: number; lastRunAt: string | null; createdAt: string;
  triggerType: string; triggerConfig: Record<string, unknown>;
  action: string; actionConfig: Record<string, unknown>;
}
export interface AutomationRun {
  id: number; automationId: number; automationName: string; revision: number;
  eventType: string; contactId?: number | null; contactName?: string | null;
  status: 'queued' | 'running' | 'retry' | 'success' | 'failed' | 'skipped' | 'cancelled' | 'uncertain';
  errorMessage?: string | null; createdAt: string; completedAt?: string | null;
}
export interface AutomationRunStep {
  id: number; stepId: string; position: number; actionType: string; status: string;
  attempts: number; errorMessage?: string | null; result?: Record<string, unknown>;
  providerMessageId?: string | null; providerStatus?: string | null; completedAt?: string | null;
}
export interface AutomationCatalog {
  triggers: Array<(typeof AUTOMATION_TRIGGERS)[number]>;
  actions: Array<(typeof AUTOMATION_ACTIONS)[number]>;
  fields: Array<(typeof AUTOMATION_CONDITION_FIELDS)[number]>;
  placeholders: string[];
  runtimeEnabled: boolean;
  accounts: Array<{ channel: string; id: string; label: string; ready: boolean; reason?: string; senderId?: number; flowId?: string; messageVariable?: string }>;
  campaigns: Array<{ id: number; name: string }>;
  members: Array<{ id: number; name: string }>;
  whatsappTemplates: Array<{ id: number; name: string; language: string; accountId: string; variables: string[]; ready: boolean; hash: string }>;
}
export interface AutomationPreview {
  matches: boolean;
  triggerMatches: boolean;
  conditions: Array<{ id: string; matches: boolean }>;
  actions: Array<{ id: string; type: string; recipient?: string; rendered?: Record<string, unknown>; ready: boolean; error?: string }>;
  warnings: string[];
}

export const AUTOMATION_PLACEHOLDERS = [
  'contact.name', 'contact.email', 'contact.phone', 'contact.status', 'contact.pipelineStatus',
  'event.channel', 'event.accountId', 'event.oldValue', 'event.newValue', 'event.status',
  'ticket.number', 'ticket.subject', 'ticket.priority', 'campaign.name', 'campaign.id',
] as const;
export const REDACTED_AUTOMATION_SECRET = '__REDACTED__';
export const CONTACT_STATUSES = ['new','contacted','replied','interested','negotiable','negotiations','demo','proposal_sent','ticket_open','ticket_close','won','lost'] as const;
export const newAutomationDefinition = (): AutomationDefinition => ({
  version: 2, trigger: { type: '', config: {} }, conditions: { match: 'all', rules: [] }, actions: [],
});
export function automationOperators(kind: string): AutomationOperator[] {
  return kind === 'number' ? ['equals', 'not_equals', 'gte', 'lte', 'exists']
    : kind === 'tags' ? ['contains', 'not_contains', 'exists']
      : ['equals', 'not_equals', 'contains', 'not_contains', 'exists'];
}
export function contextValue(context: AutomationContext, field: string): unknown {
  const [group, key] = field.split('.');
  const values = context[group as keyof AutomationContext];
  return values && key && Object.hasOwn(values, key) ? (values as Record<string, unknown>)[key] : undefined;
}
export function evaluateAutomationCondition(rule: AutomationCondition, context: AutomationContext): boolean {
  const actual = contextValue(context, rule.field);
  if (rule.operator === 'exists') return actual !== undefined && actual !== null && actual !== '' && (!Array.isArray(actual) || actual.length > 0);
  if (actual === undefined || actual === null) return false;
  if (rule.operator === 'gte' || rule.operator === 'lte') {
    const left = Number(actual), right = Number(rule.value);
    return Number.isFinite(left) && Number.isFinite(right) && (rule.operator === 'gte' ? left >= right : left <= right);
  }
  const left = String(actual).toLocaleLowerCase(), right = String(rule.value ?? '').toLocaleLowerCase();
  const contains = Array.isArray(actual) ? actual.some(value => String(value).toLocaleLowerCase() === right) : left.includes(right);
  switch (rule.operator) {
    case 'equals': return left === right;
    case 'not_equals': return left !== right;
    case 'contains': return contains;
    case 'not_contains': return !contains;
    default: return false;
  }
}
export function matchAutomation(definition: AutomationDefinition, event: AutomationEvent) {
  const config = definition.trigger.config;
  const triggerMatches = event.origin !== 'automation' && event.type === definition.trigger.type
    && (!config.accountId || config.accountId === event.context.event?.accountId)
    && (!config.campaignId || config.campaignId === event.campaignId || config.campaignId === event.context.campaign?.id)
    && (!config.fromStatus || config.fromStatus === event.context.event?.oldValue)
    && (!config.toStatus || config.toStatus === event.context.event?.newValue);
  const conditions = definition.conditions.rules.map(rule => ({ id: rule.id, matches: evaluateAutomationCondition(rule, event.context) }));
  const conditionsMatch = !conditions.length || (definition.conditions.match === 'all'
    ? conditions.every(rule => rule.matches) : conditions.some(rule => rule.matches));
  return { matches: triggerMatches && conditionsMatch, triggerMatches, conditions };
}
export function renderAutomationText(text: string, context: AutomationContext): string {
  const rendered = text.replace(/{{([^{}]*)}}/g, (_match, rawField: string) => {
    const field=rawField.trim();
    if (!(AUTOMATION_PLACEHOLDERS as readonly string[]).includes(field)) throw new Error(`Unsupported placeholder: ${field}`);
    const value = contextValue(context, field);
    if (value === undefined || value === null || value === '') throw new Error(`The event does not contain ${field}.`);
    return String(value);
  });
  if (rendered.includes('{{') || rendered.includes('}}')) throw new Error('Invalid placeholder syntax.');
  return rendered;
}
export function renderAutomationJson(value: unknown, context: AutomationContext): unknown {
  if (typeof value === 'string') return renderAutomationText(value, context);
  if (Array.isArray(value)) return value.map(item => renderAutomationJson(item, context));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderAutomationJson(item, context)]));
  return value;
}
export function resolveAutomationRecipient(config: Record<string, unknown>, context: AutomationContext): string {
  const recipient = config.recipient as AutomationRecipient | undefined;
  const value = recipient?.mode === 'fixed' ? recipient.value
    : recipient?.mode === 'contact' ? config.channel === 'email' ? context.contact?.email : context.contact?.phone : undefined;
  if (!value) throw new Error(`The ${recipient?.mode === 'contact' ? 'contact has no' : 'action needs a'} ${config.channel === 'email' ? 'email address' : 'phone number'}.`);
  const normalized = String(value).trim().replace(config.channel === 'email' ? /$^/g : /[\s()-]/g, '');
  if (config.channel === 'email' ? !isEmailAddress(normalized) : !/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error(config.channel === 'email' ? 'Enter a valid recipient email address.' : 'Use an international phone number, including + and the country code.');
  }
  return normalized;
}
export function legacyAutomationDefinition(row: {
  triggerType: string; triggerConfig?: Record<string, unknown> | null;
  action: string; actionConfig?: Record<string, unknown> | null; condition?: Record<string, unknown> | null;
}): AutomationDefinition {
  const config = row.triggerConfig || {};
  return {
    version: 2,
    trigger: { type: row.triggerType, config: {
      ...(typeof config.fromStatus === 'string' && config.fromStatus !== 'any' ? { fromStatus: config.fromStatus } : {}),
      ...(typeof config.toStatus === 'string' && config.toStatus !== 'any' ? { toStatus: config.toStatus } : {}),
    } },
    conditions: { match: 'all', rules: [] },
    actions: [{ id: 'legacy-action', type: row.action as AutomationActionType, config: row.actionConfig || {} }],
  };
}

/** Validation is shared so a preview, a saved rule, and a live run agree. */
export function validateAutomationDefinition(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.trigger) || !isRecord(value.conditions) || !Array.isArray(value.actions)) return ['Provide a version 2 automation definition.'];
  const triggerType = value.trigger.type;
  const trigger = AUTOMATION_TRIGGERS.find(item => item.type === triggerType);
  if (!trigger) errors.push('Choose a supported trigger.');
  const config = value.trigger.config;
  if (!isRecord(config)) errors.push('Provide the trigger configuration.');
  else {
    if (Object.keys(config).some(key => !['accountId', 'campaignId', 'fromStatus', 'toStatus'].includes(key))) errors.push('The trigger contains unsupported filters.');
    for (const key of ['accountId', 'fromStatus', 'toStatus']) if (config[key] !== undefined && (typeof config[key] !== 'string' || !String(config[key]).trim() || String(config[key]).length > 255)) errors.push(`Invalid trigger ${key}.`);
    if (config.campaignId !== undefined && (!Number.isSafeInteger(config.campaignId) || Number(config.campaignId) <= 0)) errors.push('Choose a valid campaign.');
  }
  if (!['all', 'any'].includes(String(value.conditions.match)) || !Array.isArray(value.conditions.rules) || value.conditions.rules.length > 30) errors.push('Use an All or Any group with at most 30 conditions.');
  else {
    const conditionIds = new Set<string>();
    for (const rule of value.conditions.rules) {
      if (!isRecord(rule)) { errors.push('Invalid condition.'); continue; }
      const field = AUTOMATION_CONDITION_FIELDS.find(item => item.key === rule.field);
      if (!field || !automationOperators(field.kind).includes(rule.operator as AutomationOperator)) errors.push('Choose a supported condition field and operator.');
      if (typeof rule.id !== 'string' || !/^[\w-]{1,80}$/.test(rule.id) || conditionIds.has(rule.id)) errors.push('Each condition needs a unique identifier.');
      conditionIds.add(String(rule.id));
      if (rule.operator !== 'exists' && (typeof rule.value !== 'string' && typeof rule.value !== 'number' || String(rule.value).length > 1000 || rule.value === '')) errors.push('Enter a condition value.');
      if (field?.kind === 'number' && rule.operator !== 'exists' && !Number.isFinite(Number(rule.value))) errors.push('Enter a numeric condition value.');
      if (trigger?.contact === false && String(rule.field).startsWith('contact.')) errors.push('This trigger does not have a contact.');
    }
  }
  if (!value.actions.length || value.actions.length > 20) errors.push('Add between 1 and 20 actions.');
  const actionIds = new Set<string>();
  const checkText = (text: unknown, name: string, required = true, max = 10_000) => {
    if (text === undefined && !required) return;
    if (typeof text !== 'string' || required && !text.trim() || String(text).length > max) { errors.push(`Enter a valid ${name}.`); return; }
    for (const token of text.matchAll(/{{([^{}]*)}}/g)) if (!(AUTOMATION_PLACEHOLDERS as readonly string[]).includes(token[1].trim())) errors.push(`Unsupported placeholder: ${token[1].trim()}`);
    const outsidePlaceholders=text.replace(/{{([^{}]*)}}/g,'');
    if (outsidePlaceholders.includes('{{') || outsidePlaceholders.includes('}}')) errors.push(`Invalid placeholder syntax in ${name}.`);
    if (trigger?.contact === false && /{{\s*contact\./.test(text)) errors.push('Contact placeholders are unavailable for this trigger.');
  };
  for (const action of value.actions) {
    if (!isRecord(action) || !isRecord(action.config)) { errors.push('Invalid action configuration.'); continue; }
    const type = AUTOMATION_ACTIONS.find(item => item.type === action.type);
    if (!type && action.type !== 'update_status') errors.push('Choose a supported action.');
    if (typeof action.id !== 'string' || !/^[\w-]{1,80}$/.test(action.id) || actionIds.has(action.id)) errors.push('Each action needs a unique identifier.');
    actionIds.add(String(action.id));
    if (trigger?.contact === false && (type?.contact || action.type === 'update_status')) errors.push('This action requires a contact trigger.');
    const c = action.config;
    switch (action.type) {
      case 'update_tags': case 'remove_tags':
        if (!Array.isArray(c.tags) || !c.tags.length || c.tags.length > 20 || c.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 50)) errors.push('Provide 1–20 tags, each up to 50 characters.');
        break;
      case 'update_pipeline_status': if (typeof c.pipelineStatus !== 'string' || !c.pipelineStatus) errors.push('Choose a destination pipeline stage.'); break;
      case 'update_status': if (!(CONTACT_STATUSES as readonly unknown[]).includes(c.status)) errors.push('Choose a valid contact status.'); break;
      case 'assign_user': if (!Number.isSafeInteger(c.assignedTo) || Number(c.assignedTo) <= 0) errors.push('Choose a workspace member.'); break;
      case 'create_ticket':
        checkText(c.subject ?? 'Auto-generated support ticket', 'ticket subject', true, 500);
        checkText(c.description, 'ticket description', false);
        if (c.priority !== undefined && !['low', 'medium', 'high', 'urgent'].includes(String(c.priority))) errors.push('Choose a valid ticket priority.');
        break;
      case 'webhook': {
        try { const url = new URL(String(c.url)); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) throw new Error(); }
        catch { errors.push('Enter a public HTTP or HTTPS webhook URL.'); }
        if (!isRecord(c.body)) errors.push('The webhook payload must be a JSON object.');
        if (c.headers !== undefined && (!isRecord(c.headers) || Object.keys(c.headers).length > 20 || Object.entries(c.headers).some(([key, header]) => !/^[A-Za-z0-9-]{1,80}$/.test(key) || ['host', 'content-length', 'content-type', 'idempotency-key', 'cookie'].includes(key.toLowerCase()) || typeof header !== 'string' || header.length > 4096 || /[\r\n]/.test(header)))) errors.push('Enter valid webhook headers.');
        if (JSON.stringify(c.body ?? {}).length > 20_000) errors.push('Webhook payload is too large.');
        const checkJson = (item: unknown) => { if (typeof item === 'string') checkText(item, 'webhook value', false); else if (Array.isArray(item)) item.forEach(checkJson); else if (isRecord(item)) Object.values(item).forEach(checkJson); };
        checkJson(c.body);
        break;
      }
      case 'send_notification':
        if (!['email', 'whatsapp', 'sms'].includes(String(c.channel))) errors.push('Choose email, WhatsApp, or SMS.');
        if (!isRecord(c.recipient) || !['fixed', 'contact'].includes(String(c.recipient.mode))) errors.push('Choose a recipient mode.');
        else if (c.recipient.mode === 'contact' && trigger?.contact === false) errors.push('This trigger does not have a contact recipient.');
        else if (c.recipient.mode === 'fixed') { try { resolveAutomationRecipient(c, {}); } catch (error) { errors.push((error as Error).message); } }
        if (c.channel === 'email') {
          if (!Number.isSafeInteger(c.senderId) || Number(c.senderId) <= 0) errors.push('Choose an email sender.');
          checkText(c.subject, 'email subject', true, 500); checkText(c.message, 'email message');
        } else {
          if (typeof c.providerAccountId !== 'string' || !c.providerAccountId.trim()) errors.push('Choose a sending account.');
          if (c.channel === 'whatsapp') {
            if (!Number.isSafeInteger(c.templateId) || Number(c.templateId) <= 0) errors.push('Choose an approved WhatsApp template.');
            if (typeof c.language !== 'string' || !c.language) errors.push('Choose the template language.');
            if (!isRecord(c.variables) || Object.values(c.variables).some(item => typeof item !== 'string')) errors.push('Provide template variable mappings.');
            else Object.values(c.variables).forEach(item => checkText(item, 'template variable'));
          } else {
            if (typeof c.flowId !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(c.flowId)) errors.push('Enter the configured SMS flow/template ID.');
            checkText(c.message, 'SMS message', true, 1600);
          }
        }
        break;
    }
  }
  return [...new Set(errors)];
}

export function sampleAutomationEvent(type: string): AutomationEvent {
  const channel = type.startsWith('whatsapp_') ? 'whatsapp' : type.startsWith('instagram_') ? 'instagram' : type.startsWith('facebook_') ? 'facebook' : 'email';
  return { type, sourceKey: 'preview-only', occurredAt: new Date().toISOString(), origin: 'preview', contactId: 1, conversationId: 1, campaignId: 1,
    context: { event: { channel, accountId: 'sample-account', oldValue: 'new', newValue: 'qualified', status: 'delivered' },
      contact: { id: 1, name: 'Sample contact', email: 'contact@example.test', phone: '+919876543210', status: 'interested', pipelineStatus: 'qualified', tags: ['interested'], dealValue: 5000 },
      message: { id: 1, text: 'I would like more information', status: 'delivered', direction: 'inbound' },
      ticket: { id: 1, number: 'TKT-SAMPLE', subject: 'Sample request', priority: 'high', status: 'open' },
      campaign: { id: 1, name: 'Sample campaign', status: 'running' }, conversation: { id: 1, status: 'replied' } } };
}
