import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { ASSISTANT_CHANNELS, assistantModelKey, type AssistantBindingInput, type AssistantProvenance, type AssistantSurface } from '../../../shared/outreachAssistants.js';
import type { CustomerDeliveryReadiness } from '../../../shared/customerDeliveryReadiness.js';
import { platformAIQuotaMessage } from '../../../shared/assistantModelCatalog.js';
import { assistantsRuntimeEnabled, currentAssistant } from './AssistantContext.js';
import { assistantReadiness, parseAssistantDraft } from './AssistantConfiguration.js';
import { quotaBlockedAssistantProviders } from './AssistantModelCatalogService.js';
import { isEmailAddress } from '../../../shared/emailAddress.js';

// Delivery authorization is deliberately separate from the support persona context.
// Campaign replies must retain their original campaign/thread facts and policy.
const receiptContext = new AsyncLocalStorage<AssistantProvenance>();
// Set while sending text a person wrote or reviewed and confirmed: the AI model is not used.
const personConfirmedContext = new AsyncLocalStorage<true>();
/**
 * Run the delivery of text a person confirmed (composer outreach, its configured
 * follow-ups and Inbox replies). An unavailable AI model does not block it;
 * every other assistant check still applies.
 */
export function withPersonConfirmedContent<T>(work: () => T): T {
  return personConfirmedContext.run(true, work);
}
export const currentCustomerDeliveryReceipt = () => receiptContext.getStore();
export function withCustomerDeliveryReceipt<T>(receipt: AssistantProvenance, work: () => T): T {
  return receiptContext.run(Object.freeze({ ...receipt }), work);
}

export class CustomerDeliverySetupError extends Error {
  readonly code = 'ASSISTANT_SETUP_REQUIRED';
  readonly status = 409;
  readonly deliveryAttempted = false;
  readonly outcomeUncertain = false;
  readonly retryable = false;
  readonly setupUrl: string;
  constructor(readonly reason: string, message: string, readonly assistantId?: string) {
    super(message);
    this.name = 'CustomerDeliverySetupError';
    this.setupUrl = assistantId ? `/dashboard/settings/outreach/assistants/${assistantId}` : '/dashboard/settings/outreach';
  }
}
export function deliverySetupFailure(error: unknown) {
  if (!(error instanceof CustomerDeliverySetupError)) return undefined;
  return { success: false as const, code: error.code, reason: error.reason, setupUrl: error.setupUrl,
    assistantId: error.assistantId, error: error.message, deliveryAttempted: false as const,
    outcomeUncertain: false as const, retryable: false as const };
}
export function throwIfCustomerDeliverySetupRequired(result: { code?: string; reason?: string; error?: string; assistantId?: string }): void {
  if (result.code === 'ASSISTANT_SETUP_REQUIRED')
    throw new CustomerDeliverySetupError(result.reason || 'assignment_required', result.error || 'Customer delivery requires assistant setup.', result.assistantId);
}

export function assertCustomerDeliveryRuntime(channel: string): void {
  if (!(ASSISTANT_CHANNELS as readonly string[]).includes(channel))
    throw new CustomerDeliverySetupError('unsupported_channel', `Customer delivery on ${channel} requires a supported assistant account assignment. This channel is blocked until assistant binding is supported.`);
  if (!assistantsRuntimeEnabled())
    throw new CustomerDeliverySetupError('runtime_disabled', 'Customer delivery is blocked because the assistant runtime is disabled. Enable it only after an owner reviews and publishes the assigned assistant.');
}

export interface CustomerDeliveryIdentity {
  userId: number;
  channel: string;
  accountId: string;
  surface?: AssistantSurface;
  expected?: AssistantProvenance;
  /**
   * The message is a Meta-approved WhatsApp template (or its header upload).
   * Meta fixed its wording at approval, so the assistant's AI model is not
   * used to send it: an AI provider outage or exhausted credits must not stop
   * template campaigns. Every other check still applies, and AI-written
   * messages never set this.
   */
  approvedTemplate?: boolean;
  /** A person wrote or reviewed and confirmed this exact text; see withPersonConfirmedContent. */
  personConfirmed?: boolean;
}

/** Checks that only matter when the assistant writes the message with its AI model. */
const AI_MODEL_CHECKS = new Set(['model', 'response']);

function sameReceipt(a: AssistantProvenance, b: AssistantProvenance) {
  return (['assistantId', 'revision', 'bindingId', 'bindingVersion', 'businessProfileId', 'accountId', 'channel', 'surface'] as const)
    .every(key => a[key] === b[key]);
}

/** Fresh database and catalog validation on every call, including the final provider boundary.
 * Nothing here creates, imports, enables, publishes or assigns an assistant. */
async function resolveCustomerDeliveryReady(input: CustomerDeliveryIdentity): Promise<{ provenance: AssistantProvenance; assistantName: string }> {
  assertCustomerDeliveryRuntime(input.channel);
  const scope = currentBusinessScope();
  if (!scope || scope.userId !== input.userId)
    throw new CustomerDeliverySetupError('business_scope_required', 'The persisted delivery business must be verified before customer delivery.');
  const accountId = input.channel === 'email' ? input.accountId?.trim().toLowerCase() : input.accountId?.trim();
  const surface = input.surface || 'private';
  if (!accountId || (input.channel === 'email' && !isEmailAddress(accountId)))
    throw new CustomerDeliverySetupError('account_required', 'Select the exact sending or receiving account and assign a published assistant before delivery.');
  const expected = input.expected || currentCustomerDeliveryReceipt() || currentAssistant()?.provenance;
  if (currentAssistant()?.preview)
    throw new CustomerDeliverySetupError('preview_only', 'Assistant simulations cannot deliver customer messages.');
  const result = await db.execute(sql`SELECT b.id AS binding_id,b.version,b.revision,b.assistant_id,
      b.enabled,a.state,a.published_revision,r.configuration
    FROM outreach_assistant_bindings b JOIN outreach_assistants a ON a.id=b.assistant_id
      AND a.user_id=b.user_id AND a.business_profile_id=b.business_profile_id
    LEFT JOIN outreach_assistant_revisions r ON r.assistant_id=b.assistant_id AND r.revision=b.revision
    WHERE b.user_id=${scope.userId} AND b.business_profile_id=${scope.businessProfileId}
      AND b.channel=${input.channel} AND b.surface=${surface} AND b.account_id=${accountId} AND b.enabled LIMIT 2`);
  if (result.rows.length !== 1)
    throw new CustomerDeliverySetupError('assignment_required', 'Assign one active, published assistant to this exact business account and channel before sending.');
  const row = result.rows[0];
  const assistantId = String(row.assistant_id);
  if (!row.enabled || row.state !== 'live' || !row.published_revision || !row.configuration)
    throw new CustomerDeliverySetupError('assistant_not_live', 'The assigned assistant is disabled, paused or unpublished. Review and publish it before sending.', assistantId);
  if (Number(row.published_revision) !== Number(row.revision))
    throw new CustomerDeliverySetupError('stale_assignment', 'The assigned assistant revision changed. Review this account assignment before sending.', assistantId);
  const provenance: AssistantProvenance = { assistantId, revision: Number(row.revision), bindingId: Number(row.binding_id),
    bindingVersion: Number(row.version), businessProfileId: scope.businessProfileId, accountId,
    channel: input.channel as AssistantProvenance['channel'], surface };
  if (![provenance.revision, provenance.bindingId, provenance.bindingVersion].every(n => Number.isSafeInteger(n) && n > 0)
    || (expected && !sameReceipt(expected, provenance)))
    throw new CustomerDeliverySetupError('assignment_changed', 'The assistant assignment changed after this message was reviewed or queued. Review it again; queued work will not be replayed automatically.', assistantId);
  let configuration;
  try { configuration = parseAssistantDraft(row.configuration); }
  catch { throw new CustomerDeliverySetupError('configuration_invalid', 'The published assistant configuration is invalid. Review and publish it before sending.', assistantId); }
  if (!configuration.bindings.some((b: AssistantBindingInput) => b.channel === input.channel && b.surface === surface && b.accountId === accountId))
    throw new CustomerDeliverySetupError('stale_assignment', 'The published assistant does not include this exact account and surface. Review its assignment.', assistantId);
  // Catalog imports the support tool graph, which imports delivery freshness.
  // Resolve it at request time so async database initialization cannot deadlock boot.
  const { assistantCatalog, assistantPlatformReadiness } = await import('./AssistantCatalogService.js');
  const [catalog, platform, bindings] = await Promise.all([
    assistantCatalog(), assistantPlatformReadiness(),
    db.execute(sql`SELECT channel,surface,account_id FROM outreach_assistant_bindings WHERE assistant_id=${assistantId}::uuid
      AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND revision=${provenance.revision} AND enabled`),
  ]);
  // Delivery is scoped to one exact account. A disconnected sibling binding
  // must block its own sends without disabling another connected channel.
  const deliveryBindings = bindings.rows
    .filter((b: { channel: string; surface: string; account_id: string }) =>
      b.channel === input.channel && b.surface === surface && b.account_id === accountId)
    .map((b: { channel: AssistantProvenance['channel']; surface: AssistantSurface; account_id: string }) =>
      ({ channel: b.channel, surface: b.surface, accountId: b.account_id }));
  const readiness = assistantReadiness(configuration, catalog, platform, deliveryBindings);
  const modelNotUsed = input.approvedTemplate || input.personConfirmed || personConfirmedContext.getStore() === true;
  const failedChecks = readiness.checks.filter(check => !check.ok && !(modelNotUsed && AI_MODEL_CHECKS.has(check.key)));
  if (failedChecks.length) {
    let message = `The assigned assistant needs setup: ${failedChecks.map(check => check.label).join(', ')}.`;
    if (failedChecks.some(check => check.key === 'model')) {
      const availableModels = new Set(catalog.models.map(assistantModelKey));
      const unavailableModels = [configuration.replyModel, ...configuration.fallbackModels]
        .filter(model => model !== null)
        .filter(model => !availableModels.has(assistantModelKey(model)));
      const quotaProviders = await quotaBlockedAssistantProviders(unavailableModels);
      if (quotaProviders.length) {
        message = `Sending is temporarily unavailable. ${platformAIQuotaMessage(quotaProviders)}`;
        const otherChecks = failedChecks.filter(check => check.key !== 'model');
        if (otherChecks.length) message += ` The assistant also needs setup for: ${otherChecks.map(check => check.label).join(', ')}.`;
      }
    }
    throw new CustomerDeliverySetupError('configuration_not_ready', message, assistantId);
  }
  // A flag change during preparation must also close delivery.
  assertCustomerDeliveryRuntime(input.channel);
  return { provenance, assistantName: configuration.name };
}

export async function assertCustomerDeliveryReady(input: CustomerDeliveryIdentity): Promise<AssistantProvenance> {
  return (await resolveCustomerDeliveryReady(input)).provenance;
}

export async function customerDeliveryReadiness(input: CustomerDeliveryIdentity): Promise<CustomerDeliveryReadiness> {
  try {
    const { provenance, assistantName } = await resolveCustomerDeliveryReady(input);
    return { ready: true, setupUrl: `/dashboard/settings/outreach/assistants/${provenance.assistantId}`,
      assistantId: provenance.assistantId, assistantName, accountId: input.accountId, channel: input.channel, provenance };
  } catch (error) {
    const failure = deliverySetupFailure(error);
    if (!failure) throw error;
    return { ready: false, ...failure, code: 'ASSISTANT_SETUP_REQUIRED', accountId: input.accountId, channel: input.channel };
  }
}
