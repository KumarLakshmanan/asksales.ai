import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import { encryptValue, decryptValue } from '../SecretsManager.js';
import { getCrmConfiguration } from '../CRMConfigurationService.js';
import { getCreationOptions, resolveCreationAccount, validateCreationTemplate } from '../outreach/CreationService.js';
import { outreachTemplateFields, type OutreachTemplate } from '../../../shared/outreachCompose.js';
import { decryptChannelCredentialSession } from '../../utils/channelCredentialSecrets.js';
import { ChannelCredentialModel } from '../../models/channelCredentials/functions.js';
import { inspectMSG91Credential } from '../../utils/msg91Credentials.js';
import { assertPublicHttpUrl } from '../../utils/safeRemoteFetch.js';
import {AutomationConfigurationError} from './AutomationErrors.js';
export {AutomationConfigurationError} from './AutomationErrors.js';
import {
  AUTOMATION_ACTIONS, AUTOMATION_CONDITION_FIELDS, AUTOMATION_PLACEHOLDERS, AUTOMATION_TRIGGERS,
  REDACTED_AUTOMATION_SECRET, isRecord, matchAutomation, renderAutomationJson, renderAutomationText,
  resolveAutomationRecipient, validateAutomationDefinition,
  type AutomationAction, type AutomationCatalog, type AutomationContext, type AutomationDefinition,
  type AutomationEvent, type AutomationPreview,
} from '../../../shared/crmAutomations.js';

export function automationScope(userId: number) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new AutomationConfigurationError('Automation account does not match the business profile.', 403);
  return scope;
}
export async function automationRuntimeEnabled(database: Pick<typeof db, 'execute'> = db): Promise<boolean> {
  // Legacy unit-test seams and pre-cutover installations keep their existing evaluator.
  if (typeof database.execute !== 'function') return false;
  try {
    const result = await database.execute(sql`SELECT enabled FROM crm_automation_runtime WHERE id=1`);
    return result.rows[0]?.enabled === true;
  } catch (error) {
    if ((error as { code?: string }).code === '42P01' || (error as { cause?: { code?: string } }).cause?.code === '42P01') return false;
    throw error;
  }
}
export function protectAutomationDefinition(definition: AutomationDefinition, previous?: AutomationDefinition): AutomationDefinition {
  const copy = structuredClone(definition);
  for (const action of copy.actions) {
    if (action.type !== 'webhook' || !isRecord(action.config.headers)) continue;
    const old = previous?.actions.find(item => item.id === action.id && item.type === 'webhook');
    const oldHeaders = isRecord(old?.config.headers) ? old.config.headers : {};
    action.config.headers = Object.fromEntries(Object.entries(action.config.headers).map(([key, value]) => {
      if (value === REDACTED_AUTOMATION_SECRET) {
        if (typeof oldHeaders[key] !== 'string' || !oldHeaders[key].startsWith('sealed:')) throw new AutomationConfigurationError('Enter the webhook header value again.');
        return [key, oldHeaders[key]];
      }
      if (typeof value !== 'string' || value.startsWith('sealed:')) throw new AutomationConfigurationError('Invalid webhook header value.');
      return [key, `sealed:${encryptValue(value)}`];
    }));
  }
  return copy;
}
export async function legacyAutomationEvaluationAllowed():Promise<boolean> {
  if (typeof db.execute!=='function') return true;
  try {const result=await db.execute(sql`SELECT enabled,cutover_at FROM crm_automation_runtime WHERE id=1`);
    return result.rows[0]?.enabled!==true && !result.rows[0]?.cutover_at;
  }catch(error){const code=(error as {code?:string;cause?:{code?:string}}).code || (error as {cause?:{code?:string}}).cause?.code;
    if (code==='42P01') return true;throw error;}
}
export function publicAutomationDefinition(definition: AutomationDefinition): AutomationDefinition {
  const copy = structuredClone(definition);
  for (const action of copy.actions) if (action.type === 'webhook' && isRecord(action.config.headers)) {
    action.config.headers = Object.fromEntries(Object.keys(action.config.headers).map(key => [key, REDACTED_AUTOMATION_SECRET]));
  }
  return copy;
}
export function automationWebhookHeaders(action: AutomationAction): Record<string, string> {
  const headers = isRecord(action.config.headers) ? action.config.headers : {};
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    if (typeof value !== 'string' || !value.startsWith('sealed:')) throw new AutomationConfigurationError('Webhook credentials are unavailable. Save the action again.');
    return [key, decryptValue(value.slice(7))];
  }));
}
export function automationTemplateHash(template: OutreachTemplate): string {
  return createHash('sha256').update(JSON.stringify([template.name, template.language, template.header || '',
    template.headerType || 'TEXT', template.body, template.footer || '', template.buttons || []])).digest('hex');
}
interface TemplateRow { id: number; name: string; language: string; body: string; header?: string; header_type?: string; footer?: string; buttons?: OutreachTemplate['buttons'];
  waba_template_id?: string; meta_status?: string; status?: string; has_local_changes?: boolean }
export function automationOutreachTemplate(row: TemplateRow): OutreachTemplate {
  return { id: String(row.waba_template_id || ''), name: row.name, language: row.language, body: row.body,
    header: row.header || undefined, headerType: row.header_type || 'TEXT', footer: row.footer || undefined, buttons: row.buttons || [] };
}
export function automationTemplateReady(row: TemplateRow): boolean {
  return Boolean(row.waba_template_id && row.has_local_changes === false
    && String(row.meta_status || '').toUpperCase() === 'APPROVED' && String(row.status).toUpperCase() === 'APPROVED'
    && (!row.header_type || row.header_type === 'TEXT'));
}
export async function getAutomationCatalog(userId: number): Promise<AutomationCatalog> {
  const scope = automationScope(userId);
  const [enabled, options, resources, credentials] = await Promise.all([
    automationRuntimeEnabled(),
    Promise.all((['email', 'whatsapp', 'instagram', 'facebook'] as const).map(async channel => {
      const result = await getCreationOptions(userId, channel);
      return result.accounts.map(account => ({ channel, id: channel === 'email' ? String(account.senderId) : account.providerAccountId,
        label: account.label, ready: account.ready, ...(account.reason ? { reason: account.reason } : {}), senderId: account.senderId }));
    })),
    Promise.all([
      db.execute(sql`SELECT id,name FROM outreach_campaigns WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} ORDER BY created_at DESC LIMIT 200`),
      db.execute(sql`SELECT u.id,COALESCE(NULLIF(u.name,''),m.email) AS name FROM business_profile_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.business_profile_id=${scope.businessProfileId} AND m.status='active' ORDER BY name`),
      db.execute(sql`SELECT id,name,language,body,header,header_type,footer,buttons,waba_template_id,meta_status,status,has_local_changes
        FROM whatsapp_templates WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} ORDER BY name`),
    ]),
    db.execute(sql`SELECT id,account_identifier,account_name FROM channel_credentials WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId}
      AND platform='msg91_sms' AND is_active IS TRUE`),
  ]);
  const accounts: AutomationCatalog['accounts'] = options.flat();
  for (const row of credentials.rows) {
    const credential = await ChannelCredentialModel.findActiveAccountByIdentifier(userId, 'msg91_sms', row.account_identifier);
    const readiness = inspectMSG91Credential(credential);
    accounts.push({channel:'sms',id:row.account_identifier,label:row.account_name || readiness.settings.senderId || row.account_identifier,
      ready:readiness.ready,reason:readiness.issue || undefined,flowId:readiness.settings.flowId,messageVariable:readiness.settings.messageVariable});
  }
  const templates = resources[2].rows as TemplateRow[];
  return { triggers: [...AUTOMATION_TRIGGERS], actions: [...AUTOMATION_ACTIONS], fields: [...AUTOMATION_CONDITION_FIELDS], placeholders: [...AUTOMATION_PLACEHOLDERS],
    runtimeEnabled: enabled, accounts, campaigns: resources[0].rows, members: resources[1].rows,
    whatsappTemplates: accounts.filter(item => item.channel === 'whatsapp').flatMap(account => templates.map(template => {
      const contract = automationOutreachTemplate(template);
      return { id: Number(template.id), name: template.name, language: template.language, accountId: account.id,
        variables: outreachTemplateFields(contract).map(field => field.key), ready: account.ready && automationTemplateReady(template), hash: automationTemplateHash(contract) };
    })) };
}
export async function validateAutomationForSave(userId: number, definition: AutomationDefinition, active: boolean): Promise<void> {
  automationScope(userId);
  const errors = validateAutomationDefinition(publicAutomationDefinition(definition));
  if (errors.length) throw new AutomationConfigurationError(errors.join(' '));
  const configuration = await getCrmConfiguration(userId);
  if (definition.trigger.type === 'pipeline_status_change') for (const key of [definition.trigger.config.fromStatus, definition.trigger.config.toStatus]) {
    if (key && !configuration.stages.some(stage => stage.key === key)) throw new AutomationConfigurationError('Select a valid pipeline stage from CRM configuration.');
  }
  for (const condition of definition.conditions.rules) if ((condition.field === 'contact.pipelineStatus'
    || definition.trigger.type === 'pipeline_status_change' && ['event.oldValue','event.newValue'].includes(condition.field))
    && ['equals','not_equals'].includes(condition.operator) && !configuration.stages.some(stage => stage.key === condition.value)) {
    throw new AutomationConfigurationError('Select a valid pipeline stage for the condition.');
  }
  for (const action of definition.actions) if (action.type === 'update_pipeline_status'
    && !configuration.stages.some(stage => stage.key === action.config.pipelineStatus)) throw new AutomationConfigurationError('Select a valid destination pipeline stage.');
  const catalog = await getAutomationCatalog(userId);
  if (definition.trigger.config.campaignId && !catalog.campaigns.some(campaign => campaign.id === definition.trigger.config.campaignId)) throw new AutomationConfigurationError('Select a campaign from this business profile.');
  const source = definition.trigger.type.split('_')[0];
  if (['whatsapp','instagram','facebook'].includes(source) && active) {
    if (!catalog.accounts.some(account => account.channel === source && account.ready && (!definition.trigger.config.accountId || account.id === definition.trigger.config.accountId)))
      throw new AutomationConfigurationError('Connect the selected receiving account before activating this automation.');
  }
  for (const action of definition.actions) {
    if (action.type === 'assign_user' && !catalog.members.some(member => member.id === action.config.assignedTo)) throw new AutomationConfigurationError('Choose an active member of this workspace.');
    if (action.type !== 'send_notification') continue;
    const account = catalog.accounts.find(item => item.channel === action.config.channel && (item.channel === 'email' ? item.senderId === action.config.senderId : item.id === action.config.providerAccountId));
    if (!account) throw new AutomationConfigurationError('Choose a sending account from this business profile.');
    if (active && !account.ready) throw new AutomationConfigurationError(account.reason || 'Reconnect the selected sending account before activating.');
    if (action.config.channel === 'sms' && action.config.flowId !== account.flowId) throw new AutomationConfigurationError('Use the SMS flow/template configured for the selected sender.');
    if (action.config.channel === 'whatsapp') {
      const template = catalog.whatsappTemplates.find(item => item.id === action.config.templateId && item.accountId === account.id && item.language === action.config.language);
      if (!template || !template.ready) throw new AutomationConfigurationError('Choose a currently approved text WhatsApp template.');
      if (action.config.templateHash && action.config.templateHash !== template.hash) throw new AutomationConfigurationError('The WhatsApp template changed. Select it again and review its variables.');
      action.config.templateHash = template.hash;
      if (!isRecord(action.config.variables) || template.variables.some(variable => !String((action.config.variables as Record<string, unknown>)[variable] || '').trim())
        || Object.keys(action.config.variables).some(variable => !template.variables.includes(variable))) throw new AutomationConfigurationError('Complete the WhatsApp template variable mappings.');
    }
  }
}

export async function renderNotificationAction(userId: number, action: AutomationAction, context: AutomationContext, live = false) {
  const scope = automationScope(userId), c = action.config;
  const recipient = resolveAutomationRecipient(c, context);
  const channel = c.channel as 'email' | 'whatsapp' | 'sms';
  const resolved = channel === 'sms' ? await (async () => {
    const credential = await ChannelCredentialModel.findActiveAccountByIdentifier(userId, 'msg91_sms', String(c.providerAccountId));
    const ready = inspectMSG91Credential(credential);
    return {account:{providerAccountId:String(c.providerAccountId),senderId:undefined,ready:ready.ready,reason:ready.issue},binding:credential};
  })() : await resolveCreationAccount(userId, channel, { senderId: Number(c.senderId) || undefined, providerAccountId: String(c.providerAccountId || '') || undefined });
  const {account,binding}=resolved;
  if (!account.ready || !binding) throw new AutomationConfigurationError(account.reason || 'The sending account is unavailable.');
  const optedOut = await db.execute(sql`SELECT 1 FROM crm_contacts contact LEFT JOIN leads lead ON lead.id=contact.lead_id AND lead.user_id=contact.user_id
    WHERE contact.user_id=${userId} AND contact.business_profile_id=${scope.businessProfileId} AND contact.deleted_at IS NULL
      AND ((${channel === 'email'} AND lower(contact.email)=lower(${recipient})) OR (${channel !== 'email'} AND regexp_replace(COALESCE(contact.phone,''),'[^0-9]','','g')=${recipient.replace(/\D/g,'')}))
      AND (lead.blacklisted IS TRUE OR lead.do_not_contact IS TRUE OR (${channel === 'email'} AND lead.email_unsubscribed IS TRUE) OR EXISTS(SELECT 1 FROM outreach_conversations conversation
        WHERE conversation.user_id=${userId} AND conversation.business_profile_id=${scope.businessProfileId} AND conversation.crm_contact_id=contact.id
          AND conversation.channel IN (${channel},CASE WHEN ${channel}='email' THEN 'gmail' ELSE ${channel} END)
          AND (conversation.status IN ('unsubscribed','opted_out') OR conversation.automation_mode='opted_out'))) LIMIT 1`);
  if (optedOut.rows.length) throw new AutomationConfigurationError('This recipient has opted out of this notification channel.');
  const leadOptedOut=await db.execute(sql`SELECT 1 FROM leads lead WHERE lead.user_id=${userId}
    AND lead.business_profile_id=${scope.businessProfileId} AND lead.deleted_at IS NULL
    AND ((${channel === 'email'} AND lower(lead.email)=lower(${recipient}))
      OR (${channel !== 'email'} AND regexp_replace(COALESCE(lead.phone,''),'[^0-9]','','g')=${recipient.replace(/\D/g,'')}))
    AND (lead.blacklisted IS TRUE OR lead.do_not_contact IS TRUE OR (${channel === 'email'} AND lead.email_unsubscribed IS TRUE)
      OR EXISTS(SELECT 1 FROM outreach_conversations conversation WHERE conversation.lead_id=lead.id
        AND conversation.user_id=${userId} AND conversation.business_profile_id=${scope.businessProfileId}
        AND conversation.channel IN (${channel},CASE WHEN ${channel}='email' THEN 'gmail' ELSE ${channel} END)
        AND (conversation.status IN ('unsubscribed','opted_out') OR conversation.automation_mode='opted_out'))) LIMIT 1`);
  if (leadOptedOut.rows.length) throw new AutomationConfigurationError('This recipient has opted out of this notification channel.');
  if (c.channel === 'email') return { recipient, channel, accountId: account.providerAccountId, senderId: account.senderId,
    subject: renderAutomationText(String(c.subject), context), message: renderAutomationText(String(c.message), context) };
  if (c.channel === 'sms') {
    const settings = await db.execute(sql`SELECT session_data FROM channel_credentials WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId}
      AND platform='msg91_sms' AND account_identifier=${account.providerAccountId} AND is_active IS TRUE LIMIT 1`);
    const configuration = decryptChannelCredentialSession(settings.rows[0]?.session_data) as { flowId?: string; dltTemplateId?: string } | null;
    if (!configuration || (configuration.flowId || configuration.dltTemplateId) !== c.flowId) throw new AutomationConfigurationError('The selected SMS flow/template changed. Review the notification action.');
    return { recipient, channel, accountId: account.providerAccountId, flowId: String(c.flowId), message: renderAutomationText(String(c.message), context) };
  }
  const result = await db.execute(sql`SELECT id,name,language,body,header,header_type,footer,buttons,waba_template_id,meta_status,status,has_local_changes
    FROM whatsapp_templates WHERE id=${Number(c.templateId)} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} LIMIT 1`);
  const row = result.rows[0] as TemplateRow | undefined;
  if (!row || !automationTemplateReady(row) || row.language !== c.language) throw new AutomationConfigurationError('The selected WhatsApp template is no longer approved.');
  let template = automationOutreachTemplate(row);
  if (automationTemplateHash(template) !== c.templateHash) throw new AutomationConfigurationError('The WhatsApp template changed. Select and review it again.');
  if (live) {
    const { whatsappApiService } = await import('../whatsappApiService.js');
    const approved = await whatsappApiService.listApprovedTemplates(userId, account.providerAccountId);
    const current = approved.find(item => item.id === row.waba_template_id && item.name === row.name && item.language === row.language);
    if (!current || automationTemplateHash(current) !== automationTemplateHash(template)) throw new AutomationConfigurationError('The approved WhatsApp template does not match the selected sending account or saved version.');
    template = current;
  }
  const fields = outreachTemplateFields(template), variables = c.variables as Record<string, string>;
  const components: Record<string, unknown>[] = [];
  for (const section of ['header','body'] as const) {
    const parameters = fields.filter(field => field.section === section).map(field => ({ type: 'text', text: renderAutomationText(variables[field.key] || '', context),
      ...(!/^\d+$/.test(field.token) ? { parameter_name: field.token } : {}) }));
    if (parameters.length) components.push({ type: section, parameters });
  }
  for (const field of fields.filter(item => item.section === 'button')) components.push({ type: 'button', sub_type: 'url', index: String(field.buttonIndex),
    parameters: [{ type: 'text', text: renderAutomationText(variables[field.key] || '', context) }] });
  const rendered = validateCreationTemplate(template, components);
  return { recipient, channel, accountId: account.providerAccountId, templateName: template.name, language: template.language, components,
    message: typeof rendered === 'string' ? rendered : template.body };
}

export async function previewAutomation(userId: number, definition: AutomationDefinition, event: AutomationEvent): Promise<AutomationPreview> {
  await validateAutomationForSave(userId, definition, false);
  const result = matchAutomation(definition, event);
  const actions: AutomationPreview['actions'] = [];
  for (const action of definition.actions) {
    try {
      if (action.type === 'send_notification') {
        const rendered = await renderNotificationAction(userId, action, event.context, false);
        actions.push({ id: action.id, type: action.type, recipient: rendered.recipient, rendered, ready: true });
      } else if (action.type === 'webhook') {
        await assertPublicHttpUrl(String(action.config.url));
        actions.push({ id: action.id, type: action.type, rendered: { url: action.config.url, body: renderAutomationJson(action.config.body, event.context),
          headers: Object.keys(isRecord(action.config.headers) ? action.config.headers : {}) }, ready: true });
      } else {
        if (!event.contactId && !event.context.contact?.id) throw new AutomationConfigurationError('This sample event has no contact.');
        actions.push({ id: action.id, type: action.type, rendered: renderAutomationJson(action.config, event.context) as Record<string, unknown>, ready: true });
      }
    } catch (error) { actions.push({ id: action.id, type: action.type, ready: false, error: error instanceof Error ? error.message : 'Action is unavailable.' }); }
  }
  return { ...result, actions, warnings: ['Preview only. No messages, webhooks, billing, or CRM changes were performed.'] };
}
