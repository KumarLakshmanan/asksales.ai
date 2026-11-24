import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import {
  requireBusinessScope,
  withBusinessScope,
  withSystemScope,
} from "../../tenancy/businessContext.js";
import {
  assistantRolloutProfiles,
  assistantsRuntimeEnabled,
  currentAssistant,
} from "./AssistantContext.js";
import {
  assertAssistantFresh,
  withPublishedAssistant,
} from "./AssistantFreshness.js";
import {
  assistantTemplateVariableAllowed,
  nextAssistantOpen,
  withinAssistantHours,
} from "./AssistantConfiguration.js";
import {
  loadFollowUpTemplate,
  renderFollowUpTemplate,
} from "../followUpTemplateService.js";
import { extractTemplateVariables } from "../../utils/contentTemplateRendering.js";
import { deliveryOutboxService } from "../agents/orchestration/DeliveryOutboxService.js";
import { redactPiiWithStableTokens } from "../agents/orchestration/PrivacyVaultService.js";
import { parseUtcDatabaseTimestamp } from "../socialFollowUpService.js";
import type { SupportDeliveryOutboxRecord } from "../../models/supportOrchestration/schema.js";
import { logger } from "../../utils/logger.js";
import { assistantReplyWindowOpen, generateAssistantAiFollowUp } from './AssistantAiFollowUp.js';
import { assistantAiFollowUpAvailable } from '../../../shared/outreachAssistants.js';

type Row = Record<string, any>;
type Executor = Pick<typeof db, "execute">;
export async function cancelAssistantFollowUps(
  conversationId: number,
  reason: string,
  executor: Executor = db,
) {
  if (!assistantsRuntimeEnabled()) return;
  const scope = requireBusinessScope();
  await executor.execute(sql`UPDATE outreach_assistant_follow_up_schedules SET status='cancelled',version=version+1,
    cancellation_reason=${reason},updated_at=NOW() WHERE user_id=${scope.userId} AND conversation_id=${conversationId}
      AND status IN ('active','queued')`);
  await executor.execute(sql`UPDATE support_delivery_outbox SET status='cancelled',next_attempt_at=NULL,last_error=${reason},updated_at=NOW()
    WHERE user_id=${scope.userId} AND conversation_id=${conversationId} AND status IN ('pending','failed','drafted')
      AND payload->'metadata'->>'dispatchKind'='assistant_follow_up'`);
}

/** Only an acknowledged support reply can become an anchor. Campaign openings never enter this sequence. */
export async function scheduleAssistantFollowUp(
  messageId: number,
): Promise<boolean> {
  if (!assistantsRuntimeEnabled()) return false;
  const scope = requireBusinessScope();
  const result =
    await db.execute(sql`SELECT m.*,c.channel,c.automation_mode,c.session_ended_at,c.status AS conversation_status
    FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
    WHERE m.id=${messageId} AND m.user_id=${scope.userId} AND m.direction='outbound' AND m.message_kind='reply'
      AND m.status IN ('sent','delivered','read') AND m.provider_call_state='confirmed' AND m.metadata->'assistant' IS NOT NULL`);
  const anchor = result.rows[0] as Row | undefined;
  if (
    !anchor ||
    anchor.metadata?.assistantAway || anchor.metadata?.suppressAssistantFollowUp ||
    !["whatsapp", "instagram", "facebook", "email"].includes(anchor.channel)
  )
    return false;
  return withPublishedAssistant(anchor.metadata.assistant, async () => {
    const assistant = currentAssistant()!,
      p = assistant.provenance;
    const sequence =
      assistant.configuration.followUps.mode === "selected"
        ? assistant.configuration.followUps.sequences.find(
            (s) => s.channel === anchor.channel,
          )
        : undefined;
    if (
      !sequence ||
      p.surface !== "private" ||
      anchor.automation_mode !== "ai_active" ||
      anchor.session_ended_at ||
      ["closed", "unsubscribed"].includes(anchor.conversation_status)
    )
      return false;
    return db.transaction(async (tx: typeof db) => {
      // Serialize competing confirmed reply anchors. An older reply cannot cancel
      // a newer sequence after losing the upsert race.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(20260930,${Number(anchor.conversation_id)})`,
      );
      await assertAssistantFresh(tx);
      const existing =
        await tx.execute(sql`SELECT anchor_message_id FROM outreach_assistant_follow_up_schedules
      WHERE conversation_id=${Number(anchor.conversation_id)} AND user_id=${scope.userId}`);
      if (
        existing.rows[0] &&
        Number(existing.rows[0].anchor_message_id) >= messageId
      )
        return false;
      const sentAt = parseUtcDatabaseTimestamp(
        anchor.sent_at || anchor.created_at,
      );
      const steps = [...sequence.steps].sort(
        (a, b) => a.delayMinutes - b.delayMinutes,
      );
      const open = nextAssistantOpen(
        assistant.configuration.availability,
        new Date(sentAt.getTime() + steps[0].delayMinutes * 60000),
      );
      if (!open) return false;
      // No simultaneous campaign reminder and support check-in for this conversation.
      const { cancelConversationEmailFollowUps } =
        await import("../emailFollowUpService.js");
      await cancelConversationEmailFollowUps(
        Number(anchor.conversation_id),
        sentAt,
      );
      await tx.execute(sql`UPDATE social_follow_up_schedules SET status='cancelled',version=version+1,cancelled_at=NOW(),
      cancellation_reason='assistant_support_sequence',updated_at=NOW() WHERE conversation_id=${Number(anchor.conversation_id)}
        AND user_id=${scope.userId} AND status IN ('active','queued')`);
      await cancelAssistantFollowUps(
        Number(anchor.conversation_id),
        "new_support_reply",
        tx,
      );
      const inserted =
        await tx.execute(sql`INSERT INTO outreach_assistant_follow_up_schedules
      (user_id,conversation_id,anchor_message_id,binding_id,assistant_provenance,steps,next_run_at,anchor_sent_at)
      VALUES(${scope.userId},${Number(anchor.conversation_id)},${messageId},${p.bindingId},${JSON.stringify(p)}::jsonb,
        ${JSON.stringify(steps)}::jsonb,${open},${sentAt})
      ON CONFLICT(conversation_id) DO UPDATE SET anchor_message_id=EXCLUDED.anchor_message_id,binding_id=EXCLUDED.binding_id,
        assistant_provenance=EXCLUDED.assistant_provenance,steps=EXCLUDED.steps,next_step=0,next_run_at=EXCLUDED.next_run_at,
        anchor_sent_at=EXCLUDED.anchor_sent_at,status='active',cancellation_reason=NULL,
        version=outreach_assistant_follow_up_schedules.version+1,updated_at=NOW()
      WHERE EXCLUDED.anchor_message_id>outreach_assistant_follow_up_schedules.anchor_message_id RETURNING id`);
      return Boolean(inserted.rows.length);
    });
  });
}

/** Final authorization reads current conversation ownership, opt-out, anchor and exact account. */
async function eligible(
  scheduleId: number,
  version: number,
  step: number,
): Promise<Row | null> {
  const scope = requireBusinessScope(),
    p = currentAssistant()?.provenance;
  if (!p || p.surface !== "private") return null;
  await assertAssistantFresh();
  const result =
    await db.execute(sql`SELECT s.*,c.channel,c.external_thread_id,c.provider_account_id,c.lead_email,c.subject,c.brand_toolkit_id,
      (SELECT MAX(m.created_at) FROM outreach_messages m WHERE m.conversation_id=c.id AND m.user_id=c.user_id AND m.direction='inbound') AS last_inbound_at,
      (SELECT m.rfc_message_id FROM outreach_messages m WHERE m.conversation_id=c.id AND m.user_id=c.user_id
        AND m.business_profile_id=c.business_profile_id AND m.direction='inbound' ORDER BY m.id DESC LIMIT 1) AS last_inbound_rfc_message_id
    FROM outreach_assistant_follow_up_schedules s JOIN outreach_conversations c ON c.id=s.conversation_id AND c.user_id=s.user_id
    WHERE s.id=${scheduleId} AND s.user_id=${scope.userId} AND s.business_profile_id=${scope.businessProfileId}
      AND s.version=${version} AND s.next_step=${step} AND s.status IN ('active','queued')
      AND s.binding_id=${p.bindingId} AND c.provider_account_id=${p.accountId} AND c.channel=${p.channel}
      AND c.automation_mode='ai_active' AND c.session_ended_at IS NULL AND c.status NOT IN ('closed','unsubscribed')
      AND NOT EXISTS(SELECT 1 FROM handoff_queue h WHERE h.user_id=c.user_id AND h.conversation_id=c.id
        AND h.status IN ('waiting','assigned','in_progress'))
      AND NOT EXISTS(SELECT 1 FROM outreach_messages m WHERE m.conversation_id=c.id AND m.id>s.anchor_message_id
        AND (m.direction='inbound' OR (m.direction='outbound' AND m.message_kind='reply' AND m.status IN ('sent','delivered','read'))))`);
  return result.rows[0] || null;
}

async function stop(
  scheduleId: number,
  version: number,
  status: "cancelled" | "stopped" | "uncertain",
  reason: string,
) {
  await db.execute(sql`UPDATE outreach_assistant_follow_up_schedules SET status=${status},cancellation_reason=${reason},updated_at=NOW()
    WHERE id=${scheduleId} AND version=${version} AND status IN ('active','queued')`);
}

/** Templates are re-approved/revalidated and personalized at this boundary, never in a model prompt. */
async function renderForDelivery(row: Row) {
  const assistant = currentAssistant()!,
    scope = requireBusinessScope();
  const step = row.steps[Number(row.next_step)];
  if (
    !step ||
    !assistant.configuration.followUps.sequences.some(
      (s) =>
        s.channel === row.channel &&
        s.steps.some(
          (t) =>
            t.templateId === step.templateId &&
            (t.messageMode || 'template') === (step.messageMode || 'template') &&
            t.delayMinutes === step.delayMinutes,
        ),
    )
  )
    throw new Error("Follow-up step is not assigned.");
  if (step.messageMode === 'ai') {
    if (!assistantAiFollowUpAvailable(row.channel, step.delayMinutes) || step.templateId !== 0
      || (row.channel === 'whatsapp' && !assistantReplyWindowOpen(row.last_inbound_at))) throw new Error('The AI follow-up reply window is closed or its configuration is invalid.');
    const history = await db.execute(sql`SELECT direction,COALESCE(redacted_content,content) AS content FROM outreach_messages
      WHERE conversation_id=${Number(row.conversation_id)} AND user_id=${scope.userId} AND id<=${Number(row.anchor_message_id)}
      AND (direction='inbound' OR (direction='outbound' AND status IN ('sent','delivered','read')))
      ORDER BY id DESC LIMIT 8`);
    return generateAssistantAiFollowUp({ userId: scope.userId, conversationId: Number(row.conversation_id), channel: row.channel === 'email' ? 'email' : 'whatsapp',
      history: [...history.rows].reverse().map(message => ({ direction: String(message.direction), content: String(message.content || '') })) });
  }
  const { template, context } = await loadFollowUpTemplate(
    scope.userId,
    row.channel,
    Number(step.templateId),
  );
  const variables = extractTemplateVariables(
    [template.content, template.subject, template.htmlContent]
      .filter(Boolean)
      .join("\n"),
  );
  if (
    variables.some(
      (v) =>
        !assistantTemplateVariableAllowed(
          v,
          assistant.configuration.privacy.permittedCollectionFields,
        ),
    )
  ) {
    throw new Error(
      "The template requires unknown or unpermitted personal values.",
    );
  }
  // SQL selects only delivery fields; the result never crosses the model boundary.
  const personal =
    await db.execute(sql`SELECT l.first_name,l.last_name,l.full_name,l.name,l.email,l.phone,l.company_name
    FROM outreach_conversations c JOIN leads l ON l.id=c.lead_id AND l.user_id=c.user_id
    WHERE c.id=${Number(row.conversation_id)} AND c.user_id=${scope.userId}`);
  const lead = personal.rows[0] || {},
    business = context.businessProfile;
  const fullName = String(
    lead.full_name ||
      lead.name ||
      [lead.first_name, lead.last_name].filter(Boolean).join(" "),
  );
  const all: Record<string, string | null | undefined> = {
    first_name: lead.first_name || fullName.split(" ")[0],
    last_name: lead.last_name,
    full_name: fullName,
    email: lead.email,
    phone: lead.phone,
    company_name: lead.company_name,
    your_company_name: business.companyName || business.businessName,
    your_website: business.website,
    your_industry: business.industry,
    value_proposition: business.valueProposition,
    target_audience: business.targetMarket,
  };
  const values = Object.fromEntries(
    Object.entries(all).filter(([key]) =>
      assistantTemplateVariableAllowed(
        key,
        assistant.configuration.privacy.permittedCollectionFields,
      ),
    ),
  );
  return renderFollowUpTemplate(template, values, '', { channel: row.channel });
}

export const assistantFollowUps = {
  async processDue(limit = 50) {
    if (process.env.SUPPORT_ASSISTANTS_ENABLED !== "true") return 0;
    const profiles = assistantRolloutProfiles();
    if (profiles && !profiles.length) return 0;
    const rows = await withSystemScope(
      "Assistant follow-up ownership inventory",
      () =>
        db.execute(sql`SELECT id,user_id,business_profile_id,
      version,next_step,assistant_provenance FROM outreach_assistant_follow_up_schedules
      WHERE status IN ('active','queued') AND next_run_at<=NOW()
        ${profiles ? sql`AND business_profile_id IN (${sql.join(profiles.map(id => sql`${id}`), sql`, `)})` : sql``}
      ORDER BY next_run_at LIMIT ${Math.min(Math.max(limit, 1), 100)}`),
    );
    let processed = 0;
    for (const inventory of rows.rows as Row[]) {
      await withBusinessScope(
        {
          userId: Number(inventory.user_id),
          businessProfileId: Number(inventory.business_profile_id),
        },
        async () => {
          if (!assistantsRuntimeEnabled()) return;
          try {
            await withPublishedAssistant(
              inventory.assistant_provenance,
              async () => {
                const row = await eligible(
                  Number(inventory.id),
                  Number(inventory.version),
                  Number(inventory.next_step),
                );
                if (!row)
                  return stop(
                    Number(inventory.id),
                    Number(inventory.version),
                    "cancelled",
                    "conversation_no_longer_eligible",
                  );
                const open = nextAssistantOpen(
                  currentAssistant()!.configuration.availability,
                );
                if (!open)
                  return stop(
                    Number(row.id),
                    Number(row.version),
                    "stopped",
                    "invalid_availability",
                  );
                if (open > new Date()) {
                  await db.execute(
                    sql`UPDATE outreach_assistant_follow_up_schedules SET next_run_at=${open} WHERE id=${Number(row.id)} AND version=${Number(row.version)}`,
                  );
                  return;
                }
                const step = row.steps[Number(row.next_step)];
                if (!step)
                  return stop(
                    Number(row.id),
                    Number(row.version),
                    "stopped",
                    "invalid_follow_up_step",
                  );
                const action = await deliveryOutboxService.enqueue(
                  {
                    userId: Number(row.user_id),
                    conversationId: Number(row.conversation_id),
                    channel: row.channel,
                    idempotencyKey: `assistant-follow-up:${row.id}:${row.version}:${row.next_step}`,
                  },
                  {
                    text: step.messageMode === 'ai' ? '[AI assistant check-in pending delivery]' : '[Approved assistant follow-up template pending delivery]',
                    recipient: String(
                      row.channel === "email"
                        ? row.lead_email
                        : row.external_thread_id,
                    ),
                    phoneNumberId:
                      row.channel === "whatsapp"
                        ? currentAssistant()!.provenance.accountId
                        : undefined,
                    metadata: {
                      dispatchKind: "assistant_follow_up",
                      messageKind: "follow_up",
                      isAiGenerated: step.messageMode === 'ai',
                      followUpMessageMode: step.messageMode || 'template',
                      providerAccountId:
                        currentAssistant()!.provenance.accountId,
                      scheduleId: Number(row.id),
                      scheduleVersion: Number(row.version),
                      followUpStep: Number(row.next_step),
                      anchorMessageId: Number(row.anchor_message_id),
                      templateId: Number(step.templateId),
                    },
                  },
                );
                if (action.status === "uncertain")
                  return stop(
                    Number(row.id),
                    Number(row.version),
                    "uncertain",
                    "delivery_requires_reconciliation",
                  );
                if (
                  ["cancelled", "drafted"].includes(action.status) ||
                  (action.status === "failed" && !action.nextAttemptAt)
                ) {
                  return stop(
                    Number(row.id),
                    Number(row.version),
                    "stopped",
                    "delivery_no_longer_retryable",
                  );
                }
                await db.execute(sql`UPDATE outreach_assistant_follow_up_schedules SET status='queued',updated_at=NOW()
              WHERE id=${Number(row.id)} AND version=${Number(row.version)} AND status='active'`);
                await deliveryOutboxService.processAction(action.id);
                processed++;
              },
            );
          } catch (error) {
            await stop(
              Number(inventory.id),
              Number(inventory.version),
              "stopped",
              "assistant_or_template_unavailable",
            );
            logger.warn(
              {
                scheduleId: inventory.id,
                error: redactPiiWithStableTokens(
                  error instanceof Error ? error.message : "Follow-up stopped",
                ).redactedText,
              },
              "[AssistantFollowUps] Follow-up stopped safely",
            );
          }
        },
      );
    }
    return processed;
  },

  async dispatchClaimed(action: SupportDeliveryOutboxRecord) {
    const metadata = action.payload.metadata || {},
      scheduleId = Number(metadata.scheduleId),
      version = Number(metadata.scheduleVersion),
      step = Number(metadata.followUpStep);
    let dispatchStarted = false;
    try {
      let row = await eligible(scheduleId, version, step);
      if (
        !row ||
        Number(row.conversation_id) !== action.conversationId ||
        Number(row.user_id) !== action.userId ||
        row.channel !== action.channel ||
        !action.payload.recipient ||
        action.payload.recipient === "null" ||
        String(row.channel === 'email' ? row.lead_email : row.external_thread_id) !== action.payload.recipient
      )
        throw new Error("The follow-up anchor is no longer eligible.");
      const availability = currentAssistant()!.configuration.availability;
      if (!withinAssistantHours(availability)) {
        const open = nextAssistantOpen(availability);
        if (!open) throw new Error("No valid open availability range.");
        await db.execute(sql`UPDATE support_delivery_outbox SET status='failed',next_attempt_at=${open},lease_expires_at=NULL,
          last_error='Deferred outside assistant hours',updated_at=NOW() WHERE id=${action.id} AND status='sending' AND attempt_count=${action.attemptCount}`);
        await db.execute(
          sql`UPDATE outreach_assistant_follow_up_schedules SET next_run_at=${open} WHERE id=${scheduleId} AND version=${version}`,
        );
        return;
      }
      // Content-library templates and AI replies both require an open provider reply window.
      if (["whatsapp", "instagram", "facebook"].includes(action.channel)) {
        if (!assistantReplyWindowOpen(row.last_inbound_at))
          throw new Error(
            "The platform reply window is closed; an approved platform reopening mechanism is required.",
          );
      }
      const rendered = await renderForDelivery(row);
      let emailHtml: string | undefined;
      let deliveredSubject = rendered.subject;
      row = await eligible(scheduleId, version, step);
      if (!row)
        throw new Error(
          "A reply, opt-out or human takeover cancelled this follow-up.",
        );
      // Generation and queue delays can cross the boundary. Recheck immediately before the provider call.
      if (['whatsapp', 'instagram', 'facebook'].includes(action.channel) && !assistantReplyWindowOpen(row.last_inbound_at)) throw new Error('The platform reply window closed before delivery.');
      await assertAssistantFresh();
      let providerMessageId: string | null = null;
      const p = currentAssistant()!.provenance;
      if (action.channel === "whatsapp") {
        const { whatsappApiService } = await import("../whatsappApiService.js");
        if (!assistantReplyWindowOpen(row.last_inbound_at)) throw new Error('The WhatsApp reply window closed before delivery.');
        dispatchStarted = true;
        const sent = await whatsappApiService.sendText({
          userId: action.userId,
          to: action.payload.recipient,
          text: rendered.body,
          phoneNumberId: p.accountId,
        });
        providerMessageId = sent.messages?.[0]?.id || null;
      } else if (
        action.channel === "instagram" ||
        action.channel === "facebook"
      ) {
        dispatchStarted = true;
        const sent =
          action.channel === "instagram"
            ? await (
                await import("../instagramService.js")
              ).sendInstagramDM({
                userId: action.userId,
                conversationId: action.conversationId,
                messageId: 0,
                recipientId: action.payload.recipient,
                message: rendered.body,
                providerAccountId: p.accountId,
              })
            : await (
                await import("../FacebookMessengerService.js")
              ).sendFacebookDM({
                userId: action.userId,
                conversationId: action.conversationId,
                recipientId: action.payload.recipient,
                message: rendered.body,
                providerAccountId: p.accountId,
              });
        if (!sent.success)
          throw Object.assign(
            new Error("The platform did not confirm follow-up delivery."),
            { outcomeUncertain: sent.outcomeUnknown === true },
          );
        providerMessageId = sent.externalMessageId || null;
      } else if (action.channel === "email") {
        const sender = await db.execute(
          sql`SELECT id FROM email_senders WHERE user_id=${action.userId} AND email=${p.accountId} AND is_verified LIMIT 2`,
        );
        if (sender.rows.length !== 1)
          throw new Error("The original email account is no longer connected.");
        const { prepareDesignedEmail } = await import('../EmailDesignService.js');
        emailHtml = await prepareDesignedEmail(action.userId, rendered.html ||
          `<p>${rendered.body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>')}</p>`, 'assistant', undefined, row.brand_toolkit_id);
        deliveredSubject = rendered.subject || `Re: ${redactPiiWithStableTokens(String(row.subject || 'Your support enquiry')).redactedText}`;
        row = await eligible(scheduleId, version, step);
        if (!row || String(row.lead_email) !== action.payload.recipient)
          throw new Error('The email follow-up was cancelled or its recipient changed before delivery.');
        dispatchStarted = true;
        const { emailService } = await import("../emailService.js");
        const sent = await emailService.sendEmailWithUserCredentials(
          action.userId,
          {
            to: action.payload.recipient,
            subject: deliveredSubject,
            text: rendered.body,
            html: emailHtml,
            threadId: row.external_thread_id || undefined,
            inReplyTo: row.last_inbound_rfc_message_id || undefined,
            idempotencyKey: `assistant-follow-up:${scheduleId}:${version}:${step}`,
            skipConversationLog: true,
            isFollowUp: true,
            followUpStep: step + 1,
          },
          Number(sender.rows[0].id),
        );
        if (!sent.success)
          throw new Error(
            "The email provider did not confirm follow-up delivery.",
          );
        providerMessageId = sent.providerMessageId || sent.messageId || null;
      } else
        throw new Error(
          "This channel has no supported follow-up delivery mechanism.",
        );
      if (!providerMessageId)
        throw new Error("Follow-up delivery acknowledgement is missing.");
      // Store only the redacted delivery copy. Raw substitutions existed only at the provider boundary.
      const completed = {
        ...action,
        payload: {
          ...action.payload,
          text: redactPiiWithStableTokens(rendered.body).redactedText,
          subject: redactPiiWithStableTokens(deliveredSubject).redactedText,
          ...(emailHtml && row.steps[step]?.messageMode === 'ai'
            ? { metadata: { ...action.payload.metadata, emailHtml } } : {}),
        },
      };
      const nextStep = step + 1;
      const next = row.steps[nextStep];
      const nextAt = next
        ? nextAssistantOpen(
            availability,
            new Date(
              parseUtcDatabaseTimestamp(row.anchor_sent_at).getTime() +
                Number(next.delayMinutes) * 60000,
            ),
          )
        : null;
      await deliveryOutboxService.completeClaimedAction(
        completed,
        providerMessageId,
        async (tx) => {
          await tx.execute(sql`UPDATE outreach_assistant_follow_up_schedules SET status=${next && nextAt ? "active" : "completed"},
        next_step=${nextStep},next_run_at=COALESCE(${nextAt},next_run_at),updated_at=NOW()
        WHERE id=${scheduleId} AND version=${version} AND next_step=${step} AND status IN ('active','queued')`);
        },
      );
    } catch (error) {
      const uncertain =
        dispatchStarted &&
        (error as { outcomeUncertain?: boolean }).outcomeUncertain !== false;
      await deliveryOutboxService.markFailed(
        action.id,
        "Assistant follow-up stopped; delivery or authorization could not be confirmed.",
        uncertain,
        false,
      );
      await stop(
        scheduleId,
        version,
        uncertain ? "uncertain" : "stopped",
        uncertain
          ? "delivery_requires_reconciliation"
          : "authorization_or_template_unavailable",
      );
    }
  },
};
