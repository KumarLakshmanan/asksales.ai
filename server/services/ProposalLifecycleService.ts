import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { NotificationService } from './NotificationService.js';
import { proposalService, ProposalWorkflowError } from './ProposalService.js';
import { proposalLineItemInput, type ProposalDocumentMetadata } from '../../shared/proposals.js';
import { isValidIanaTimezone, zonedDateTimeToUtc } from '../utils/timezone.js';
import { asRecord as record } from '../../shared/records.js';
import { sha256Hex as hashToken } from '../utils/sha256.js';

export type ProposalFeedbackKind = 'question' | 'change_request';
export type ProposalFollowupStep = {
  afterDays: number;
  localTime: string;
  subject: string;
  message: string;
};

function dateInTimezone(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

type FollowupProposalBasis = { status: string; sentAt?: Date | string | null; recipientEmail?: string | null; validUntil?: Date | string | null };

function calculateFollowupSchedule(proposal: FollowupProposalBasis, input: { timezone: string; steps: ProposalFollowupStep[] }) {
  if (!isValidIanaTimezone(input.timezone)) throw new ProposalWorkflowError('Choose a valid IANA timezone', 400);
  if (!['sent', 'viewed'].includes(proposal.status) || !proposal.sentAt || !proposal.recipientEmail) {
    throw new ProposalWorkflowError('Send the proposal by email before scheduling customer follow-ups', 409);
  }
  const baseDate = dateInTimezone(new Date(proposal.sentAt), input.timezone);
  const schedule = input.steps.map((step, index) => {
    const localDate = addCalendarDays(baseDate, step.afterDays);
    const due = zonedDateTimeToUtc(localDate, step.localTime, input.timezone);
    if (!due) throw new ProposalWorkflowError(`Follow-up ${index + 1} has an invalid local time`, 400);
    if (due <= new Date()) throw new ProposalWorkflowError(`Follow-up ${index + 1} is already in the past`, 400);
    if (proposal.validUntil && due >= new Date(proposal.validUntil)) throw new ProposalWorkflowError(`Follow-up ${index + 1} must be scheduled before the proposal expires`, 400);
    return { ...step, due, localDate };
  });
  if (new Set(schedule.map(item => item.due.toISOString())).size !== schedule.length) {
    throw new ProposalWorkflowError('Each follow-up must have a different delivery time', 400);
  }
  return schedule;
}

async function buildFollowupSchedule(userId: number, proposalId: number, input: { timezone: string; steps: ProposalFollowupStep[] }) {
  const proposal = await proposalService.getProposalById(userId, proposalId);
  if (!proposal) throw new ProposalWorkflowError('Proposal not found', 404);
  return calculateFollowupSchedule(proposal, input);
}

function followupMetadata(timezone: string, item: ProposalFollowupStep & { localDate: string }) {
  return {
    timezone,
    afterDays: item.afterDays,
    localDate: item.localDate,
    localTime: item.localTime,
    subject: item.subject,
    message: item.message,
    pauseOnReply: true,
  };
}

async function publicRecord(token: string, lock = false, database: typeof db = db) {
  const result = await database.execute(sql`SELECT id,user_id,status,superseded_by,proposal_number,title,recipient_name,valid_until,
    public_token_expires_at FROM proposals WHERE public_token_hash=${hashToken(token)}
    AND public_token_expires_at IS NOT NULL AND public_token_expires_at > clock_timestamp() LIMIT 1 ${lock ? sql`FOR UPDATE` : sql``}`);
  const proposal = result.rows[0] as undefined | {
    id: number; user_id: number; status: string; superseded_by: number | null;
    proposal_number: string; title: string; recipient_name: string | null;
    valid_until: Date | string | null;
    public_token_expires_at: Date | string;
  };
  // A row lock may wait past the token lifetime without changing the row.
  // PostgreSQL NOW() is the transaction start, so recheck wall time after it.
  return proposal && new Date(proposal.public_token_expires_at).getTime() > Date.now() ? proposal : undefined;
}

export class ProposalLifecycleService {
  async publicFeedback(token: string) {
    const proposal = await publicRecord(token);
    if (!proposal) return null;
    const feedback = await db.execute(sql`SELECT id,kind,author_name AS "authorName",content,
      parent_feedback_id AS "parentFeedbackId",resolved_at AS "resolvedAt",created_at AS "createdAt"
      FROM proposal_feedback WHERE user_id=${proposal.user_id} AND proposal_id=${proposal.id}
      ORDER BY id ASC LIMIT 200`);
    return { proposalId: proposal.id, feedback: feedback.rows };
  }

  async submitPublicFeedback(token: string, input: {
    kind: ProposalFeedbackKind;
    content: string;
    authorName?: string;
    requestKey: string;
  }) {
    const result = await db.transaction(async (tx: typeof db) => {
      const proposal = await publicRecord(token, true, tx);
      if (!proposal) return null;
      const content = input.content.trim();
      const authorName = input.authorName?.trim() || proposal.recipient_name || null;
      const previous = (await tx.execute(sql`SELECT id,kind,author_name AS "authorName",content,
        parent_feedback_id AS "parentFeedbackId",resolved_at AS "resolvedAt",created_at AS "createdAt"
        FROM proposal_feedback WHERE user_id=${proposal.user_id} AND proposal_id=${proposal.id} AND request_key=${input.requestKey} LIMIT 1`)).rows[0];
      const assertSameRequest = (feedback: { kind: string; content: string; authorName: string | null }) => {
        if (feedback.kind !== input.kind || feedback.content !== content || feedback.authorName !== authorName) {
          throw new ProposalWorkflowError('This feedback request key was already used for a different message.', 409);
        }
      };
      // A successful request keeps its receipt after a later lifecycle change.
      // Capability validation still precedes replay, so revocation remains final.
      if (previous) {
        assertSameRequest(previous);
        return { proposal, feedback: previous, created: false };
      }
      if (proposal.superseded_by) throw new ProposalWorkflowError('A newer version of this proposal is available. Open the replacement before sending feedback.', 409);
      if (!['sent', 'viewed'].includes(proposal.status)) throw new ProposalWorkflowError(`This proposal is already ${proposal.status}.`, 409);
      if (proposal.valid_until && new Date(proposal.valid_until).getTime() < Date.now()) {
        throw new ProposalWorkflowError('This proposal has expired', 410);
      }
      const inserted = await tx.execute(sql`INSERT INTO proposal_feedback
        (user_id,proposal_id,kind,author_name,content,request_key,metadata)
        VALUES (${proposal.user_id},${proposal.id},${input.kind},${authorName},${content},${input.requestKey},${JSON.stringify({ source: 'public_proposal' })}::jsonb)
        ON CONFLICT (business_profile_id, user_id,proposal_id,request_key) WHERE request_key IS NOT NULL DO NOTHING
        RETURNING id,kind,author_name AS "authorName",content,parent_feedback_id AS "parentFeedbackId",resolved_at AS "resolvedAt",created_at AS "createdAt"`);
      const feedback = inserted.rows[0] || (await tx.execute(sql`SELECT id,kind,author_name AS "authorName",content,
        parent_feedback_id AS "parentFeedbackId",resolved_at AS "resolvedAt",created_at AS "createdAt"
        FROM proposal_feedback WHERE user_id=${proposal.user_id} AND proposal_id=${proposal.id} AND request_key=${input.requestKey} LIMIT 1`)).rows[0];
      if (!inserted.rows[0]) {
        assertSameRequest(feedback);
        return { proposal, feedback, created: false };
      }
      await tx.execute(sql`UPDATE proposal_reminders SET status='paused',last_sent_at=NULL,
        metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({ pauseReason: input.kind, pausedAt: new Date().toISOString() })}::jsonb,updated_at=NOW()
        WHERE user_id=${proposal.user_id} AND proposal_id=${proposal.id} AND reminder_type='customer_followup'
        AND status IN ('pending','snoozed')`);
      await tx.execute(sql`UPDATE proposals SET status=CASE WHEN status='sent' THEN 'viewed' ELSE status END,
        viewed_at=COALESCE(viewed_at,NOW()),updated_at=NOW() WHERE id=${proposal.id} AND user_id=${proposal.user_id}`);
      return { proposal, feedback, created: true };
    });
    if (!result) return null;
    if (result.created) await NotificationService.notify(
      result.proposal.user_id,
      input.kind === 'question' ? 'Question about a proposal' : 'Proposal change requested',
      `${result.proposal.recipient_name || 'The customer'} sent ${input.kind === 'question' ? 'a question' : 'a change request'} for ${result.proposal.proposal_number}.`,
      'info',
      { actionUrl: `/dashboard/proposals/${result.proposal.id}` },
    );
    return result.feedback;
  }

  async listFeedback(userId: number, proposalId: number) {
    const proposal = await proposalService.getProposalById(userId, proposalId);
    if (!proposal) throw new ProposalWorkflowError('Proposal not found', 404);
    return (await db.execute(sql`SELECT id,kind,author_name AS "authorName",content,parent_feedback_id AS "parentFeedbackId",
      metadata,resolved_at AS "resolvedAt",created_at AS "createdAt" FROM proposal_feedback
      WHERE user_id=${userId} AND proposal_id=${proposalId} ORDER BY id ASC LIMIT 200`)).rows;
  }

  async replyToFeedback(userId: number, proposalId: number, feedbackId: number, content: string) {
    const proposal = await proposalService.getProposalById(userId, proposalId);
    if (!proposal) throw new ProposalWorkflowError('Proposal not found', 404);
    const parent = await db.execute(sql`SELECT id FROM proposal_feedback WHERE id=${feedbackId} AND user_id=${userId} AND proposal_id=${proposalId} AND kind IN ('question','change_request') LIMIT 1`);
    if (!parent.rows[0]) throw new ProposalWorkflowError('Customer feedback not found', 404);
    const owner = await db.execute(sql`SELECT name FROM users WHERE id=${userId} LIMIT 1`);
    return (await db.execute(sql`INSERT INTO proposal_feedback(user_id,proposal_id,kind,author_name,content,parent_feedback_id,metadata)
      VALUES(${userId},${proposalId},'seller_reply',${String(owner.rows[0]?.name || 'Seller')},${content.trim()},${feedbackId},${JSON.stringify({ source: 'seller_workspace' })}::jsonb)
      RETURNING id,kind,author_name AS "authorName",content,parent_feedback_id AS "parentFeedbackId",resolved_at AS "resolvedAt",created_at AS "createdAt"`)).rows[0];
  }

  async resolveFeedback(userId: number, proposalId: number, feedbackId: number, resolved: boolean) {
    const proposal = await proposalService.getProposalById(userId, proposalId);
    if (!proposal) throw new ProposalWorkflowError('Proposal not found', 404);
    const result = await db.execute(sql`UPDATE proposal_feedback SET resolved_at=${resolved ? sql`NOW()` : sql`NULL`}
      WHERE id=${feedbackId} AND user_id=${userId} AND proposal_id=${proposalId} AND kind IN ('question','change_request')
      RETURNING id,resolved_at AS "resolvedAt"`);
    if (!result.rows[0]) throw new ProposalWorkflowError('Customer feedback not found', 404);
    return result.rows[0];
  }

  async createRevision(userId: number, proposalId: number, input: { expectedRevision?: number; feedbackId?: number; draftKey?: string } = {}) {
    const proposal = await proposalService.getProposalById(userId, proposalId);
    if (!proposal) throw new ProposalWorkflowError('Proposal not found', 404);
    if (input.expectedRevision !== undefined && proposal.revision !== input.expectedRevision) {
      throw new ProposalWorkflowError(`The proposal is now revision ${proposal.revision}. Reload it before creating a revision.`, 409);
    }
    if (!['draft', 'sent', 'viewed', 'rejected', 'expired', 'superseded'].includes(proposal.status)) {
      throw new ProposalWorkflowError('This proposal cannot be revised in its current state', 409);
    }
    let feedback: Record<string, unknown> | undefined;
    if (input.feedbackId) {
      feedback = (await db.execute(sql`SELECT id,kind,content FROM proposal_feedback WHERE id=${input.feedbackId}
        AND user_id=${userId} AND proposal_id=${proposalId} AND kind IN ('question','change_request') LIMIT 1`)).rows[0];
      if (!feedback) throw new ProposalWorkflowError('Customer feedback not found', 404);
    }
    const metadata = { ...record(proposal.metadata) } as ProposalDocumentMetadata;
    for (const key of ['approvalFingerprint', 'approvedAt', 'deliveryTarget', 'deliveryAttempt', 'sellerReviewedAt', 'teamApproval', 'onboarding', 'onboardingTicketId']) {
      delete metadata[key];
    }
    metadata.revisionOf = proposal.id;
    if (feedback) metadata.revisionRequest = { feedbackId: feedback.id, kind: feedback.kind, content: feedback.content };
    const revision = await proposalService.createProposal(userId, {
      title: proposal.title,
      coverNote: proposal.coverNote || undefined,
      recipientName: proposal.recipientName || undefined,
      recipientEmail: proposal.recipientEmail || undefined,
      contactId: proposal.contactId || undefined,
      leadId: proposal.leadId || undefined,
      outreachConversationId: proposal.outreachConversationId || undefined,
      chatThreadId: proposal.chatThreadId || undefined,
      supportTicketId: Number(proposal.metadata?.supportTicketId || 0) || undefined,
      businessProfileId: proposal.businessProfileId || undefined,
      templateId: proposal.templateId || undefined,
      // A revision keeps the brand the customer already saw.
      inheritedBrandToolkitId: proposal.brandToolkitId,
      draftKey: input.draftKey,
      approvalRequired: true,
      autoOnboard: proposal.metadata?.autoOnboard !== false,
      onboardingPlan: proposal.metadata?.onboardingPlan,
      currency: proposal.currency || 'USD',
      validUntil: proposal.validUntil && proposal.validUntil > new Date() ? proposal.validUntil : undefined,
      signatureRequired: proposal.signatureRequired === true,
      showTermsAndConditions: proposal.showTermsAndConditions === true,
      termsAndConditions: proposal.termsAndConditions || undefined,
      discountType: proposal.discountType === 'fixed' || proposal.discountType === 'percentage' ? proposal.discountType : null,
      discountValue: Number(proposal.discountValue || 0),
      taxRate: Number(proposal.taxRate || 0),
      generatedSections: proposal.metadata?.generatedSections,
      commercial: proposal.metadata?.commercial,
      requirements: proposal.metadata?.requirements,
      assumptions: proposal.metadata?.assumptions,
      templateValues: proposal.metadata?.templateValues,
      knowledgeBaseSections: proposal.knowledgeBaseSections || [],
      lineItems: proposal.lineItems.map(proposalLineItemInput),
      metadata,
    });
    if (input.feedbackId) {
      await db.execute(sql`UPDATE proposal_feedback SET resolved_at=NOW(),metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({ revisionProposalId: revision.id })}::jsonb
        WHERE id=${input.feedbackId} AND user_id=${userId} AND proposal_id=${proposalId}`);
    }
    return proposalService.getProposalById(userId, revision.id);
  }

  async previewFollowups(userId: number, proposalId: number, input: { timezone: string; steps: ProposalFollowupStep[] }) {
    const schedule = await buildFollowupSchedule(userId, proposalId, input);
    return {
      timezone: input.timezone,
      scheduled: schedule.map(item => ({
        reminderDueAt: item.due.toISOString(),
        metadata: followupMetadata(input.timezone, item),
      })),
    };
  }

  async scheduleFollowups(userId: number, proposalId: number, input: { timezone: string; steps: ProposalFollowupStep[] }) {
    if (!isValidIanaTimezone(input.timezone)) throw new ProposalWorkflowError('Choose a valid IANA timezone', 400);
    const scheduleKey = crypto.randomUUID();
    return db.transaction(async (tx: typeof db) => {
      const locked = (await tx.execute(sql`SELECT status,sent_at,recipient_email,valid_until FROM proposals WHERE id=${proposalId} AND user_id=${userId} FOR UPDATE`)).rows[0];
      if (!locked) throw new ProposalWorkflowError('Proposal not found', 404);
      const schedule = calculateFollowupSchedule({ status: String(locked.status), sentAt: locked.sent_at as Date | string | null, recipientEmail: locked.recipient_email as string | null, validUntil: locked.valid_until as Date | string | null }, input);
      await tx.execute(sql`UPDATE proposal_reminders SET status='cancelled',updated_at=NOW(),
        metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({ replacedAt: new Date().toISOString() })}::jsonb
        WHERE user_id=${userId} AND proposal_id=${proposalId} AND reminder_type='customer_followup' AND status IN ('pending','paused','snoozed')`);
      const rows: unknown[] = [];
      for (const item of schedule) {
        const result = await tx.execute(sql`INSERT INTO proposal_reminders(user_id,proposal_id,reminder_due_at,reminder_type,metadata)
          VALUES(${userId},${proposalId},${item.due},'customer_followup',${JSON.stringify({ scheduleKey, ...followupMetadata(input.timezone, item) })}::jsonb) RETURNING id,reminder_due_at AS "reminderDueAt",status,metadata`);
        rows.push(result.rows[0]);
      }
      return { timezone: input.timezone, scheduled: rows };
    });
  }

  async setFollowupsPaused(userId: number, proposalId: number, paused: boolean) {
    const proposal = await proposalService.getProposalById(userId, proposalId);
    if (!proposal) throw new ProposalWorkflowError('Proposal not found', 404);
    const now = new Date();
    const result = paused
      ? await db.execute(sql`UPDATE proposal_reminders SET status='paused',last_sent_at=NULL,updated_at=NOW(),
          metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({ pauseReason: 'seller', pausedAt: now.toISOString() })}::jsonb
          WHERE user_id=${userId} AND proposal_id=${proposalId} AND reminder_type='customer_followup' AND status IN ('pending','snoozed') RETURNING id`)
      : await db.execute(sql`UPDATE proposal_reminders SET status='pending',snoozed_until=NULL,last_sent_at=NULL,
          reminder_due_at=GREATEST(reminder_due_at,NOW()+INTERVAL '5 minutes'),updated_at=NOW(),
          metadata=(COALESCE(metadata,'{}'::jsonb)-'pauseReason')||${JSON.stringify({ resumedAt: now.toISOString() })}::jsonb
          WHERE user_id=${userId} AND proposal_id=${proposalId} AND reminder_type='customer_followup' AND status='paused' RETURNING id`);
    return { paused, updated: result.rows.length };
  }

  async onboardingResources(userId: number) {
    const [teams, members] = await Promise.all([
      db.execute(sql`SELECT id,name FROM support_teams WHERE user_id=${userId} AND is_active=true ORDER BY name,id`),
      db.execute(sql`SELECT m.id,m.team_id AS "teamId",m.name,m.email,m.timezone FROM team_members m
        JOIN support_teams t ON t.id=m.team_id AND t.user_id=m.user_id
        WHERE m.user_id=${userId} AND m.is_active=true AND t.is_active=true ORDER BY m.name,m.id`),
    ]);
    return { teams: teams.rows, members: members.rows };
  }
}

export const proposalLifecycleService = new ProposalLifecycleService();
