import { db } from "../models/db.js";
import { sql } from "drizzle-orm";
import crypto from "crypto";

function canonicalApprovalValue(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalApprovalValue).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalApprovalValue(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function proposalApprovalFingerprint(
  proposal: Record<string, unknown>,
): string {
  const metadata = (proposal.metadata || {}) as Record<string, unknown>;
  return crypto
    .createHash("sha256")
    .update(
      canonicalApprovalValue({
        title: proposal.title,
        coverNote: proposal.coverNote,
        recipientName: proposal.recipientName,
        recipientEmail: proposal.recipientEmail,
        currency: proposal.currency,
        total: proposal.total,
        discountType: proposal.discountType,
        discountValue: proposal.discountValue,
        taxRate: proposal.taxRate,
        validUntil: proposal.validUntil,
        signatureRequired: proposal.signatureRequired,
        termsAndConditions: proposal.termsAndConditions,
        showTermsAndConditions: proposal.showTermsAndConditions,
        sections: metadata.generatedSections,
        commercial: metadata.commercial,
        deliveryTarget: metadata.deliveryTarget,
        lineItems: proposal.lineItems,
      }),
    )
    .digest("hex");
}

/** Resolve only explicitly linked tenant-owned identities. Do not match by display name. */
export async function proposalSourceContext(
  userId: number,
  input: {
    contactId?: number;
    leadId?: number;
    outreachConversationId?: number;
    chatThreadId?: number;
    supportTicketId?: number;
  },
) {
  const refs = { ...input };
  let text = "";
  let recipientName = "";
  let recipientEmail = "";
  const inherit = (
    key: "contactId" | "leadId" | "outreachConversationId",
    value: unknown,
  ) => {
    if (!value) return;
    const id = Number(value);
    if (refs[key] && refs[key] !== id)
      throw new Error("The selected customer and source do not match");
    refs[key] = id;
  };
  if (refs.supportTicketId) {
    const result = await db.execute(
      sql`SELECT subject, description, contact_id, lead_id, outreach_conversation_id FROM support_tickets WHERE id=${refs.supportTicketId} AND user_id=${userId} AND deleted_at IS NULL`,
    );
    const ticket = result.rows[0];
    if (!ticket) throw new Error("Support ticket not found");
    inherit("contactId", ticket.contact_id);
    inherit("leadId", ticket.lead_id);
    inherit("outreachConversationId", ticket.outreach_conversation_id);
    text += `Support requirement: ${ticket.subject}\n${ticket.description || ""}\n`;
  }
  if (refs.outreachConversationId) {
    const result = await db.execute(
      sql`SELECT lead_id, crm_contact_id, lead_name, lead_email FROM outreach_conversations WHERE id=${refs.outreachConversationId} AND user_id=${userId}`,
    );
    const conversation = result.rows[0];
    if (!conversation) throw new Error("Outreach conversation not found");
    inherit("contactId", conversation.crm_contact_id);
    inherit("leadId", conversation.lead_id);
    recipientName = conversation.lead_name || "";
    recipientEmail = conversation.lead_email || "";
    // Never expose restricted originals from the support privacy vault to generation.
    const messages = await db.execute(
      sql`SELECT direction, redacted_content FROM outreach_messages WHERE conversation_id=${refs.outreachConversationId} AND user_id=${userId} AND redacted_content IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 30`,
    );
    text += messages.rows
      .reverse()
      .map(
        (m: { direction: string; redacted_content: string }) =>
          `${m.direction}: ${m.redacted_content}`,
      )
      .join("\n");
  }
  if (refs.contactId) {
    const result = await db.execute(
      sql`SELECT concat_ws(' ',first_name,last_name) AS name,email,lead_id FROM crm_contacts WHERE id=${refs.contactId} AND user_id=${userId} AND deleted_at IS NULL`,
    );
    const contact = result.rows[0];
    if (!contact) throw new Error("Contact not found");
    inherit("leadId", contact.lead_id);
    recipientName ||= contact.name || "";
    recipientEmail ||= contact.email || "";
  }
  if (refs.leadId) {
    const leadResult = await db.execute(
      sql`SELECT id,COALESCE(full_name,name) AS name,email FROM leads WHERE id=${refs.leadId} AND user_id=${userId} AND deleted_at IS NULL`,
    );
    const lead = leadResult.rows[0];
    if (!lead) throw new Error("Lead not found");
    recipientName ||= lead.name || "";
    recipientEmail ||= lead.email || "";
    if (!refs.contactId) {
      const contactResult = await db.execute(
        sql`SELECT id FROM crm_contacts WHERE lead_id=${refs.leadId} AND user_id=${userId} AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      );
      if (contactResult.rows[0]) refs.contactId = contactResult.rows[0].id;
    }
  }
  if (refs.chatThreadId) {
    const thread = await db.execute(
      sql`SELECT id FROM chat_threads WHERE id=${refs.chatThreadId} AND user_id=${userId}`,
    );
    if (!thread.rows[0]) throw new Error("Conversation not found");
    const messages = await db.execute(
      sql`SELECT role,content FROM chat_messages WHERE thread_id=${refs.chatThreadId} AND user_id=${userId} AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 20`,
    );
    text +=
      "\n" +
      messages.rows
        .reverse()
        .map(
          (m: { role: string; content: string }) => `${m.role}: ${m.content}`,
        )
        .join("\n");
  }
  return { refs, text: text.slice(-30000), recipientName, recipientEmail };
}

export async function reconcileProposalExpiry(userId?: number, proposalId?: number) {
  const scope = sql`${userId ? sql`AND user_id=${userId}` : sql``} ${proposalId ? sql`AND id=${proposalId}` : sql``}`;
  const reminderScope = sql`${userId ? sql`AND p.user_id=${userId}` : sql``} ${proposalId ? sql`AND p.id=${proposalId}` : sql``}`;
  await db.execute(
    sql`UPDATE proposals SET status='expired', updated_at=NOW() WHERE status IN ('sent','viewed') AND valid_until < NOW() ${scope}`,
  );
  await db.execute(
    sql`UPDATE proposal_reminders r SET status='cancelled',updated_at=NOW() FROM proposals p WHERE r.proposal_id=p.id AND r.user_id=p.user_id AND r.status IN ('pending','processing','paused','snoozed') AND (p.status IN ('accepted','rejected','expired') OR p.valid_until < NOW()) ${reminderScope}`,
  );
}

/** Durable lifecycle events are installed by migration 248 in the same transaction as state changes. */
export async function processProposalEvents(scope: { userId?: number; proposalId?: number } = {}) {
  if (scope.userId !== undefined && (!Number.isSafeInteger(scope.userId) || scope.userId <= 0)) throw new Error('Invalid proposal event user scope');
  if (scope.proposalId !== undefined && (!Number.isSafeInteger(scope.proposalId) || scope.proposalId <= 0)) throw new Error('Invalid proposal event scope');
  const userScope = scope.userId ? sql`AND user_id=${scope.userId}` : sql``;
  const proposalScope = scope.proposalId ? sql`AND id=${scope.proposalId}` : sql``;
  const reminderUserScope = scope.userId ? sql`AND user_id=${scope.userId}` : sql``;
  const reminderProposalScope = scope.proposalId ? sql`AND proposal_id=${scope.proposalId}` : sql``;
  const eventUserScope = scope.userId ? sql`AND user_id=${scope.userId}` : sql``;
  const eventProposalScope = scope.proposalId ? sql`AND proposal_id=${scope.proposalId}` : sql``;
  await reconcileProposalExpiry(scope.userId, scope.proposalId);
  // Inconclusive deliveries require seller reconciliation, never an automatic resend.
  await db.execute(
    sql`UPDATE proposals SET status='delivery_unknown',updated_at=NOW() WHERE status='sending' AND updated_at < NOW()-INTERVAL '15 minutes' ${userScope} ${proposalScope}`,
  );
  await db.execute(
    sql`UPDATE proposal_reminders SET status='failed',metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('last_error','Customer follow-up delivery could not be confirmed. Check provider history before rescheduling.'),updated_at=NOW() WHERE reminder_type='customer_followup' AND status='pending' AND last_sent_at < NOW()-INTERVAL '15 minutes' ${reminderUserScope} ${reminderProposalScope}`,
  );
  await db.execute(
    sql`UPDATE proposal_reminders SET status='pending',reminder_due_at=snoozed_until,snoozed_until=NULL,last_sent_at=NULL,updated_at=NOW() WHERE status='snoozed' AND snoozed_until<=NOW() ${reminderUserScope} ${reminderProposalScope}`,
  );
  const pending = await db.execute(
    sql`SELECT id FROM proposal_events WHERE processed_at IS NULL AND next_attempt_at <= NOW() ${eventUserScope} ${eventProposalScope} ORDER BY id LIMIT 100`,
  );
  for (const row of pending.rows) {
    try {
      await db.transaction(async (tx: typeof db) => {
        const result = await tx.execute(
          sql`SELECT * FROM proposal_events WHERE id=${row.id} AND processed_at IS NULL FOR UPDATE SKIP LOCKED`,
        );
        const event = result.rows[0];
        if (!event) return;
        const p = event.payload;
        const currentResult = await tx.execute(
          sql`SELECT * FROM proposals WHERE id=${event.proposal_id} AND user_id=${event.user_id}`,
        );
        const current = currentResult.rows[0];
        if (!current) return;
        let resolvedContact = false;
        if (!current.contact_id && current.lead_id) {
          const contactResult = await tx.execute(
            sql`SELECT id FROM crm_contacts WHERE user_id=${event.user_id} AND lead_id=${current.lead_id} AND deleted_at IS NULL ORDER BY id LIMIT 1`,
          );
          if (contactResult.rows[0]) {
            current.contact_id = contactResult.rows[0].id;
            resolvedContact = true;
          }
        }
        if (current.contact_id) {
          // CRMService owns its own transaction and locks the contact FOR UPDATE.
          // Run it before our FK writes acquire a KEY SHARE contact lock, or the
          // two connections wait on each other. A retry is safe: CRM stage writes
          // are idempotent and this event remains pending until our commit.
          // Do not replay obsolete sent events over a later accepted/declined decision.
          const stage =
            current.status === "accepted"
              ? "won"
              : current.status === "rejected"
                ? "lost"
                : ["sent", "viewed"].includes(current.status)
                  ? "proposal_sent"
                  : null;
          if (stage) {
            const { crmService } = await import("./CRMService.js");
            const contact = await tx.execute(
              sql`SELECT pipeline_status FROM crm_contacts WHERE id=${current.contact_id} AND user_id=${event.user_id}`,
            );
            if (contact.rows[0] && contact.rows[0].pipeline_status !== stage)
              await crmService.updatePipelineStatus(
                event.user_id,
                current.contact_id,
                stage,
              );
          }
          if (resolvedContact) {
            await tx.execute(
              sql`UPDATE proposals SET contact_id=${current.contact_id} WHERE id=${event.proposal_id} AND user_id=${event.user_id}`,
            );
          }
          await tx.execute(sql`INSERT INTO crm_activities (user_id,contact_id,type,subject,body,metadata,idempotency_key)
            VALUES (${event.user_id},${current.contact_id},'proposal',${`Proposal ${event.kind}: ${p.title}`.slice(0, 500)},${`Proposal ${p.proposal_number}`},${JSON.stringify({ proposalId: event.proposal_id, event: event.kind })}::jsonb,${`proposal-event:${event.id}`})
            ON CONFLICT (business_profile_id, user_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`);
        }
        if (
          event.kind === "draft" &&
          p.metadata?.deliveryReview?.outcome === "not_delivered" &&
          p.metadata?.deliveryAttempt?.creditTransactionId
        ) {
          const { creditService } = await import("./CreditService.js");
          await creditService.refundDeduction({
            userId: event.user_id,
            transactionId: p.metadata.deliveryAttempt.creditTransactionId,
            description: `Proposal delivery reconciled as not delivered: ${event.proposal_id}`,
          });
        }
        if (event.kind === "accepted" && p.metadata?.autoOnboard !== false) {
          const { supportService } = await import("./SupportService.js");
          const plan = p.metadata?.onboardingPlan && typeof p.metadata.onboardingPlan === 'object'
            ? p.metadata.onboardingPlan as { teamId?: number | null; assignedMemberId?: number | null; dueDate?: string | null; checklist?: Array<{ id: string; title: string; deliverable?: string; dueDate?: string | null }> }
            : {};
          const checklist = Array.isArray(plan.checklist) ? plan.checklist : [];
          const checklistText = checklist.length
            ? `\n\nOnboarding checklist:\n${checklist.map((item, index) => `${index + 1}. ${item.title}${item.deliverable ? ` — ${item.deliverable}` : ''}${item.dueDate ? ` (due ${item.dueDate})` : ''}`).join('\n')}`
            : '';
          const dueDate = plan.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(plan.dueDate)
            ? new Date(`${plan.dueDate}T23:59:59.999Z`)
            : undefined;
          const ticket = await supportService.createTicket(
            event.user_id,
            {
              contactId: current.contact_id || undefined,
              leadId: current.lead_id || undefined,
              outreachConversationId:
                current.outreach_conversation_id || undefined,
              teamId: plan.teamId || undefined,
              assignedMemberId: plan.assignedMemberId || undefined,
              subject: `Onboarding: ${p.title}`.slice(0, 500),
              category: "ai_handoff",
              handoffKey: `proposal-accepted:${event.proposal_id}`,
              tags: ["proposal", "onboarding"],
              slaDeadline: dueDate,
              autoAssign: Boolean(plan.teamId && !plan.assignedMemberId),
              description:
                `${p.cover_note || ""}\n\n${JSON.stringify(p.metadata?.generatedSections || [])}\n\nAgreed items: ${JSON.stringify(p.line_items || [])}\nAgreed investment: ${p.currency} ${p.total}\nTerms: ${p.terms_and_conditions || ""}${checklistText}\nProposal: /dashboard/proposals/${event.proposal_id}`.slice(
                  0,
                  20000,
                ),
            },
            { database: tx, deferNotificationWakeup: true },
          );
          const onboarding = {
            proposalId: event.proposal_id,
            proposalNumber: p.proposal_number,
            dueDate: plan.dueDate || null,
            checklist: checklist.map(item => ({ ...item, status: 'pending' })),
            createdAt: new Date().toISOString(),
          };
          await tx.execute(sql`UPDATE support_tickets SET metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({ proposalOnboarding: onboarding })}::jsonb,updated_at=NOW()
            WHERE id=${ticket.id} AND user_id=${event.user_id}`);
          await tx.execute(
            sql`UPDATE proposals SET metadata=COALESCE(metadata,'{}'::jsonb) || ${JSON.stringify({ onboardingTicketId: ticket.id, onboarding: { status: 'created', supportTicketId: ticket.id, teamId: ticket.teamId || null, assignedMemberId: ticket.assignedMemberId || null, createdAt: new Date().toISOString() } })}::jsonb WHERE id=${event.proposal_id} AND user_id=${event.user_id}`,
          );
        } else if (event.kind === 'accepted') {
          await tx.execute(sql`UPDATE proposals SET metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({ onboarding: { status: 'disabled' } })}::jsonb
            WHERE id=${event.proposal_id} AND user_id=${event.user_id}`);
        }
        await tx.execute(
          sql`UPDATE proposal_events SET processed_at=NOW(),last_error=NULL WHERE id=${event.id}`,
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : "Lifecycle processing failed";
      await db.execute(sql`UPDATE proposals proposal SET metadata=COALESCE(proposal.metadata,'{}'::jsonb)||${JSON.stringify({ onboarding: { status: 'failed', lastError: message } })}::jsonb
        FROM proposal_events event WHERE event.id=${row.id} AND event.proposal_id=proposal.id AND event.user_id=proposal.user_id AND event.kind='accepted'`);
      await db.execute(
        sql`UPDATE proposal_events SET attempts=attempts+1,next_attempt_at=NOW()+LEAST(60,POWER(2,LEAST(attempts,6))) * INTERVAL '1 minute',last_error=${message} WHERE id=${row.id}`,
      );
    }
  }
}
