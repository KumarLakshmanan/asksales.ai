import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { proposalsTable } from '../models/proposals/schema.js';
import { supportDeliveryOutboxTable, type SupportDeliveryOutboxRecord } from '../models/supportOrchestration/schema.js';
import { proposalApprovalFingerprint } from './ProposalWorkspaceService.js';
import { getProposalReadiness, type ProposalChannel, type ProposalDocument, type ReadinessIssue } from '../../shared/proposals.js';
import { asRecord as record } from '../../shared/records.js';
import { escapeHtml } from '../../shared/html.js';

export interface ProposalDeliveryInput {
  channel?: ProposalChannel;
  outreachConversationId?: number;
  leadId?: number;
  providerAccountId?: string;
  providerVariant?: 'gmail' | 'resend';
  recipientName?: string;
  recipientEmail?: string;
  message?: string;
  subject?: string;
  expectedRevision?: number;
  idempotencyKey?: string;
  whatsappTemplate?: { name: string; language: string; components: unknown[] };
}

/** This exact object is saved on the proposal before its content is approved. */
export interface ProposalDeliveryTarget {
  channel: ProposalChannel;
  outreachConversationId: number | null;
  leadId: number | null;
  recipient: string;
  recipientName: string;
  recipientEmail: string | null;
  providerAccountId: string;
  credentialId: number;
  providerVariant?: 'gmail' | 'resend';
  senderEmail?: string;
  senderId?: number;
  subject: string;
  message: string;
  whatsappTemplate?: { name: string; language: string; components: unknown[] };
}

export type DeliveryProposal = ProposalDocument & {
  id: number; userId: number; revision: number; status: string;
  contactId?: number | null; leadId?: number | null; outreachConversationId?: number | null;
  publicTokenHash?: string | null; publicTokenExpiresAt?: Date | null;
  [key: string]: unknown;
};
export type ProposalProviderReceipt = {
  success: boolean; messageId?: string; rfcMessageId?: string; threadId?: string;
  error?: string; deliveryAttempted?: boolean; outcomeUncertain?: boolean;
};
export class ProposalDeliveryError extends Error {
  constructor(message: string, public statusCode = 409, public code = 'PROPOSAL_DELIVERY_REVIEW_REQUIRED', public issues?: ReadinessIssue[]) { super(message); }
}
type Action = SupportDeliveryOutboxRecord;
type Review = { target: ProposalDeliveryTarget; issues: ReadinessIssue[] };
type ClaimInput = { proposal: DeliveryProposal; target: ProposalDeliveryTarget; key: string; requestDigest: string; token: string };
/** The seam is intentionally the durable repository/provider boundary, so race and recovery behavior can be exercised without sending messages. */
export interface ProposalDeliveryDependencies {
  getProposal(userId: number, proposalId: number): Promise<DeliveryProposal | null>;
  resolveTarget(userId: number, proposal: DeliveryProposal, input: ProposalDeliveryInput): Promise<Review>;
  loadAction(userId: number, key: string): Promise<Action | null>;
  claim(input: ClaimInput): Promise<{ action: Action; created: boolean }>;
  reserve(userId: number, action: Action): Promise<{ success: boolean; transactionId?: number; error?: string }>;
  recordReservation(action: Action, transactionId?: number): Promise<void>;
  dispatch(userId: number, action: Action): Promise<ProposalProviderReceipt>;
  complete(action: Action, receipt: ProposalProviderReceipt): Promise<void>;
  fail(action: Action, error: string, uncertain: boolean): Promise<void>;
  refund(userId: number, transactionId: number): Promise<unknown>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function digest(value: unknown): string { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
export function proposalDeliveryTargetFingerprint(target: unknown): string { return digest(target); }
export function proposalDeliveryDecisionKey(userId: number, proposalId: number, key: string): string { return `proposal:${digest({ userId, proposalId, key })}`; }
function metadata(action: Action) { return record(action.payload.metadata); }
function actionTarget(action: Action): ProposalDeliveryTarget { return metadata(action).target as ProposalDeliveryTarget; }
function sameId(left: unknown, right: unknown): boolean { return !left || !right || Number(left) === Number(right); }
function email(value: unknown): string { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
function positiveId(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new ProposalDeliveryError(`Invalid ${label}.`, 400, 'INVALID_DELIVERY_INPUT');
  return Number(value);
}
const CHANNELS = new Set<ProposalChannel>(['email', 'whatsapp', 'facebook', 'instagram', 'sms', 'linkedin', 'twitter', 'web']);
function normalizedInput(input: ProposalDeliveryInput): ProposalDeliveryInput {
  if (input.channel && !CHANNELS.has(input.channel)) throw new ProposalDeliveryError('Unsupported proposal channel.', 400, 'INVALID_DELIVERY_INPUT');
  if (input.providerVariant && !['gmail', 'resend'].includes(input.providerVariant)) throw new ProposalDeliveryError('Unsupported email provider.', 400, 'INVALID_DELIVERY_INPUT');
  positiveId(input.outreachConversationId, 'conversation'); positiveId(input.leadId, 'lead');
  for (const [key, max] of [['message', 10000], ['subject', 500], ['recipientName', 255], ['recipientEmail', 320], ['providerAccountId', 255]] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key]!.length > max)) throw new ProposalDeliveryError(`Invalid ${key}.`, 400, 'INVALID_DELIVERY_INPUT');
  }
  if ([input.subject, input.recipientName, input.recipientEmail, input.providerAccountId].some(value => value && /[\r\n]/.test(value))) throw new ProposalDeliveryError('Recipient and subject fields must not contain line breaks.', 400, 'INVALID_DELIVERY_INPUT');
  if (input.whatsappTemplate && (!/^[a-z0-9_]{1,512}$/.test(input.whatsappTemplate.name) || !/^[A-Za-z_]{2,20}$/.test(input.whatsappTemplate.language) || !Array.isArray(input.whatsappTemplate.components) || JSON.stringify(input.whatsappTemplate.components).length > 20000)) throw new ProposalDeliveryError('Invalid WhatsApp template.', 400, 'INVALID_DELIVERY_INPUT');
  return { ...input, ...(input.recipientEmail !== undefined ? { recipientEmail: email(input.recipientEmail) } : {}) };
}

export function assertProposalDeliveryReview(proposal: DeliveryProposal, target: ProposalDeliveryTarget, expectedRevision: number | undefined) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== proposal.revision) throw new ProposalDeliveryError('The proposal changed. Review its current version before sending.', 409, 'PROPOSAL_REVISION_CONFLICT');
  if (!['draft', 'sent', 'viewed'].includes(proposal.status)) throw new ProposalDeliveryError('This proposal cannot be sent in its current state.', 409, 'PROPOSAL_STATE_CONFLICT');
  if (!proposal.metadata?.deliveryTarget || digest(proposal.metadata.deliveryTarget) !== digest(target)) throw new ProposalDeliveryError('Review and save this recipient, channel, account and message before sending.');
  if (proposal.recipientName !== target.recipientName || email(proposal.recipientEmail) !== email(target.recipientEmail)) throw new ProposalDeliveryError('Save the reviewed recipient details on the proposal before approving.');
  if (!proposal.metadata?.approvedAt || proposal.metadata.approvalFingerprint !== proposalApprovalFingerprint(proposal)) throw new ProposalDeliveryError('Review and approve the current proposal before sending.');
  const readiness = getProposalReadiness(proposal, { channel: target.channel });
  if (!readiness.ready) throw new ProposalDeliveryError('Complete the proposal before sending.', 422, 'PROPOSAL_NOT_READY', readiness.issues);
}

export class ProposalDeliveryService {
  private readonly deps: ProposalDeliveryDependencies;
  constructor(overrides: Partial<ProposalDeliveryDependencies> = {}) { this.deps = { ...productionDependencies, ...overrides }; }

  async prepare(userId: number, proposalId: number, supplied: ProposalDeliveryInput = {}) {
    const input = normalizedInput(supplied);
    const proposal = await this.deps.getProposal(userId, proposalId);
    if (!proposal || proposal.userId !== userId) throw new ProposalDeliveryError('Proposal not found.', 404, 'PROPOSAL_NOT_FOUND');
    if (input.expectedRevision !== undefined && input.expectedRevision !== proposal.revision) throw new ProposalDeliveryError('The proposal changed. Reload its current version.', 409, 'PROPOSAL_REVISION_CONFLICT');
    const { target, issues: targetIssues } = await this.deps.resolveTarget(userId, proposal, input);
    const candidate = { ...proposal, recipientName: target.recipientName, recipientEmail: target.recipientEmail };
    // Preparing a review does not itself approve anything.
    const readiness = getProposalReadiness(candidate, { channel: target.channel, includeApproval: false });
    const issues = [...readiness.issues, ...targetIssues];
    return { proposal: candidate, target, targetFingerprint: digest(target), reviewFingerprint: proposalApprovalFingerprint({ ...candidate, metadata: { ...candidate.metadata, deliveryTarget: target } }), readiness: { ...readiness, issues, ready: !issues.some(issue => issue.severity === 'error') }, ready: !issues.some(issue => issue.severity === 'error'), issues };
  }

  private async result(userId: number, proposalId: number, action: Action) {
    return {
      proposal: await this.deps.getProposal(userId, proposalId),
      publicUrl: String(metadata(action).publicUrl || ''),
      delivery: {
        state: action.status === 'sent' ? 'sent' as const : action.status === 'failed' ? 'failed' as const : action.status === 'uncertain' || action.status === 'sending' ? 'uncertain' as const : 'queued' as const,
        ...(action.providerMessageId ? { messageId: action.providerMessageId } : {}),
        channel: action.channel as ProposalChannel,
        actionId: action.id,
        ...(action.lastError ? { error: action.lastError } : {}),
      },
    };
  }

  async send(userId: number, proposalId: number, supplied: ProposalDeliveryInput) {
    const input = normalizedInput(supplied);
    if (!input.idempotencyKey || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) throw new ProposalDeliveryError('A stable idempotency key is required to send.', 400, 'DELIVERY_IDEMPOTENCY_REQUIRED');
    const key = proposalDeliveryDecisionKey(userId, proposalId, input.idempotencyKey);
    const requestDigest = digest(input);
    const previous = await this.deps.loadAction(userId, key);
    if (previous) {
      if (metadata(previous).requestDigest !== requestDigest) throw new ProposalDeliveryError('This send key was already used for a different reviewed request.', 409, 'DELIVERY_IDEMPOTENCY_CONFLICT');
      return this.result(userId, proposalId, previous);
    }
    let review: Awaited<ReturnType<ProposalDeliveryService['prepare']>>;
    let current: DeliveryProposal;
    let claim: Awaited<ReturnType<ProposalDeliveryDependencies['claim']>>;
    try {
      review = await this.prepare(userId, proposalId, input);
      if (!review.ready) throw new ProposalDeliveryError('Resolve the proposal delivery checklist before sending.', 422, 'PROPOSAL_DELIVERY_GATED', review.issues);
      // Recipient overrides only become authoritative after being saved and approved.
      const latest = await this.deps.getProposal(userId, proposalId);
      if (!latest) throw new ProposalDeliveryError('Proposal not found.', 404);
      current = latest;
      assertProposalDeliveryReview(current, review.target, input.expectedRevision ?? (current.metadata?.authorizationMode === 'automatic' ? current.revision : undefined));
      claim = await this.deps.claim({ proposal: current, target: review.target, key, requestDigest, token: crypto.randomBytes(32).toString('base64url') });
    } catch (error) {
      // Another request can acquire the same durable key between our first
      // lookup and review. Return that action even if it changed the status.
      const concurrent = await this.deps.loadAction(userId, key);
      if (!concurrent) throw error;
      if (metadata(concurrent).requestDigest !== requestDigest) throw new ProposalDeliveryError('This send key was already used for a different reviewed request.', 409, 'DELIVERY_IDEMPOTENCY_CONFLICT');
      return this.result(userId, proposalId, concurrent);
    }
    const action = claim.action;
    if (metadata(action).requestDigest !== requestDigest) throw new ProposalDeliveryError('This send key was already used for a different request.', 409, 'DELIVERY_IDEMPOTENCY_CONFLICT');
    if (!claim.created) return this.result(userId, proposalId, action);

    let transactionId: number | undefined;
    let providerStarted = false;
    try {
      const reservation = await this.deps.reserve(userId, action);
      if (!reservation.success) throw new ProposalDeliveryError(reservation.error || 'Insufficient credits to send this proposal.', 402, 'INSUFFICIENT_CREDITS');
      transactionId = reservation.transactionId;
      await this.deps.recordReservation(action, transactionId);
      // Re-resolve eligibility after the durable claim. New opt-outs, removed
      // accounts and a closed reply window must prevent the provider call.
      const eligibility = await this.deps.resolveTarget(userId, current, input);
      // An account-bound conversation may have just been created by this
      // action for the reviewed lead. That generated ID is not a target edit.
      const refreshedTarget = { ...eligibility.target };
      if (!review.target.outreachConversationId && refreshedTarget.outreachConversationId === Number(metadata(action).conversationId)) refreshedTarget.outreachConversationId = null;
      if (eligibility.issues.some(issue => issue.severity === 'error') || digest(refreshedTarget) !== digest(review.target)) throw new ProposalDeliveryError('Delivery eligibility changed. Review the current account and recipient.', 409, 'PROPOSAL_DELIVERY_GATED', eligibility.issues);
      providerStarted = true;
      const receipt = await this.deps.dispatch(userId, action);
      if (!receipt.success || !receipt.messageId) {
        const uncertain = receipt.success || receipt.outcomeUncertain === true || (receipt.deliveryAttempted !== false && receipt.outcomeUncertain !== false);
        await this.deps.fail(action, receipt.error || 'The provider did not confirm a message receipt.', uncertain);
        if (!uncertain && transactionId) await this.deps.refund(userId, transactionId);
        return this.result(userId, proposalId, { ...action, status: uncertain ? 'uncertain' : 'failed', lastError: receipt.error || 'The provider did not confirm a message receipt.' });
      }
      await this.deps.complete(action, receipt);
      return this.result(userId, proposalId, { ...action, status: 'sent', providerMessageId: receipt.messageId });
    } catch (error) {
      const flags = error as { deliveryAttempted?: boolean; outcomeUncertain?: boolean };
      const uncertain = providerStarted && flags.deliveryAttempted !== false && flags.outcomeUncertain !== false;
      await this.deps.fail(action, error instanceof Error ? error.message : 'Proposal delivery failed.', uncertain);
      if (!uncertain && transactionId) await this.deps.refund(userId, transactionId);
      if (uncertain) return this.result(userId, proposalId, { ...action, status: 'uncertain', lastError: 'Delivery could not be confirmed. Reconcile the provider receipt before another send.' });
      throw error;
    }
  }

  /** Proposal actions require a live reviewed request. A worker must never
   * replay an old customer offer after a window, account or approval changes. */
  async retryOutboxAction(action: Action) {
    if (metadata(action).dispatchKind !== 'proposal_delivery') throw new ProposalDeliveryError('Not a proposal delivery action.', 400);
    if (['sent', 'uncertain', 'sending'].includes(action.status)) return;
    await this.deps.fail(action, 'Review and submit a fresh proposal delivery request before retrying.', false);
  }

  async recordUncertainOutcome(action: Action) {
    if (metadata(action).dispatchKind === 'proposal_delivery') await this.deps.fail(action, action.lastError || 'Delivery worker stopped before its provider receipt could be confirmed.', true);
  }
}

async function resolveTarget(userId: number, proposal: DeliveryProposal, input: ProposalDeliveryInput): Promise<Review> {
  const { getEffectiveModuleAccess } = await import('../models/platformAccess/functions.js');
  const modules = await getEffectiveModuleAccess(userId);
  if (!['proposals', 'outreach'].every(key => modules.some(module => module.key === key && module.enabled))) throw new ProposalDeliveryError('Proposal and outreach access are required.', 403, 'MODULE_UNAVAILABLE');
  const saved = record(proposal.metadata?.deliveryTarget);
  const channel = input.channel || saved.channel as ProposalChannel || 'email';
  const conversationId = input.outreachConversationId ?? (saved.outreachConversationId as number | undefined) ?? proposal.outreachConversationId;
  let conversation: Record<string, unknown> | undefined;
  let leadId = input.leadId ?? (saved.leadId as number | undefined) ?? proposal.leadId ?? undefined;
  if (!sameId(proposal.leadId, leadId)) throw new ProposalDeliveryError('The selected lead does not belong to this proposal.', 409, 'PROPOSAL_TARGET_MISMATCH');
  if (conversationId) {
    conversation = (await db.execute(sql`SELECT * FROM outreach_conversations WHERE id=${conversationId} AND user_id=${userId}`)).rows[0];
    if (!conversation || (conversation.channel === 'gmail' ? 'email' : conversation.channel) !== channel) throw new ProposalDeliveryError('The selected conversation does not belong to this channel and account.', 404, 'CONVERSATION_NOT_FOUND');
    if (!sameId(proposal.leadId, conversation.lead_id) || !sameId(leadId, conversation.lead_id) || !sameId(proposal.contactId, conversation.crm_contact_id)) throw new ProposalDeliveryError('The selected conversation belongs to another customer.', 409, 'PROPOSAL_TARGET_MISMATCH');
    leadId = Number(conversation.lead_id);
  }
  if (proposal.contactId) {
    const contact = (await db.execute(sql`SELECT lead_id,email FROM crm_contacts WHERE id=${proposal.contactId} AND user_id=${userId} AND deleted_at IS NULL`)).rows[0];
    if (!contact || !sameId(contact.lead_id, leadId)) throw new ProposalDeliveryError('The proposal contact and selected lead do not match.', 409, 'PROPOSAL_TARGET_MISMATCH');
    leadId = leadId || Number(contact.lead_id) || undefined;
  }
  const lead = leadId ? (await db.execute(sql`SELECT * FROM leads WHERE id=${leadId} AND user_id=${userId} AND deleted_at IS NULL`)).rows[0] : undefined;
  if (leadId && !lead) throw new ProposalDeliveryError('Lead not found.', 404, 'LEAD_NOT_FOUND');
  const issues: ReadinessIssue[] = [];
  const issue = (code: string, field: string, message: string) => issues.push({ code, field, message, severity: 'error' });
  try { publicBase(); } catch (error) { issue('public_url', 'delivery', error instanceof Error ? error.message : 'Configure a secure application URL.'); }
  if (lead?.blacklisted || lead?.do_not_contact || (channel === 'email' && lead?.email_unsubscribed) || ['unsubscribed', 'bounced'].includes(String(conversation?.status))) issue('recipient_opted_out', 'recipient', 'This customer is opted out or blocked from outreach.');
  const recipientEmail = email(input.recipientEmail ?? proposal.recipientEmail ?? conversation?.lead_email ?? lead?.email);
  if (channel === 'email' && conversation?.lead_email && recipientEmail !== email(conversation.lead_email)) throw new ProposalDeliveryError('The recipient email must match the reviewed conversation.', 409, 'PROPOSAL_TARGET_MISMATCH');
  if (channel === 'email' && lead?.email && recipientEmail !== email(lead.email)) throw new ProposalDeliveryError('The recipient email must match the selected lead.', 409, 'PROPOSAL_TARGET_MISMATCH');
  const recipientName = (input.recipientName ?? proposal.recipientName ?? String(conversation?.lead_name || lead?.full_name || lead?.name || '')).trim();
  let providerAccountId = input.providerAccountId ?? String(saved.providerAccountId || conversation?.provider_account_id || '');
  if (conversation?.provider_account_id && providerAccountId && providerAccountId !== conversation.provider_account_id) throw new ProposalDeliveryError('Use the sending account bound to this conversation.', 409, 'PROPOSAL_ACCOUNT_MISMATCH');
  let credentialId = 0;
  let providerVariant: 'gmail' | 'resend' | undefined;
  if (channel === 'web') {
    if (!conversation || !await activeWidgetSession(userId, Number(conversation.id))) issue('widget_session_unavailable', 'recipient', 'The original webchat session is no longer available for delivery.');
    providerAccountId = `web:${conversation?.id || 0}`;
  } else if (channel === 'sms') {
    const { ChannelCredentialModel } = await import('../models/channelCredentials/functions.js');
    const { inspectMSG91Credential } = await import('../utils/msg91Credentials.js');
    const credential = providerAccountId ? await ChannelCredentialModel.findActiveAccountByIdentifier(userId, 'msg91_sms', providerAccountId) : await ChannelCredentialModel.findByUserAndPlatform(userId, 'msg91_sms');
    const readiness = inspectMSG91Credential(credential);
    const account = credential?.accountIdentifier;
    if (!credential || !readiness.ready || !account || (providerAccountId && providerAccountId !== account)) issue('provider_unavailable', 'providerAccountId', readiness.issue || 'Select the verified MSG91 sender for this conversation.');
    else { credentialId = credential.id; providerAccountId = String(account); }
  } else {
    const { inspectOfficialProviderBinding } = await import('./outreach/ProviderBindingService.js');
    if (channel === 'email') {
      if (input.providerVariant && conversation?.integration_provider && input.providerVariant !== conversation.integration_provider) throw new ProposalDeliveryError('Use the email provider bound to this conversation.', 409, 'PROPOSAL_ACCOUNT_MISMATCH');
      const variant = input.providerVariant || conversation?.integration_provider || saved.providerVariant;
      if (variant) providerVariant = variant === 'resend' ? 'resend' : 'gmail';
      else {
        const settings = (await db.execute(sql`SELECT email_provider FROM outreach_settings WHERE user_id=${userId} LIMIT 1`)).rows[0];
        providerVariant = settings?.email_provider === 'resend' ? 'resend' : 'gmail';
      }
    }
    const readiness = await inspectOfficialProviderBinding(userId, channel, { ...(providerAccountId ? { providerAccountId } : {}), ...(providerVariant ? { providerVariant } : {}) });
    if (!readiness.ready || !readiness.binding) issue('provider_unavailable', 'providerAccountId', `Connect and verify the selected ${providerVariant || channel} sending account.`);
    else { providerAccountId = readiness.binding.providerAccountId; credentialId = readiness.binding.credentialId; }
  }
  let senderEmail: string | undefined;
  let senderId: number | undefined;
  if (providerVariant === 'resend' && providerAccountId) {
    const selected = (await db.execute(sql`SELECT id,email FROM email_senders WHERE user_id=${userId} AND type='resend' AND lower(split_part(email,'@',2))=${providerAccountId.toLowerCase()} ${saved.senderId && saved.providerAccountId === providerAccountId ? sql`AND id=${Number(saved.senderId)}` : sql``} ORDER BY is_default DESC,id LIMIT 1`)).rows[0];
    if (!selected || (saved.senderEmail && saved.providerAccountId === providerAccountId && email(selected.email) !== email(saved.senderEmail))) issue('sender_unavailable', 'providerAccountId', 'Configure and review an email sender on the selected domain.');
    else { senderEmail = email(selected.email); senderId = Number(selected.id); }
  }
  if (!conversation && leadId && channel !== 'email') {
    conversation = (await db.execute(sql`SELECT * FROM outreach_conversations WHERE user_id=${userId} AND lead_id=${leadId} AND channel=${channel} AND provider_account_id=${providerAccountId} ORDER BY id DESC LIMIT 1`)).rows[0];
  }
  const conversationMetadata = record(conversation?.metadata);
  const extended = record(lead?.platform_extended);
  let recipient = channel === 'email' ? recipientEmail : String(conversation?.external_thread_id || '');
  if (channel === 'whatsapp' || channel === 'sms') recipient = String(recipient || lead?.phone || '').replace(/[^0-9+]/g, '');
  if (channel === 'twitter') recipient ||= String(conversationMetadata.twitterId || extended.twitter_id || '');
  if (channel === 'linkedin') recipient ||= String(conversationMetadata.linkedinUrn || extended.linkedin_urn || '');
  if (!recipient) issue('recipient_missing', 'recipient', `Link a customer with a valid ${channel} recipient identity.`);
  if ((channel === 'whatsapp' || channel === 'sms') && !/^\+?[1-9]\d{6,14}$/.test(recipient)) issue('phone_invalid', 'recipient', 'Use a complete customer phone number including its country code.');
  if (['facebook', 'instagram'].includes(channel) && (!conversation?.id || !conversation.provider_account_id)) issue('conversation_required', 'outreachConversationId', 'Select an existing conversation bound to this Facebook Page or Instagram account.');
  let whatsappTemplate = input.whatsappTemplate ?? saved.whatsappTemplate as ProposalDeliveryTarget['whatsappTemplate'];
  if (channel !== 'whatsapp') whatsappTemplate = undefined;
  if (['whatsapp', 'facebook', 'instagram'].includes(channel)) {
    const window = conversation?.id ? (await db.execute(sql`SELECT 1 FROM outreach_messages WHERE conversation_id=${conversation.id} AND user_id=${userId} AND direction='inbound' AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`)).rows[0] : undefined;
    if (channel === 'whatsapp' && whatsappTemplate) {
      const approved = (await db.execute(sql`SELECT name,language FROM whatsapp_templates WHERE user_id=${userId} AND name=${whatsappTemplate.name} AND language=${whatsappTemplate.language} AND UPPER(status)='APPROVED' LIMIT 1`)).rows[0];
      if (!approved) issue('template_not_approved', 'whatsappTemplate', 'Choose an approved WhatsApp template for this account.');
      // The public link is substituted only in an explicitly reviewed component.
      if (!JSON.stringify(whatsappTemplate.components).includes('{{proposal_url}}')) issue('template_link_missing', 'whatsappTemplate', 'Add {{proposal_url}} to the approved template component that carries the proposal link.');
    } else if (!window) issue('channel_window_closed', 'channel', channel === 'whatsapp' ? 'Choose an approved WhatsApp template outside the reply window.' : 'The customer must reopen this conversation before a proposal can be sent here.');
  }
  const subject = input.subject ?? String(saved.subject || (channel === 'email' && conversation?.subject) || `Proposal: ${proposal.title}`);
  if (/[\r\n]/.test(subject) || /[\r\n]/.test(recipientName)) issue('invalid_header', 'subject', 'Use a single-line subject and recipient name.');
  if (channel === 'email' && conversation?.integration_provider === 'gmail' && conversation.subject && subject !== conversation.subject) issue('thread_subject', 'subject', 'Keep the original subject when replying in this Gmail conversation.');
  const message = input.message ?? String(saved.message || `Please review ${proposal.title}${proposal.proposalNumber ? ` (${proposal.proposalNumber})` : ''}.`);
  if (/\{\{(?!\s*proposal_url\s*\}\})[^}]+\}\}/.test(message)) issue('message_placeholders', 'message', 'Complete the message placeholders before sending.');
  const target: ProposalDeliveryTarget = { channel, outreachConversationId: conversation?.id ? Number(conversation.id) : null, leadId: leadId || null, recipient, recipientName, recipientEmail: recipientEmail || null, providerAccountId, credentialId, ...(providerVariant ? { providerVariant } : {}), ...(senderEmail ? { senderEmail, senderId } : {}), subject, message, ...(whatsappTemplate ? { whatsappTemplate } : {}) };
  return { target, issues };
}

function publicBase(): string {
  const raw = process.env.CLIENT_URL || process.env.FRONTEND_URL;
  if (!raw) throw new ProposalDeliveryError('Configure the public application URL before sending proposals.', 503, 'PUBLIC_URL_UNAVAILABLE');
  const url = new URL(raw);
  if ((url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || url.username || url.password) throw new ProposalDeliveryError('A secure public application URL is required.', 503, 'PUBLIC_URL_UNAVAILABLE');
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}
function withPublicLink(text: string, publicUrl: string): string { return /\{\{\s*proposal_url\s*\}\}/.test(text) ? text.replace(/\{\{\s*proposal_url\s*\}\}/g, publicUrl) : `${text}\n\nReview proposal: ${publicUrl}`; }

async function claimDelivery(input: ClaimInput): Promise<{ action: Action; created: boolean }> {
  const { proposal, target, key, requestDigest } = input;
  return db.transaction(async (tx: typeof db) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${proposal.userId}, ${proposal.id})`);
    const [existing] = await tx.select().from(supportDeliveryOutboxTable).where(and(eq(supportDeliveryOutboxTable.userId, proposal.userId), eq(supportDeliveryOutboxTable.decisionKey, key))).limit(1);
    if (existing) return { action: existing, created: false };
    const [current] = await tx.select().from(proposalsTable).where(and(eq(proposalsTable.id, proposal.id), eq(proposalsTable.userId, proposal.userId))).for('update');
    if (!current || current.revision !== proposal.revision || !['draft', 'sent', 'viewed'].includes(current.status) || current.metadata?.approvalFingerprint !== proposal.metadata?.approvalFingerprint || digest(current.metadata?.deliveryTarget) !== digest(target)) throw new ProposalDeliveryError('The proposal or approval changed before delivery started.', 409, 'PROPOSAL_REVISION_CONFLICT');
    const { assertTeamProposalApprovals } = await import('./ProposalApprovalService.js');
    await assertTeamProposalApprovals(proposal.userId, { ...proposal, ...current }, tx);
    if (current.metadata?.authorizationMode === 'automatic') {
      const { getProposalReviewPolicy, assertAutomaticProposalCommercials } = await import('./ProposalApprovalService.js');
      if ((await getProposalReviewPolicy(proposal.userId, tx)).requireReviewBeforeAiSend) throw new ProposalDeliveryError('Human review has been re-enabled. Review this offer before sending.');
      await assertAutomaticProposalCommercials(proposal.userId, proposal, tx);
    }
    let conversationId = target.outreachConversationId;
    if (!conversationId && target.leadId) {
      const created = await tx.execute(sql`INSERT INTO outreach_conversations (user_id,lead_id,crm_contact_id,channel,integration_provider,provider_account_id,lead_name,lead_email,external_thread_id,subject,metadata,brand_toolkit_id) VALUES (${proposal.userId},${target.leadId},${proposal.contactId || null},${target.channel},${target.providerVariant || null},${target.providerAccountId},${target.recipientName},${target.recipientEmail},${target.channel === 'email' ? null : target.recipient},${target.subject},'{}'::jsonb,${current.brandToolkitId ?? null}) ON CONFLICT DO NOTHING RETURNING id`);
      conversationId = Number(created.rows[0]?.id || 0) || null;
      if (!conversationId && target.channel !== 'email') {
        const found = await tx.execute(sql`SELECT id,provider_account_id FROM outreach_conversations WHERE user_id=${proposal.userId} AND lead_id=${target.leadId} AND channel=${target.channel} AND provider_account_id=${target.providerAccountId} LIMIT 1`);
        conversationId = Number(found.rows[0]?.id || 0) || null;
      }
      if (!conversationId) throw new ProposalDeliveryError('The customer conversation could not be bound to this sending account.');
    }
    // Reuse the existing valid link on an explicit resend. A request replay
    // always returns its own frozen link, without generating or rotating one.
    const [previous] = current.publicTokenHash ? await tx.select().from(supportDeliveryOutboxTable).where(and(eq(supportDeliveryOutboxTable.userId, proposal.userId), sql`${supportDeliveryOutboxTable.payload}->'metadata'->>'tokenHash'=${current.publicTokenHash}`)).limit(1) : [];
    const reusable = previous && current.publicTokenExpiresAt && current.publicTokenExpiresAt > new Date();
    const publicUrl = reusable ? String(metadata(previous).publicUrl) : `${publicBase()}/proposal/${input.token}`;
    const tokenHash = reusable ? current.publicTokenHash! : crypto.createHash('sha256').update(input.token).digest('hex');
    const expiresAt = reusable ? current.publicTokenExpiresAt! : new Date(Date.now() + 90 * 86400000);
    const payload = { text: withPublicLink(target.message, publicUrl), recipient: target.recipient, subject: target.subject, phoneNumberId: target.channel === 'whatsapp' ? target.providerAccountId : null, metadata: { dispatchKind: 'proposal_delivery', proposalId: proposal.id, revision: proposal.revision, requestDigest, target, publicUrl, tokenHash, providerAccountId: target.providerAccountId, previousStatus: current.status, previousTokenHash: current.publicTokenHash, previousTokenExpiresAt: current.publicTokenExpiresAt?.toISOString() || null, conversationId, isAiGenerated: false, messageKind: 'proposal', creditReservationState: 'not_started' } };
    const [action] = await tx.insert(supportDeliveryOutboxTable).values({ userId: proposal.userId, conversationId: conversationId || -proposal.id, channel: target.channel, decisionKey: key, status: 'sending', payload, attemptCount: 1, maxAttempts: 1, sendingAt: new Date(), leaseExpiresAt: new Date(Date.now() + 120000) }).returning();
    await tx.update(proposalsTable).set({ status: 'sending', publicTokenHash: tokenHash, publicTokenExpiresAt: expiresAt, outreachConversationId: conversationId || current.outreachConversationId, metadata: { ...current.metadata, deliveryAttempt: { actionId: action.id, channel: target.channel, startedAt: new Date().toISOString() } }, updatedAt: new Date() }).where(and(eq(proposalsTable.id, proposal.id), eq(proposalsTable.userId, proposal.userId)));
    return { action, created: true };
  });
}

async function dispatch(userId: number, action: Action): Promise<ProposalProviderReceipt> {
  const target = actionTarget(action);
  const conversationId = Number(metadata(action).conversationId || 0) || undefined;
  if (target.channel === 'web') {
    return db.transaction(async (tx: typeof db) => {
      const sessionId = conversationId ? await activeWidgetSession(userId, conversationId, tx, true) : null;
      if (!sessionId) return { success: false, deliveryAttempted: false, error: 'The original webchat session is no longer available.' };
      const key = `proposal-delivery:${action.id}`;
      const existing = await tx.execute(sql`SELECT id FROM support_chat_messages WHERE session_id=${sessionId} AND request_id=${key} AND role='assistant' LIMIT 1`);
      const row = existing.rows[0] || (await tx.execute(sql`INSERT INTO support_chat_messages(session_id,role,request_id,content,metadata)
        VALUES(${sessionId},'assistant',${key},${action.payload.text},${JSON.stringify({proposalId:metadata(action).proposalId,deliveryActionId:action.id})}::jsonb) RETURNING id`)).rows[0];
      return {success:true,messageId:`web:${row.id}`};
    });
  }
  if (target.channel === 'email') {
    const { getBrandInfo, renderBrandedEmail } = await import('../utils/emailTemplates.js');
    const saved = (await db.execute(sql`SELECT brand_toolkit_id FROM proposals WHERE id=${Number(metadata(action).proposalId) || 0} AND user_id=${userId} LIMIT 1`)).rows[0] as { brand_toolkit_id?: number | null } | undefined;
    const brand = await getBrandInfo(userId, saved?.brand_toolkit_id);
    const html = renderBrandedEmail({ brand, recipientName: target.recipientName, preheader: target.subject, body: `<p>${escapeHtml(action.payload.text).replace(/\n/g, '<br>')}</p><p><a href="${escapeHtml(String(metadata(action).publicUrl))}">Review proposal</a></p>` });
    const thread = conversationId ? (await db.execute(sql`SELECT c.external_thread_id,(SELECT rfc_message_id FROM outreach_messages WHERE conversation_id=c.id AND user_id=${userId} AND rfc_message_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1) AS reply_id FROM outreach_conversations c WHERE c.id=${conversationId} AND c.user_id=${userId}`)).rows[0] : undefined;
    if (target.providerVariant === 'gmail') {
      const { gmailApiService } = await import('./gmailApiService.js');
      const result = await gmailApiService.sendEmail(userId, { to: target.recipient, toName: target.recipientName, subject: target.subject, body: html, isHtml: true, fromEmail: target.providerAccountId, accountBinding: { credentialId: target.credentialId, accountIdentifier: target.providerAccountId }, leadId: target.leadId || undefined, threadId: String(thread?.external_thread_id || '') || undefined, inReplyTo: String(thread?.reply_id || '') || undefined, references: String(thread?.reply_id || '') || undefined, skipConversationLog: true, skipCreditDeduction: true });
      return { ...result, messageId: result.providerMessageId || result.messageId };
    }
    const sender = (await db.execute(sql`SELECT email FROM email_senders WHERE id=${target.senderId || 0} AND user_id=${userId} AND type='resend' AND lower(email)=${target.senderEmail || ''} AND lower(split_part(email,'@',2))=${target.providerAccountId.toLowerCase()} LIMIT 1`)).rows[0];
    if (!sender?.email) throw Object.assign(new ProposalDeliveryError('Configure an email sender on the reviewed domain.', 409, 'PROPOSAL_ACCOUNT_MISMATCH'), { deliveryAttempted: false });
    const { sendEmail } = await import('./resendService.js');
    const result = await sendEmail({ from: String(sender.email), to: target.recipient, subject: target.subject, html, text: action.payload.text, headers: thread?.reply_id ? { 'In-Reply-To': String(thread.reply_id), References: String(thread.reply_id) } : undefined, idempotencyKey: action.decisionKey, credentialId: target.credentialId });
    return { success: Boolean(result?.id), messageId: result?.id };
  }
  if (target.channel === 'whatsapp') {
    const { whatsappApiService } = await import('./whatsappApiService.js');
    const template = target.whatsappTemplate;
    const result = template ? await whatsappApiService.sendTemplate({ userId, phoneNumberId: target.providerAccountId, to: target.recipient.replace(/^\+/, ''), templateName: template.name, language: template.language, components: JSON.parse(JSON.stringify(template.components).replace(/\{\{proposal_url\}\}/g, String(metadata(action).publicUrl))) }) : await whatsappApiService.sendText({ userId, phoneNumberId: target.providerAccountId, to: target.recipient.replace(/^\+/, ''), text: action.payload.text });
    return { success: Boolean(result?.messages?.[0]?.id), messageId: result?.messages?.[0]?.id };
  }
  if (target.channel === 'instagram') {
    const { sendInstagramDM } = await import('./instagramService.js');
    const result = await sendInstagramDM({ userId, recipientId: target.recipient, conversationId, messageId: action.id, message: action.payload.text, providerAccountId: target.providerAccountId, skipCreditDeduction: true });
    return { ...result, messageId: result.externalMessageId, outcomeUncertain: result.outcomeUnknown };
  }
  if (target.channel === 'facebook') {
    const { sendFacebookDM } = await import('./FacebookMessengerService.js');
    const result = await sendFacebookDM({ userId, recipientId: target.recipient, conversationId, message: action.payload.text, providerAccountId: target.providerAccountId });
    return { ...result, messageId: result.externalMessageId, outcomeUncertain: result.outcomeUnknown };
  }
  if (target.channel === 'sms') {
    const { sendSMS } = await import('./smsService.js');
    return sendSMS(userId, `+${target.recipient.replace(/^\+/, '')}`, action.payload.text, undefined, target.providerAccountId);
  }
  if (target.channel === 'twitter') {
    const { sendTwitterDM } = await import('./TwitterApiService.js');
    const result = await sendTwitterDM({ userId, recipientId: target.recipient, message: action.payload.text, providerAccountId: target.providerAccountId });
    return { ...result, messageId: result.externalMessageId, outcomeUncertain: result.outcomeUnknown === true ? true : undefined };
  }
  const { sendLinkedInDM } = await import('./LinkedInApiService.js');
  const result = await sendLinkedInDM({ userId, recipientUrn: target.recipient, message: action.payload.text, providerAccountId: target.providerAccountId });
  return { ...result, messageId: result.externalMessageId, outcomeUncertain: result.outcomeUnknown === true ? true : undefined };
}

async function activeWidgetSession(userId: number, conversationId: number, database = db, lock = false): Promise<number | null> {
  const found = await database.execute(sql`SELECT s.id FROM support_chat_sessions s
    JOIN outreach_conversations c ON c.id=${conversationId} AND c.user_id=${userId} AND c.channel='web'
      AND c.external_thread_id='support-widget:'||s.id::text
      AND c.metadata->>'supportWidgetSessionId'=s.id::text
    JOIN team_members m ON m.id=s.member_id AND m.user_id=${userId} AND m.is_active=true
    JOIN support_teams t ON t.id=m.team_id AND t.user_id=${userId} AND t.is_active=true
    WHERE s.metadata->'widgetProposalIdentity'->>'conversationId'=c.id::text
      AND s.metadata->'widgetProposalIdentity'->>'leadId'=c.lead_id::text
      AND s.session_expires_at>NOW() AND s.automation_mode='ai_active' AND s.opted_out_at IS NULL
      AND c.automation_mode='ai_active' AND c.status NOT IN ('closed','unsubscribed')
      AND NOT EXISTS(SELECT 1 FROM handoff_queue h WHERE h.user_id=${userId} AND h.conversation_id=-s.id AND h.status IN ('waiting','assigned','in_progress'))
    ${lock ? sql`FOR UPDATE OF s` : sql``}`);
  return found.rows[0] ? Number(found.rows[0].id) : null;
}

async function complete(action: Action, receipt: ProposalProviderReceipt) {
  const target = actionTarget(action), data = metadata(action);
  await db.transaction(async (tx: typeof db) => {
    const [updated] = await tx.update(supportDeliveryOutboxTable).set({ status: 'sent', providerMessageId: receipt.messageId!, sentAt: new Date(), leaseExpiresAt: null, lastError: null, updatedAt: new Date() }).where(and(eq(supportDeliveryOutboxTable.id, action.id), eq(supportDeliveryOutboxTable.userId, action.userId), eq(supportDeliveryOutboxTable.status, 'sending'))).returning();
    if (!updated) throw new Error('The delivery action changed before its receipt was recorded.');
    const sent = await tx.update(proposalsTable).set({ status: 'sent', sentAt: new Date(), viewedAt: null, updatedAt: new Date() }).where(and(eq(proposalsTable.id, Number(data.proposalId)), eq(proposalsTable.userId, action.userId), eq(proposalsTable.publicTokenHash, String(data.tokenHash)), eq(proposalsTable.status, 'sending'))).returning({ id: proposalsTable.id });
    if (!sent.length) throw new Error('The proposal changed before the delivery receipt could be committed.');
    const superseded = await tx.execute(sql`UPDATE proposals AS prior SET status='superseded',superseded_by=current.id,updated_at=NOW()
      FROM proposals AS current WHERE current.id=${Number(data.proposalId)} AND current.user_id=${action.userId}
        AND current.metadata->>'revisionOf' ~ '^[0-9]+$' AND prior.id=(current.metadata->>'revisionOf')::integer
        AND prior.user_id=current.user_id AND prior.id<>current.id
        AND (prior.lead_id IS NULL OR current.lead_id IS NULL OR prior.lead_id=current.lead_id)
        AND (prior.contact_id IS NULL OR current.contact_id IS NULL OR prior.contact_id=current.contact_id)
        AND lower(COALESCE(prior.recipient_email,''))=lower(COALESCE(current.recipient_email,''))
        AND prior.status IN ('sent','viewed','rejected','expired') RETURNING prior.id`);
    if (superseded.rows[0]) {
      const priorId = Number(superseded.rows[0].id);
      await tx.execute(sql`UPDATE proposal_reminders SET status='cancelled',updated_at=NOW(),
        metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({ cancelReason: 'superseded', replacementProposalId: Number(data.proposalId) })}::jsonb
        WHERE user_id=${action.userId} AND proposal_id=${priorId} AND status IN ('pending','paused','snoozed')`);
      await tx.execute(sql`INSERT INTO proposal_events(user_id,proposal_id,event_key,kind,payload,processed_at)
        VALUES(${action.userId},${priorId},${`superseded:${priorId}:${Number(data.proposalId)}`},'superseded',${JSON.stringify({ replacementProposalId: Number(data.proposalId) })}::jsonb,NOW()) ON CONFLICT DO NOTHING`);
    }
    const conversationId = Number(data.conversationId || 0);
    if (conversationId) {
      await tx.execute(sql`INSERT INTO outreach_messages (conversation_id,user_id,direction,content,subject,status,is_read,is_ai_generated,message_kind,external_message_id,provider_message_id,rfc_message_id,provider_account_id,phone_number_id,provider_call_state,confirmed_at,sent_at,delivery_action_id,metadata) VALUES (${conversationId},${action.userId},'outbound',${action.payload.text},${target.subject},'sent',TRUE,FALSE,'proposal',${receipt.messageId!},${receipt.messageId!},${receipt.rfcMessageId || null},${target.providerAccountId},${target.channel === 'whatsapp' ? target.providerAccountId : null},'confirmed',NOW(),NOW(),${action.id},${JSON.stringify({ proposalId: data.proposalId, revision: data.revision })}::jsonb) ON CONFLICT (delivery_action_id) WHERE delivery_action_id IS NOT NULL DO NOTHING`);
      await tx.execute(sql`UPDATE outreach_conversations SET last_message_at=NOW(),last_message_by='user',last_message_preview=${action.payload.text.slice(0, 200)},total_messages=COALESCE(total_messages,0)+1,updated_at=NOW(),external_thread_id=CASE WHEN channel IN ('email','gmail') AND CAST(${receipt.threadId || null} AS text) IS NOT NULL THEN CAST(${receipt.threadId || null} AS varchar(255)) ELSE external_thread_id END WHERE id=${conversationId} AND user_id=${action.userId}`);
    }
    if (target.leadId && target.providerVariant !== 'gmail') await tx.execute(sql`INSERT INTO sent_messages (user_id,lead_id,lead_name,channel,subject,message,sent_at,status,message_id,delivery_status,is_reply) VALUES (${action.userId},${target.leadId},${target.recipientName},${target.channel},${target.subject},${action.payload.text},NOW(),'sent',${receipt.messageId!},'sent',FALSE)`);
    if (target.leadId) await tx.execute(sql`UPDATE crm_contacts SET pipeline_status='proposal_sent',updated_at=NOW() WHERE user_id=${action.userId} AND lead_id=${target.leadId} AND pipeline_status NOT IN ('won','lost')`);
  });
}

async function fail(action: Action, error: string, uncertain: boolean) {
  const data = metadata(action);
  await db.transaction(async (tx: typeof db) => {
    const changed = await tx.update(supportDeliveryOutboxTable).set({ status: uncertain ? 'uncertain' : 'failed', lastError: error.slice(0, 2000), leaseExpiresAt: null, nextAttemptAt: null, maxAttempts: 1, updatedAt: new Date() }).where(and(eq(supportDeliveryOutboxTable.id, action.id), eq(supportDeliveryOutboxTable.userId, action.userId), sql`${supportDeliveryOutboxTable.status} <> 'sent'`)).returning();
    if (!changed.length) return;
    await tx.update(proposalsTable).set({ status: uncertain ? 'delivery_unknown' : String(data.previousStatus || 'draft'), ...(!uncertain ? { publicTokenHash: data.previousTokenHash ? String(data.previousTokenHash) : null, publicTokenExpiresAt: data.previousTokenExpiresAt ? new Date(String(data.previousTokenExpiresAt)) : null } : {}), updatedAt: new Date() }).where(and(eq(proposalsTable.id, Number(data.proposalId)), eq(proposalsTable.userId, action.userId), eq(proposalsTable.status, 'sending'), eq(proposalsTable.publicTokenHash, String(data.tokenHash))));
  });
}

const productionDependencies: ProposalDeliveryDependencies = {
  getProposal: async (userId, proposalId) => { const { proposalService } = await import('./ProposalService.js'); return await proposalService.getProposalById(userId, proposalId) as DeliveryProposal | null; },
  resolveTarget,
  loadAction: async (userId, key) => (await db.select().from(supportDeliveryOutboxTable).where(and(eq(supportDeliveryOutboxTable.userId, userId), eq(supportDeliveryOutboxTable.decisionKey, key))).limit(1))[0] || null,
  claim: claimDelivery,
  reserve: async (userId, action) => { if (action.channel === 'web') return {success:true}; const { creditService } = await import('./CreditService.js'); return creditService.deductOnceForResource({ userId, eventKey: `outreach_${action.channel}`, referenceType: 'proposal_delivery', referenceId: String(action.id), description: `Proposal delivery through ${action.channel}`, service: 'ProposalDeliveryService', metadata: { channel: action.channel, reservation: true, proposalId: metadata(action).proposalId } }); },
  recordReservation: async (action, transactionId) => {
    await db.transaction(async (tx: typeof db) => {
      const updated = await tx.execute(sql`UPDATE support_delivery_outbox SET payload=jsonb_set(payload,'{metadata}',COALESCE(payload->'metadata','{}'::jsonb) || ${JSON.stringify({ creditTransactionId: transactionId || null, creditReservationState: 'reserved' })}::jsonb),updated_at=NOW() WHERE id=${action.id} AND user_id=${action.userId} AND status='sending' RETURNING id`);
      if (!updated.rows.length) throw new ProposalDeliveryError('The delivery claim expired before credit reservation was recorded.');
      await tx.execute(sql`UPDATE proposals SET metadata=jsonb_set(metadata,'{deliveryAttempt}',COALESCE(metadata->'deliveryAttempt','{}'::jsonb) || ${JSON.stringify({ creditTransactionId: transactionId || null })}::jsonb) WHERE id=${Number(metadata(action).proposalId)} AND user_id=${action.userId} AND metadata->'deliveryAttempt'->>'actionId'=${String(action.id)}`);
    });
  },
  dispatch, complete, fail,
  refund: async (userId, transactionId) => { const { creditService } = await import('./CreditService.js'); return creditService.refundDeduction({ userId, transactionId, description: 'Proposal delivery was definitively not accepted.' }); },
};

export const proposalDeliveryService = new ProposalDeliveryService();
