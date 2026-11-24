/**
 * Controlled end-to-end proposal delivery verification.
 *
 * Planning is read-only. A real send requires every interlock below and an
 * exact inbox supplied through the environment (so it is not copied into
 * shell history):
 *
 *   PROPOSAL_LIVE_QA_ALLOW_EXECUTE=true \
 *   PROPOSAL_LIVE_QA_EMAIL=controlled-inbox@example.com \
 *   pnpm qa:proposal:live -- --user-id 1 --run-id qa-2026-09-15 \
 *     --execute --confirm SEND_CONTROLLED_PROPOSAL_QA
 *
 * A run id is permanently bound to one recipient. Reusing the same run id
 * resumes provider polling and lifecycle verification without sending a
 * duplicate message. Use a new run id only for a deliberately new send.
 */
import {
  LIVE_PROPOSAL_QA_CONFIRMATION,
  LIVE_PROPOSAL_QA_RUN_ID_PATTERN,
  liveProposalQaFrozenProviderTarget,
  liveProposalQaResumeDecision,
  sanitizeLiveProposalQaMessage,
  validateLiveProposalQaInput,
  type LiveProposalQaProviderPreference,
} from './lib/proposalLiveQaPolicy.js';
import { randomUUID } from 'node:crypto';
import { asRecord as record } from '../../shared/records.js';
import { parsePositiveIdOrUndefined as positiveInteger } from '../utils/paramParsers.js';
import { option } from './lib/cliArgs.js';
import { sleep } from '../utils/sleep.js';

process.env.LOG_LEVEL ||= 'fatal';
process.env.FILE_LOGGING_ENABLED ||= 'false';

// `.env` intentionally overrides most local variables for the API. Live QA
// controls are different: they must be supplied to this exact process, never
// inherited accidentally from an environment file.
const liveQaKeys = [
  'PROPOSAL_LIVE_QA_ALLOW_EXECUTE',
  'PROPOSAL_LIVE_QA_EMAIL',
  'PROPOSAL_LIVE_QA_POLL_SECONDS',
] as const;
const explicitLiveQaEnvironment = new Map(
  liveQaKeys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]] as const),
);
await import('../env.js');
for (const key of liveQaKeys) {
  const explicit = explicitLiveQaEnvironment.get(key);
  if (explicit === undefined) delete process.env[key];
  else process.env[key] = explicit;
}

const FIXTURE_SOURCE = 'controlled_proposal_qa';
const PROVIDER_SUCCESS = new Set(['delivered', 'opened', 'clicked']);
const PROVIDER_FAILURE = new Set(['bounced', 'complained', 'canceled', 'cancelled', 'failed']);

type JsonRecord = Record<string, unknown>;
type CliOptions = {
  userId: number;
  runId: string;
  execute: boolean;
  confirmation?: string;
};
type ExistingProposalRow = {
  id: number;
  status: string;
  revision: number;
  lead_id: number | null;
  contact_id: number | null;
  outreach_conversation_id: number | null;
  recipient_email: string | null;
  metadata: JsonRecord | null;
};
type DeliveryActionRow = {
  id: number;
  status: string;
  provider_message_id: string | null;
  conversation_id: number | null;
  payload: JsonRecord | null;
};
type Preflight = {
  userExists: boolean;
  modulesReady: boolean;
  providerReady: boolean;
  providerCode: string;
  providerMissing: string[];
  credentialId?: number;
  providerAccountId?: string;
  senderId?: number;
  senderEmail?: string;
  teamId?: number;
  memberId?: number;
  creditCost: number;
  creditBalance: number;
  creditsSufficient: boolean;
};

const sensitiveValues = new Set<string>();

function parseOptions(): CliOptions {
  const userId = Number(option('--user-id'));
  const runId = String(option('--run-id') || '').trim().toLowerCase();
  const execute = process.argv.includes('--execute');
  if (!Number.isSafeInteger(userId) || userId <= 0 || !LIVE_PROPOSAL_QA_RUN_ID_PATTERN.test(runId)) {
    throw new Error('Usage: --user-id <positive integer> --run-id <6-64 lowercase letters, digits, or hyphens> [--execute --confirm SEND_CONTROLLED_PROPOSAL_QA]');
  }
  return { userId, runId, execute, confirmation: option('--confirm') };
}

function sanitize(message: string): string {
  return sanitizeLiveProposalQaMessage(message, sensitiveValues);
}

function assertLocalDatabase() {
  const host = String(process.env.DB_HOST || '').trim().toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('This verification runner is restricted to a local PostgreSQL database.');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This verification runner cannot execute with NODE_ENV=production.');
  }
}

function dateOnly(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

function proposalPlan(metadata: JsonRecord | null) {
  const onboarding = record(record(metadata).onboardingPlan);
  return {
    teamId: positiveInteger(onboarding.teamId),
    memberId: positiveInteger(onboarding.assignedMemberId),
  };
}

function actionMetadata(action: DeliveryActionRow): JsonRecord {
  return record(record(action.payload).metadata);
}

function tokenFromPublicUrl(publicUrl: string): string {
  const parsed = new URL(publicUrl);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error('The controlled proposal token is not bound to the local QA application URL.');
  }
  const token = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) || '');
  if (!token) throw new Error('The controlled proposal link has no public token.');
  sensitiveValues.add(token);
  return token;
}

function providerRecipients(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim().toLowerCase());
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return [];
}

async function loadExistingProposal(
  database: { execute: (query: unknown) => Promise<{ rows: unknown[] }> },
  sql: typeof import('drizzle-orm').sql,
  userId: number,
  draftKey: string,
): Promise<ExistingProposalRow | undefined> {
  const result = await database.execute(sql`SELECT id,status,revision,lead_id,contact_id,outreach_conversation_id,recipient_email,metadata
    FROM proposals WHERE user_id=${userId} AND draft_key=${draftKey} LIMIT 1`);
  return result.rows[0] as ExistingProposalRow | undefined;
}

async function loadDeliveryAction(
  database: { execute: (query: unknown) => Promise<{ rows: unknown[] }> },
  sql: typeof import('drizzle-orm').sql,
  userId: number,
  proposalId?: number,
): Promise<DeliveryActionRow | undefined> {
  if (!proposalId) return undefined;
  const result = await database.execute(sql`SELECT id,status,provider_message_id,conversation_id,payload
    FROM support_delivery_outbox
    WHERE user_id=${userId}
      AND payload->'metadata'->>'dispatchKind'='proposal_delivery'
      AND payload->'metadata'->>'proposalId'=${String(proposalId)}
    ORDER BY id DESC LIMIT 1`);
  return result.rows[0] as DeliveryActionRow | undefined;
}

async function inspectPreflight(
  database: { execute: (query: unknown) => Promise<{ rows: unknown[] }> },
  sql: typeof import('drizzle-orm').sql,
  inspectOfficialProviderBinding: typeof import('../services/outreach/ProviderBindingService.js').inspectOfficialProviderBinding,
  getEffectiveModuleAccess: typeof import('../models/platformAccess/functions.js').getEffectiveModuleAccess,
  userId: number,
  preferred: { teamId?: number; memberId?: number },
  providerPreference: LiveProposalQaProviderPreference,
): Promise<Preflight> {
  if (providerPreference.providerAccountId) sensitiveValues.add(providerPreference.providerAccountId);
  if (providerPreference.senderEmail) sensitiveValues.add(providerPreference.senderEmail);
  const [userResult, readiness, modules, creditsResult] = await Promise.all([
    database.execute(sql`SELECT EXISTS(SELECT 1 FROM users WHERE id=${userId}) AS present`),
    inspectOfficialProviderBinding(userId, 'email', {
      providerVariant: 'resend',
      ...(providerPreference.credentialId ? { credentialId: providerPreference.credentialId } : {}),
      ...(providerPreference.providerAccountId ? { providerAccountId: providerPreference.providerAccountId } : {}),
    }),
    getEffectiveModuleAccess(userId),
    database.execute(sql`SELECT
      COALESCE((SELECT balance::float FROM wallets WHERE user_id=${userId}),0)::float AS balance,
      COALESCE((SELECT credits_per_unit::float FROM credit_pricing WHERE event_key='outreach_email' AND is_active=true ORDER BY id DESC LIMIT 1),0)::float AS cost`),
  ]);
  const userExists = Boolean((userResult.rows[0] as { present?: boolean } | undefined)?.present);
  const modulesReady = ['proposals', 'outreach'].every((key) => modules.some((module) => module.key === key && module.enabled));
  const credit = creditsResult.rows[0] as { balance?: number; cost?: number } | undefined;
  const creditBalance = Number(credit?.balance || 0);
  const creditCost = Number(credit?.cost || 0);

  let sender: { id: number; email: string } | undefined;
  if (readiness.ready && readiness.binding) {
    sensitiveValues.add(readiness.binding.providerAccountId);
    const senderResult = await database.execute(sql`SELECT id,email FROM email_senders
      WHERE user_id=${userId} AND type='resend' AND is_verified=true
        AND lower(split_part(email,'@',2))=${readiness.binding.providerAccountId.toLowerCase()}
        ${providerPreference.senderId ? sql`AND id=${providerPreference.senderId}` : sql``}
        ${providerPreference.senderEmail ? sql`AND lower(email)=${providerPreference.senderEmail.toLowerCase()}` : sql``}
      ORDER BY is_default DESC,id LIMIT 1`);
    sender = senderResult.rows[0] as { id: number; email: string } | undefined;
    if (sender?.email) sensitiveValues.add(sender.email);
  }

  const teamResult = preferred.teamId && preferred.memberId
    ? await database.execute(sql`SELECT t.id AS team_id,m.id AS member_id
        FROM support_teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=t.user_id
        WHERE t.id=${preferred.teamId} AND m.id=${preferred.memberId} AND t.user_id=${userId}
          AND t.is_active=true AND m.is_active=true LIMIT 1`)
    : await database.execute(sql`SELECT t.id AS team_id,m.id AS member_id
        FROM support_teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=t.user_id
        WHERE t.user_id=${userId} AND t.is_active=true AND m.is_active=true
        ORDER BY m.is_on_call DESC,t.id,m.id LIMIT 1`);
  const owner = teamResult.rows[0] as { team_id?: number; member_id?: number } | undefined;

  return {
    userExists,
    modulesReady,
    providerReady: readiness.ready && Boolean(readiness.binding),
    providerCode: readiness.code,
    providerMissing: readiness.missing,
    credentialId: readiness.binding?.credentialId,
    providerAccountId: readiness.binding?.providerAccountId,
    senderId: sender?.id,
    senderEmail: sender?.email,
    teamId: positiveInteger(owner?.team_id),
    memberId: positiveInteger(owner?.member_id),
    creditCost,
    creditBalance,
    creditsSufficient: creditCost <= creditBalance,
  };
}

async function ensureFixtures(
  database: {
    transaction: <T>(callback: (tx: { execute: (query: unknown) => Promise<{ rows: unknown[] }> }) => Promise<T>) => Promise<T>;
  },
  sql: typeof import('drizzle-orm').sql,
  userId: number,
  runId: string,
  recipientEmail: string,
): Promise<{ leadId: number; contactId: number }> {
  const actorId = `${FIXTURE_SOURCE}:${runId}`;
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${userId}:${actorId}`}))`);
    const leadResult = await tx.execute(sql`SELECT id,email FROM leads
      WHERE user_id=${userId} AND source=${FIXTURE_SOURCE} AND actor_id=${actorId} AND deleted_at IS NULL
      ORDER BY id LIMIT 1`);
    let lead = leadResult.rows[0] as { id: number; email: string | null } | undefined;
    if (!lead) {
      const inserted = await tx.execute(sql`INSERT INTO leads
        (uuid,user_id,source,actor_id,lead_type,platform_type,name,full_name,email,email_status,lead_status,status,company,company_name)
        VALUES (${randomUUID()},${userId},${FIXTURE_SOURCE},${actorId},'person','email','Controlled Proposal QA','Controlled Proposal QA',${recipientEmail},'valid','new','new','Controlled QA','Controlled QA')
        RETURNING id,email`);
      lead = inserted.rows[0] as { id: number; email: string };
    }
    if (String(lead.email || '').trim().toLowerCase() !== recipientEmail) {
      throw new Error('This run id is already bound to another controlled recipient. Use its original inbox or choose a new run id.');
    }

    const contactResult = await tx.execute(sql`SELECT id,email FROM crm_contacts
      WHERE user_id=${userId} AND lead_id=${lead.id} AND deleted_at IS NULL ORDER BY id LIMIT 1`);
    let contact = contactResult.rows[0] as { id: number; email: string | null } | undefined;
    if (!contact) {
      const inserted = await tx.execute(sql`INSERT INTO crm_contacts
        (user_id,lead_id,first_name,last_name,email,company,status,priority,pipeline_status,source,notes)
        VALUES (${userId},${lead.id},'Controlled Proposal','QA',${recipientEmail},'Controlled QA','contacted','low','negotiation',${FIXTURE_SOURCE},${`Controlled proposal delivery verification ${runId}`})
        RETURNING id,email`);
      contact = inserted.rows[0] as { id: number; email: string };
    }
    if (String(contact.email || '').trim().toLowerCase() !== recipientEmail) {
      throw new Error('The controlled CRM fixture is bound to another recipient. Use a new run id.');
    }
    return { leadId: Number(lead.id), contactId: Number(contact.id) };
  });
}

async function validateExistingFixtures(
  database: { execute: (query: unknown) => Promise<{ rows: unknown[] }> },
  sql: typeof import('drizzle-orm').sql,
  userId: number,
  runId: string,
  recipientEmail: string,
  proposal: ExistingProposalRow,
): Promise<{ leadId: number; contactId: number }> {
  if (!proposal.lead_id || !proposal.contact_id) {
    throw new Error('The resumed controlled proposal has no linked QA customer.');
  }
  const actorId = `${FIXTURE_SOURCE}:${runId}`;
  const result = await database.execute(sql`SELECT l.id AS lead_id,c.id AS contact_id
    FROM leads l JOIN crm_contacts c ON c.id=${proposal.contact_id} AND c.user_id=l.user_id AND c.lead_id=l.id AND c.deleted_at IS NULL
    WHERE l.id=${proposal.lead_id} AND l.user_id=${userId} AND l.source=${FIXTURE_SOURCE}
      AND l.actor_id=${actorId} AND l.deleted_at IS NULL
      AND lower(l.email)=${recipientEmail} AND lower(c.email)=${recipientEmail}
    LIMIT 1`);
  const fixture = result.rows[0] as { lead_id?: number; contact_id?: number } | undefined;
  if (!fixture?.lead_id || !fixture.contact_id) {
    throw new Error('The resumed controlled proposal does not match its original QA customer.');
  }
  return { leadId: Number(fixture.lead_id), contactId: Number(fixture.contact_id) };
}

async function pollProviderDelivery(
  getEmail: typeof import('../services/resendService.js').getEmail,
  messageId: string,
  credentialId: number,
  expectedRecipient: string,
  expectedSubject: string,
): Promise<{ state: 'confirmed' | 'pending' | 'failed'; lastEvent: string }> {
  const configured = Number(process.env.PROPOSAL_LIVE_QA_POLL_SECONDS || 60);
  const pollSeconds = Number.isFinite(configured) ? Math.min(180, Math.max(0, Math.trunc(configured))) : 60;
  const deadline = Date.now() + pollSeconds * 1000;
  let lastEvent = 'unknown';
  let polling = true;
  while (polling) {
    const provider = record(await getEmail(messageId, credentialId));
    const recipients = providerRecipients(provider.to);
    if (!recipients.includes(expectedRecipient)) {
      throw new Error('The provider receipt recipient does not match the controlled inbox.');
    }
    if (String(provider.subject || '') !== expectedSubject) {
      throw new Error('The provider receipt subject does not match the reviewed proposal delivery.');
    }
    lastEvent = String(provider.last_event || provider.lastEvent || 'unknown').trim().toLowerCase();
    if (PROVIDER_SUCCESS.has(lastEvent)) return { state: 'confirmed', lastEvent };
    if (PROVIDER_FAILURE.has(lastEvent)) return { state: 'failed', lastEvent };
    polling = Date.now() < deadline;
    if (polling) await sleep(2000);
  }
  return { state: 'pending', lastEvent };
}

async function main() {
  const options = parseOptions();
  assertLocalDatabase();
  const recipientEmail = validateLiveProposalQaInput({
    ...options,
    allowExecution: process.env.PROPOSAL_LIVE_QA_ALLOW_EXECUTE === 'true',
    recipientEmail: process.env.PROPOSAL_LIVE_QA_EMAIL,
  });
  if (recipientEmail) sensitiveValues.add(recipientEmail);

  // The public token is stored only in this local database. A deployed URL
  // would point the recipient at a different database and a nonexistent token.
  process.env.CLIENT_URL = 'http://localhost:3000';
  const [{ db, pgPool }, { sql }, bindingModule, accessModule] = await Promise.all([
    import('../models/db.js'),
    import('drizzle-orm'),
    import('../services/outreach/ProviderBindingService.js'),
    import('../models/platformAccess/functions.js'),
  ]);

  try {
    const draftKey = `${FIXTURE_SOURCE}:${options.runId}`;
    const existing = await loadExistingProposal(db, sql, options.userId, draftKey);
    const action = await loadDeliveryAction(db, sql, options.userId, existing?.id);
    const initialResumeDecision = liveProposalQaResumeDecision(action ? {
      status: action.status,
      providerMessageId: action.provider_message_id,
    } : undefined);
    const frozenProvider = liveProposalQaFrozenProviderTarget(action?.payload);
    const frozenProviderComplete = Boolean(frozenProvider.credentialId && frozenProvider.providerAccountId);
    const preferredOwner = proposalPlan(existing?.metadata || null);
    const preflight = await inspectPreflight(
      db,
      sql,
      bindingModule.inspectOfficialProviderBinding,
      accessModule.getEffectiveModuleAccess,
      options.userId,
      preferredOwner,
      frozenProvider,
    );
    const needsNewSend = initialResumeDecision.action === 'prepare';
    const needsProviderPoll = initialResumeDecision.action === 'poll-confirmed-send';
    const senderReady = Boolean(preflight.senderId && preflight.senderEmail);
    const operationalReady = preflight.userExists
      && (needsNewSend
        ? preflight.modulesReady && Boolean(preflight.teamId && preflight.memberId)
          && preflight.providerReady && senderReady && preflight.creditsSufficient
        : needsProviderPoll
          ? preflight.modulesReady && Boolean(preflight.teamId && preflight.memberId)
            && frozenProviderComplete && preflight.providerReady
          : true);

    if (!options.execute) {
      return {
        schemaVersion: 1,
        mode: 'plan',
        status: 'planned',
        userId: options.userId,
        runId: options.runId,
        operationalReady,
        checks: {
          localDatabase: true,
          userExists: preflight.userExists,
          requiredModules: preflight.modulesReady,
          officialResendBinding: preflight.providerReady,
          frozenProviderBinding: !needsProviderPoll || frozenProviderComplete,
          verifiedSender: senderReady,
          activeOnboardingOwner: Boolean(preflight.teamId && preflight.memberId),
          creditsSufficient: preflight.creditsSufficient || !needsNewSend,
          recipientConfigured: Boolean(recipientEmail),
          executeEnvironmentEnabled: process.env.PROPOSAL_LIVE_QA_ALLOW_EXECUTE === 'true',
          confirmationProvided: options.confirmation === LIVE_PROPOSAL_QA_CONFIRMATION,
        },
        provider: {
          code: preflight.providerCode,
          missing: preflight.providerMissing,
          credentialId: preflight.credentialId || null,
        },
        existing: existing ? {
          proposalId: existing.id,
          proposalStatus: existing.status,
          deliveryActionId: action?.id || null,
          deliveryState: action?.status || null,
          providerMessageId: action?.provider_message_id || null,
        } : null,
      };
    }

    if (!operationalReady
      || ((needsNewSend || needsProviderPoll) && (!preflight.teamId || !preflight.memberId
        || !preflight.credentialId || !preflight.providerAccountId))
      || (needsNewSend && (!preflight.senderId || !preflight.senderEmail))) {
      throw new Error(`Live verification preflight failed (user=${preflight.userExists}, modules=${preflight.modulesReady}, provider=${preflight.providerReady}, frozen=${!needsProviderPoll || frozenProviderComplete}, sender=${senderReady}, owner=${Boolean(preflight.memberId)}, credits=${preflight.creditsSufficient || !needsNewSend}).`);
    }
    if (existing?.recipient_email && existing.recipient_email.trim().toLowerCase() !== recipientEmail) {
      throw new Error('This run id is already bound to another controlled recipient. Use its original inbox or choose a new run id.');
    }
    if (initialResumeDecision.action === 'stop') {
      if (!existing || !action) throw new Error('The controlled delivery stop state is missing its saved records.');
      return {
        schemaVersion: 1,
        mode: 'execute',
        status: initialResumeDecision.status,
        userId: options.userId,
        runId: options.runId,
        proposalId: existing.id,
        leadId: existing.lead_id,
        contactId: existing.contact_id,
        conversationId: action.conversation_id,
        deliveryActionId: action.id,
        deliveryState: action.status,
      };
    }

    const { proposalService } = await import('../services/ProposalService.js');
    const fixtures = needsNewSend
      ? await ensureFixtures(db, sql, options.userId, options.runId, recipientEmail)
      : await validateExistingFixtures(db, sql, options.userId, options.runId, recipientEmail, existing!);
    const created = needsNewSend ? await proposalService.createProposal(options.userId, {
      draftKey,
      title: `[Controlled QA] Proposal delivery verification ${options.runId}`,
      coverNote: 'This controlled quality-assurance proposal validates the reviewed delivery, public response, CRM, and onboarding workflow.',
      contactId: fixtures.contactId,
      leadId: fixtures.leadId,
      recipientName: 'Controlled Proposal QA',
      recipientEmail,
      currency: 'USD',
      validUntil: new Date(Date.now() + 14 * 86_400_000),
      signatureRequired: true,
      showTermsAndConditions: true,
      termsAndConditions: 'Controlled QA only. The USD 1 line item validates the proposal workflow and creates no commercial service obligation.',
      approvalRequired: true,
      autoOnboard: true,
      requirements: {
        objectives: 'Verify one reviewed proposal delivery and its downstream lifecycle.',
        deliverables: 'Provider receipt, signed acceptance, CRM win, and one assigned onboarding ticket.',
        timeline: 'Complete during this controlled QA run.',
        responsibilities: 'The operator supplies a controlled inbox; the application records and verifies each transition.',
        budget: 'USD 1 controlled validation item.',
      },
      assumptions: [],
      generatedSections: [
        { title: 'Objective', body: 'Validate the complete proposal delivery and acceptance path against a controlled recipient.', kind: 'content' },
        { title: 'Deliverables', body: 'Record the provider receipt, signed acceptance, CRM stage transition, and assigned onboarding ticket.', kind: 'content' },
        { title: 'Timeline', body: 'The validation is completed as one controlled QA run after provider delivery is confirmed.', kind: 'content' },
        { title: 'Completion', body: 'The run is complete when all database assertions pass without duplicate delivery or onboarding records.', kind: 'closing' },
      ],
      onboardingPlan: {
        teamId: preflight.teamId,
        assignedMemberId: preflight.memberId,
        dueDate: dateOnly(7),
        checklist: [{
          id: 'qa-handoff',
          title: 'Verify controlled proposal handoff',
          deliverable: 'Recorded provider, CRM, and onboarding evidence',
          dueDate: dateOnly(3),
        }],
      },
      lineItems: [{
        name: 'Controlled proposal delivery validation',
        description: 'One end-to-end QA verification run.',
        quantity: 1,
        unitPrice: 1,
        unit: 'run',
        priceConfirmed: true,
        billingPeriod: 'one_time',
      }],
    }) : existing!;
    let proposal = await proposalService.getProposalById(options.userId, created.id);
    if (!proposal) throw new Error('The controlled proposal could not be reloaded.');
    if (proposal.leadId !== fixtures.leadId || proposal.contactId !== fixtures.contactId
      || String(proposal.recipientEmail || '').trim().toLowerCase() !== recipientEmail) {
      throw new Error('The controlled proposal is not bound to the expected QA customer.');
    }

    const subject = `[Controlled QA] Proposal delivery verification ${options.runId}`;
    const deliveryBase = {
      channel: 'email' as const,
      leadId: fixtures.leadId,
      providerVariant: 'resend' as const,
      providerAccountId: preflight.providerAccountId,
      recipientName: 'Controlled Proposal QA',
      recipientEmail,
      subject,
      message: 'This is a controlled proposal workflow verification. Review the QA proposal here: {{proposal_url}}',
    };
    const idempotencyKey = `${FIXTURE_SOURCE}:${options.runId}`;
    let currentAction = await loadDeliveryAction(db, sql, options.userId, proposal.id);
    let resumeDecision = liveProposalQaResumeDecision(currentAction ? {
      status: currentAction.status,
      providerMessageId: currentAction.provider_message_id,
    } : undefined);

    if (resumeDecision.action === 'prepare') {
      if (proposal.status !== 'draft') {
        throw new Error(`The controlled proposal is ${proposal.status} without a durable delivery action.`);
      }
      const { proposalDeliveryService, proposalDeliveryTargetFingerprint } = await import('../services/ProposalDeliveryService.js');
      const { reviewProposalForDelivery } = await import('../services/ProposalApprovalService.js');
      const prepared = await proposalDeliveryService.prepare(options.userId, proposal.id, {
        ...deliveryBase,
        expectedRevision: proposal.revision,
      });
      if (!prepared.ready) {
        const errorCodes = prepared.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code).join(',');
        throw new Error(`Proposal delivery readiness failed${errorCodes ? ` (${errorCodes})` : ''}.`);
      }
      const metadata = record(proposal.metadata);
      const teamApproval = record(metadata.teamApproval);
      const alreadyApproved = Boolean(metadata.approvedAt)
        && metadata.approvalFingerprint === prepared.reviewFingerprint
        && proposalDeliveryTargetFingerprint(metadata.deliveryTarget) === prepared.targetFingerprint;
      const alreadyPending = !alreadyApproved
        && teamApproval.fingerprint === prepared.reviewFingerprint
        && ['pending', 'changes_requested'].includes(String(teamApproval.status));
      if (alreadyPending) {
        return {
          schemaVersion: 1,
          mode: 'execute',
          status: teamApproval.status === 'changes_requested' ? 'changes_requested' : 'awaiting_team_approval',
          userId: options.userId,
          runId: options.runId,
          proposalId: proposal.id,
          leadId: fixtures.leadId,
          contactId: fixtures.contactId,
        };
      }
      let reviewedRevision = proposal.revision;
      if (!alreadyApproved) {
        const review = await reviewProposalForDelivery(options.userId, proposal.id, {
          ...deliveryBase,
          expectedRevision: proposal.revision,
          expectedTargetFingerprint: prepared.targetFingerprint,
          expectedReviewFingerprint: prepared.reviewFingerprint,
        });
        reviewedRevision = Number(review.revision);
        if (!review.approved) {
          return {
            schemaVersion: 1,
            mode: 'execute',
            status: 'awaiting_team_approval',
            userId: options.userId,
            runId: options.runId,
            proposalId: proposal.id,
            leadId: fixtures.leadId,
            contactId: fixtures.contactId,
          };
        }
      }
      const delivery = await proposalDeliveryService.send(options.userId, proposal.id, {
        ...deliveryBase,
        expectedRevision: reviewedRevision,
        idempotencyKey,
      });
      if (delivery.delivery.state !== 'sent') {
        return {
          schemaVersion: 1,
          mode: 'execute',
          status: delivery.delivery.state === 'uncertain' ? 'provider_outcome_uncertain' : 'delivery_failed',
          userId: options.userId,
          runId: options.runId,
          proposalId: proposal.id,
          leadId: fixtures.leadId,
          contactId: fixtures.contactId,
          deliveryActionId: delivery.delivery.actionId,
        };
      }
      currentAction = await loadDeliveryAction(db, sql, options.userId, proposal.id);
      resumeDecision = liveProposalQaResumeDecision(currentAction ? {
        status: currentAction.status,
        providerMessageId: currentAction.provider_message_id,
      } : undefined);
    }

    if (!currentAction) throw new Error('The durable proposal delivery action is missing.');
    if (resumeDecision.action === 'stop') {
      return {
        schemaVersion: 1,
        mode: 'execute',
        status: resumeDecision.status,
        userId: options.userId,
        runId: options.runId,
        proposalId: proposal.id,
        leadId: fixtures.leadId,
        contactId: fixtures.contactId,
        deliveryActionId: currentAction.id,
        deliveryState: currentAction.status,
      };
    }
    if (resumeDecision.action !== 'poll-confirmed-send' || !currentAction.provider_message_id) {
      throw new Error('The controlled delivery resume state is inconsistent.');
    }
    const receiptCredentialId = preflight.credentialId;
    if (!receiptCredentialId) throw new Error('The frozen Resend credential is unavailable.');

    const { getEmail } = await import('../services/resendService.js');
    const provider = await pollProviderDelivery(
      getEmail,
      currentAction.provider_message_id,
      receiptCredentialId,
      recipientEmail,
      subject,
    );
    if (provider.state !== 'confirmed') {
      return {
        schemaVersion: 1,
        mode: 'execute',
        status: provider.state === 'failed' ? 'provider_delivery_failed' : 'provider_delivery_pending',
        userId: options.userId,
        runId: options.runId,
        proposalId: proposal.id,
        leadId: fixtures.leadId,
        contactId: fixtures.contactId,
        conversationId: currentAction.conversation_id,
        deliveryActionId: currentAction.id,
        providerMessageId: currentAction.provider_message_id,
        providerLastEvent: provider.lastEvent,
      };
    }

    const publicUrl = String(actionMetadata(currentAction).publicUrl || '');
    const publicToken = tokenFromPublicUrl(publicUrl);
    const viewed = await proposalService.markPublicProposalViewed(publicToken);
    if (!viewed || !['viewed', 'accepted'].includes(viewed.status)) {
      throw new Error('The controlled public proposal could not be marked viewed.');
    }
    const firstAcceptance = await proposalService.respondToPublicProposal(publicToken, 'accept', { name: 'Controlled Proposal QA' });
    const repeatedAcceptance = await proposalService.respondToPublicProposal(publicToken, 'accept', { name: 'Controlled Proposal QA' });
    if (firstAcceptance?.status !== 'accepted' || repeatedAcceptance?.status !== 'accepted') {
      throw new Error('The controlled proposal acceptance was not idempotent.');
    }
    const { processProposalEvents } = await import('../services/ProposalWorkspaceService.js');
    await processProposalEvents({ userId: options.userId, proposalId: proposal.id });
    await processProposalEvents({ userId: options.userId, proposalId: proposal.id });
    const finalizedProposal = await proposalService.getProposalById(options.userId, proposal.id);
    if (!finalizedProposal) throw new Error('The accepted controlled proposal could not be reloaded.');
    proposal = finalizedProposal;

    const verificationResult = await db.execute(sql`SELECT
      p.status AS proposal_status,p.signed_at,p.signed_by_name,p.outreach_conversation_id,
      c.pipeline_status,
      o.id AS delivery_action_id,o.status AS delivery_status,o.provider_message_id,
      (SELECT count(*)::int FROM proposal_events e WHERE e.user_id=p.user_id AND e.proposal_id=p.id AND e.kind='accepted') AS accepted_event_count,
      (SELECT count(*)::int FROM proposal_events e WHERE e.user_id=p.user_id AND e.proposal_id=p.id AND e.kind='accepted' AND e.processed_at IS NOT NULL) AS processed_accepted_event_count,
      (SELECT count(*)::int FROM outreach_messages m WHERE m.user_id=p.user_id AND m.delivery_action_id=o.id AND m.message_kind='proposal') AS proposal_message_count,
      (SELECT count(*)::int FROM support_tickets t WHERE t.user_id=p.user_id AND t.handoff_key=${`proposal-accepted:${proposal.id}`} AND t.deleted_at IS NULL) AS onboarding_count,
      (SELECT t.id FROM support_tickets t WHERE t.user_id=p.user_id AND t.handoff_key=${`proposal-accepted:${proposal.id}`} AND t.deleted_at IS NULL ORDER BY t.id LIMIT 1) AS onboarding_ticket_id,
      (SELECT t.team_id FROM support_tickets t WHERE t.user_id=p.user_id AND t.handoff_key=${`proposal-accepted:${proposal.id}`} AND t.deleted_at IS NULL ORDER BY t.id LIMIT 1) AS onboarding_team_id,
      (SELECT t.assigned_member_id FROM support_tickets t WHERE t.user_id=p.user_id AND t.handoff_key=${`proposal-accepted:${proposal.id}`} AND t.deleted_at IS NULL ORDER BY t.id LIMIT 1) AS onboarding_member_id,
      (SELECT t.metadata FROM support_tickets t WHERE t.user_id=p.user_id AND t.handoff_key=${`proposal-accepted:${proposal.id}`} AND t.deleted_at IS NULL ORDER BY t.id LIMIT 1) AS onboarding_metadata,
      (SELECT t.description FROM support_tickets t WHERE t.user_id=p.user_id AND t.handoff_key=${`proposal-accepted:${proposal.id}`} AND t.deleted_at IS NULL ORDER BY t.id LIMIT 1) AS onboarding_description,
      (SELECT to_char(t.sla_deadline, 'YYYY-MM-DD"T"HH24:MI:SS.MS') FROM support_tickets t WHERE t.user_id=p.user_id AND t.handoff_key=${`proposal-accepted:${proposal.id}`} AND t.deleted_at IS NULL ORDER BY t.id LIMIT 1) AS onboarding_sla_value
      FROM proposals p
      JOIN crm_contacts c ON c.id=p.contact_id AND c.user_id=p.user_id
      JOIN support_delivery_outbox o ON o.id=${currentAction.id} AND o.user_id=p.user_id
      WHERE p.id=${proposal.id} AND p.user_id=${options.userId}`);
    const verified = verificationResult.rows[0] as {
      proposal_status?: string;
      signed_at?: Date | null;
      signed_by_name?: string | null;
      outreach_conversation_id?: number | null;
      pipeline_status?: string;
      delivery_action_id?: number;
      delivery_status?: string;
      provider_message_id?: string;
      accepted_event_count?: number;
      processed_accepted_event_count?: number;
      proposal_message_count?: number;
      onboarding_count?: number;
      onboarding_ticket_id?: number | null;
      onboarding_team_id?: number | null;
      onboarding_member_id?: number | null;
      onboarding_metadata?: JsonRecord | null;
      onboarding_description?: string | null;
      onboarding_sla_value?: string | null;
    } | undefined;
    const proposalMetadata = record(proposal.metadata);
    const onboardingOutcome = record(proposalMetadata.onboarding);
    const expectedPlan = record(proposalMetadata.onboardingPlan);
    const ticketOnboarding = record(record(verified?.onboarding_metadata).proposalOnboarding);
    const expectedChecklist = Array.isArray(expectedPlan.checklist) ? expectedPlan.checklist.map(record) : [];
    const ticketChecklist = Array.isArray(ticketOnboarding.checklist) ? ticketOnboarding.checklist.map(record) : [];
    const expectedDueDate = typeof expectedPlan.dueDate === 'string' ? expectedPlan.dueDate : '';
    const expectedSlaValue = expectedDueDate ? `${expectedDueDate}T23:59:59.999` : '';
    const onboardingPlanChecks = {
      expectedChecklistCount: expectedChecklist.length === 1,
      ticketChecklistCount: ticketChecklist.length === 1,
      checklistIdPresent: Boolean(String(expectedChecklist[0]?.id || '').trim()),
      checklistTitlePresent: Boolean(String(expectedChecklist[0]?.title || '').trim()),
      checklistDeliverablePresent: Boolean(String(expectedChecklist[0]?.deliverable || '').trim()),
      dueDate: ticketOnboarding.dueDate === expectedDueDate,
      checklistId: ticketChecklist[0]?.id === expectedChecklist[0]?.id,
      checklistTitle: ticketChecklist[0]?.title === expectedChecklist[0]?.title,
      checklistDeliverable: ticketChecklist[0]?.deliverable === expectedChecklist[0]?.deliverable,
      checklistStatus: ticketChecklist[0]?.status === 'pending',
      descriptionTitle: String(verified?.onboarding_description || '').includes(String(expectedChecklist[0]?.title || '')),
      descriptionDeliverable: String(verified?.onboarding_description || '').includes(String(expectedChecklist[0]?.deliverable || '')),
      expectedSla: Boolean(expectedSlaValue),
      slaDeadline: verified?.onboarding_sla_value === expectedSlaValue,
    };
    const assertions = {
      acceptedAndSigned: verified?.proposal_status === 'accepted' && Boolean(verified.signed_at && verified.signed_by_name),
      providerReceiptPersisted: verified?.delivery_status === 'sent' && verified.provider_message_id === currentAction.provider_message_id,
      crmWon: verified?.pipeline_status === 'won',
      oneAcceptedEvent: Number(verified?.accepted_event_count) === 1 && Number(verified?.processed_accepted_event_count) === 1,
      oneProposalMessage: Number(verified?.proposal_message_count) === 1,
      oneAssignedOnboardingTicket: Number(verified?.onboarding_count) === 1
        && Number(verified?.onboarding_team_id) === preflight.teamId
        && Number(verified?.onboarding_member_id) === preflight.memberId,
      onboardingOutcomePersisted: onboardingOutcome.status === 'created'
        && Number(onboardingOutcome.supportTicketId) === Number(verified?.onboarding_ticket_id)
        && Number(proposalMetadata.onboardingTicketId) === Number(verified?.onboarding_ticket_id),
      onboardingPlanCopied: Object.values(onboardingPlanChecks).every(Boolean),
    };
    if (!Object.values(assertions).every(Boolean)) {
      const failures = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
      const onboardingFailures = Object.entries(onboardingPlanChecks).filter(([, passed]) => !passed).map(([name]) => name);
      throw new Error(`Controlled lifecycle assertions failed: ${failures.join(',')}${onboardingFailures.length ? ` (${onboardingFailures.join(',')})` : ''}.`);
    }

    return {
      schemaVersion: 1,
      mode: 'execute',
      status: 'completed',
      userId: options.userId,
      runId: options.runId,
      proposalId: proposal.id,
      leadId: fixtures.leadId,
      contactId: fixtures.contactId,
      conversationId: positiveInteger(verified?.outreach_conversation_id) || currentAction.conversation_id,
      deliveryActionId: currentAction.id,
      providerMessageId: currentAction.provider_message_id,
      providerLastEvent: provider.lastEvent,
      proposalStatus: verified?.proposal_status,
      crmStage: verified?.pipeline_status,
      onboardingTicketId: positiveInteger(verified?.onboarding_ticket_id),
      onboardingTicketCount: Number(verified?.onboarding_count),
      assertions,
    };
  } finally {
    await pgPool?.end();
  }
}

main().then((result) => {
  const exitCode = ['planned', 'completed'].includes(String(result.status)) ? 0 : 2;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => process.exit(exitCode));
}).catch((error: unknown) => {
  process.stderr.write(`${sanitize(error instanceof Error ? error.message : 'Controlled proposal verification failed.')}\n`, () => process.exit(1));
});
