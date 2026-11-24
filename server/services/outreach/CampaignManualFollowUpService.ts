import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { requireBusinessScope } from "../../tenancy/businessContext.js";
import {
  INBOX_CHANNELS,
  type InboxChannel,
} from "../../../shared/outreachInbox.js";
import type {
  ManualCampaignIdentity,
  ManualEnrollment,
  ManualSequence,
  ManualSequenceStep,
  ManualReview,
} from "../../../shared/campaignManualFollowUps.js";
import { manualSequenceStepsProblem } from "../../../shared/campaignManualFollowUps.js";
import { followUpSettingsRevision as checksum } from "../../utils/followUpSettingsRevision.js";
import {
  loadFollowUpTemplate,
  renderFollowUpTemplate,
} from "../followUpTemplateService.js";
import { issueTemplateRenderContext } from "../content/TemplateRenderContext.js";
import { templateRecipientFromLead } from "../content/ApprovedTemplateResolver.js";
import { LeadModel } from "../../models/leads/functions.js";
import { normalizeMSG91Phone } from "../../../shared/msg91.js";
import { parseUtcDatabaseTimestamp } from "../socialFollowUpService.js";

export class CampaignManualError extends Error {
  constructor(
    message: string,
    public status = 409,
    public code = "CAMPAIGN_MANUAL_REVIEW_REQUIRED",
  ) {
    super(message);
  }
}
type FrozenStep = ManualSequence["steps"][number] & {
  template: {
    content: string;
    subject: string | null;
    htmlContent: string | null;
  };
};
type Configuration = { mode: "manual" | "off"; steps: FrozenStep[] };
interface SequenceRecord {
  id: number;
  version: number;
  configuration: Configuration;
  checksum: string;
}
export function campaignIdentity(value: unknown): ManualCampaignIdentity {
  const item = value as ManualCampaignIdentity | undefined;
  if (
    !item ||
    !["chat_thread", "outreach_campaign"].includes(item.kind) ||
    !Number.isSafeInteger(item.id) ||
    item.id < 1
  )
    throw new CampaignManualError(
      "Select an explicit campaign before configuring or reviewing manual follow-ups.",
      400,
      "CAMPAIGN_REQUIRED",
    );
  return { kind: item.kind, id: item.id };
}
function scopeFor(userId: number) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId)
    throw new CampaignManualError(
      "Campaign ownership does not match this business.",
      403,
    );
  return scope;
}
function channelFor(value: unknown): InboxChannel {
  if (!INBOX_CHANNELS.includes(value as InboxChannel))
    throw new CampaignManualError("Choose a supported campaign channel.", 400);
  return value as InboxChannel;
}
function campaignColumn(campaign: ManualCampaignIdentity) {
  return sql.raw(
    campaign.kind === "chat_thread" ? "chat_thread_id" : "outreach_campaign_id",
  );
}
export async function assertManualCampaignOwner(
  userId: number,
  value: unknown,
  executor = db,
) {
  const campaign = campaignIdentity(value),
    scope = scopeFor(userId);
  const table = sql.raw(
    campaign.kind === "chat_thread" ? "chat_threads" : "outreach_campaigns",
  );
  const result =
    await executor.execute(sql`SELECT id FROM ${table} WHERE id=${campaign.id} AND user_id=${userId}
    AND business_profile_id=${scope.businessProfileId} ${campaign.kind === "chat_thread" ? sql`AND deleted_at IS NULL` : sql``} FOR SHARE`);
  if (!result.rows.length)
    throw new CampaignManualError(
      "This campaign is unavailable in the originating business.",
      404,
      "CAMPAIGN_NOT_FOUND",
    );
  return campaign;
}
async function record(
  userId: number,
  campaign: ManualCampaignIdentity,
  channel: InboxChannel,
  executor = db,
): Promise<SequenceRecord> {
  const scope = scopeFor(userId);
  const result =
    await executor.execute(sql`SELECT s.id,s.version,r.configuration,r.checksum FROM campaign_manual_sequences s
    JOIN campaign_manual_sequence_revisions r ON r.sequence_id=s.id AND r.version=s.version
    WHERE s.user_id=${userId} AND s.business_profile_id=${scope.businessProfileId} AND s.${campaignColumn(campaign)}=${campaign.id} AND s.channel=${channel}`);
  if (!result.rows[0])
    throw new CampaignManualError(
      "Save and review a manual sequence for this campaign and channel first.",
      404,
      "CAMPAIGN_SEQUENCE_REQUIRED",
    );
  return result.rows[0] as SequenceRecord;
}
function dto(
  campaign: ManualCampaignIdentity,
  channel: InboxChannel,
  row: SequenceRecord,
): ManualSequence {
  return {
    campaign,
    channel,
    version: row.version,
    mode: row.configuration.mode,
    steps: row.configuration.steps.map(
      ({ template: _template, ...step }) => step,
    ),
  };
}
export async function listManualCampaigns(userId: number) {
  const scope = scopeFor(userId);
  const result =
    await db.execute(sql`SELECT 'chat_thread' AS kind,id,COALESCE(title,'Campaign '||id) AS name FROM chat_threads
    WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND deleted_at IS NULL
    UNION ALL SELECT 'outreach_campaign' AS kind,id,name FROM outreach_campaigns
    WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} ORDER BY name,id`);
  return result.rows;
}
export async function createManualCampaign(userId: number, name: unknown) {
  const scope = scopeFor(userId);
  if (typeof name !== "string" || !name.trim() || name.trim().length > 255)
    throw new CampaignManualError(
      "Enter a campaign name of up to 255 characters.",
      400,
    );
  const result =
    await db.execute(sql`INSERT INTO chat_threads(user_id,business_profile_id,business_id,title,selected_agent)
    VALUES(${userId},${scope.businessProfileId},${scope.businessProfileId},${name.trim()},'outreach') RETURNING id,title AS name`);
  return { kind: "chat_thread", ...result.rows[0] };
}
export async function getManualSequence(
  userId: number,
  value: unknown,
  requestedChannel: unknown,
) {
  const campaign = await assertManualCampaignOwner(userId, value),
    channel = channelFor(requestedChannel);
  return dto(campaign, channel, await record(userId, campaign, channel));
}
export function validateManualSteps(
  mode: unknown,
  steps: unknown,
): asserts steps is ManualSequenceStep[] {
  const problem = manualSequenceStepsProblem(mode, steps);
  if (problem === "steps")
    throw new CampaignManualError(
      "Choose manual with one to three template steps, or off with no steps.",
      400,
    );
  if (problem)
    throw new CampaignManualError(
      "Select approved templates and increasing times within 90 days of the initial message.",
      400,
    );
}
export async function saveManualSequence(
  userId: number,
  input: {
    campaign: unknown;
    channel: unknown;
    expectedVersion: unknown;
    mode: unknown;
    steps: unknown;
    copyGlobalPreset?: boolean;
  },
) {
  const campaign = await assertManualCampaignOwner(userId, input.campaign),
    channel = channelFor(input.channel),
    scope = scopeFor(userId);
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    Number(input.expectedVersion) < 0
  )
    throw new CampaignManualError(
      "Supply the sequence version you edited.",
      400,
    );
  let steps = input.steps;
  // A global preset is only a one-time explicit copy, never a delivery fallback.
  if (input.copyGlobalPreset === true) {
    const settings = await db.execute(
      sql`SELECT channel_follow_ups->${channel} AS config FROM outreach_settings WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId}`,
    );
    steps = (settings.rows[0]?.config?.followUps || [])
      .filter((step: { enabled?: boolean }) => step.enabled)
      .map(
        (step: {
          delayMinutes?: number;
          delayHours?: number;
          delayDays?: number;
          templateId: number;
        }) => ({
          delayMinutes:
            (Number(step.delayMinutes) || 0) +
            (Number(step.delayHours) || 0) * 60 +
            (Number(step.delayDays) || 0) * 1440,
          templateId: Number(step.templateId),
        }),
      );
  }
  validateManualSteps(input.mode, steps);
  const configuration: Configuration = {
    mode: input.mode as Configuration["mode"],
    steps: [],
  };
  for (const step of steps) {
    const { template } = await loadFollowUpTemplate(
      userId,
      channel,
      step.templateId,
    );
    if (template.businessProfileId !== scope.businessProfileId)
      throw new CampaignManualError(
        "The template belongs to another business.",
        403,
      );
    configuration.steps.push({
      ...step,
      templateVersion: template.version,
      templateName: template.name,
      template: {
        content: template.content,
        subject: template.subject,
        htmlContent: template.htmlContent,
      },
    });
  }
  return db.transaction(async (tx: typeof db) => {
    await assertManualCampaignOwner(userId, campaign, tx);
    // Serialize initial creation as well as updates without global/process locks.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope.businessProfileId}:${campaign.kind}:${campaign.id}:${channel}`},0))`,
    );
    const current =
      await tx.execute(sql`SELECT id,version FROM campaign_manual_sequences WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId}
      AND ${campaignColumn(campaign)}=${campaign.id} AND channel=${channel} FOR UPDATE`);
    const existing = current.rows[0];
    if (Number(existing?.version || 0) !== input.expectedVersion)
      throw new CampaignManualError(
        "This campaign sequence changed. Reload and review the current revision.",
        409,
        "CAMPAIGN_SEQUENCE_CONFLICT",
      );
    const version = Number(input.expectedVersion) + 1;
    const saved = existing
      ? await tx.execute(
          sql`UPDATE campaign_manual_sequences SET version=${version},updated_at=now() WHERE id=${existing.id} RETURNING id`,
        )
      : await tx.execute(sql`INSERT INTO campaign_manual_sequences(user_id,business_profile_id,chat_thread_id,outreach_campaign_id,channel,version)
        VALUES(${userId},${scope.businessProfileId},${campaign.kind === "chat_thread" ? campaign.id : null},${campaign.kind === "outreach_campaign" ? campaign.id : null},${channel},${version}) RETURNING id`);
    const id = saved.rows[0].id;
    await tx.execute(sql`INSERT INTO campaign_manual_sequence_revisions(user_id,business_profile_id,sequence_id,version,configuration,checksum)
      VALUES(${userId},${scope.businessProfileId},${id},${version},${JSON.stringify(configuration)}::jsonb,${checksum(configuration)})`);
    return dto(campaign, channel, {
      id,
      version,
      configuration,
      checksum: checksum(configuration),
    });
  });
}
async function assertTemplates(
  userId: number,
  channel: InboxChannel,
  config: Configuration,
) {
  const scope = scopeFor(userId);
  for (const step of config.steps) {
    const { template } = await loadFollowUpTemplate(
      userId,
      channel,
      step.templateId,
    );
    if (template.businessProfileId !== scope.businessProfileId)
      throw new CampaignManualError(
        "The template belongs to another business.",
        403,
      );
    if (
      template.version !== step.templateVersion ||
      checksum({
        content: template.content,
        subject: template.subject,
        htmlContent: template.htmlContent,
      }) !== checksum(step.template)
    )
      throw new CampaignManualError(
        "An approved template changed. Save a new campaign revision and review it; pending content is held, never replaced.",
      );
  }
}
export async function previewManualSequence(
  userId: number,
  input: {
    campaign: unknown;
    channel: unknown;
    expectedVersion: unknown;
    recipients: Array<{ leadId: number; subject?: string; recipient?: string }>;
  },
  originReview?: {
    originId: number;
    previousReviewId: string;
    deliveryChecksum: string;
  },
): Promise<ManualReview> {
  const campaign = await assertManualCampaignOwner(userId, input.campaign),
    channel = channelFor(input.channel),
    scope = scopeFor(userId);
  const row = await record(userId, campaign, channel);
  if (row.version !== input.expectedVersion)
    throw new CampaignManualError(
      "Reload and review the latest saved campaign sequence.",
      409,
      "CAMPAIGN_SEQUENCE_CONFLICT",
    );
  if (
    !Array.isArray(input.recipients) ||
    !input.recipients.length ||
    new Set(input.recipients.map((item) => item.leadId)).size !==
      input.recipients.length
  )
    throw new CampaignManualError(
      "Choose at least one distinct recipient to preview.",
      400,
    );
  await assertTemplates(userId, channel, row.configuration);
  const recipients: ManualReview["recipients"] = {};
  for (const item of input.recipients) {
    if (!Number.isSafeInteger(item.leadId) || item.leadId < 1)
      throw new CampaignManualError("Choose a valid recipient.", 400);
    const lead = await LeadModel.findByIdForUser(item.leadId, userId);
    if (!lead || lead.deletedAt)
      throw new CampaignManualError(
        "A campaign recipient is unavailable.",
        404,
      );
    const recipient = templateRecipientFromLead(lead, channel);
    const values = {
      first_name: recipient.firstName,
      last_name: recipient.lastName,
      full_name: recipient.fullName,
      company_name: recipient.company,
      email: recipient.email,
      phone: recipient.phone,
      job_title: recipient.job_title,
      department: recipient.department,
      company_industry: recipient.company_industry,
      company_size: recipient.company_size,
      company_website: recipient.company_website,
      company_location: recipient.company_location,
    };
    const steps: ManualEnrollment["steps"] = [];
    for (const step of row.configuration.steps) {
      const { context } = await loadFollowUpTemplate(
        userId,
        channel,
        step.templateId,
      );
      const business = context.businessProfile;
      const clock = issueTemplateRenderContext(
        userId,
        step.templateId,
        step.templateVersion,
        business.timezone || "Asia/Kolkata",
      );
      const rendered = renderFollowUpTemplate(
        step.template,
        {
          ...values,
          your_company_name: business.companyName || business.businessName,
          your_website: business.website,
          your_industry: business.industry,
          value_proposition: business.valueProposition,
          target_audience: business.targetMarket,
        },
        item.subject || "",
        { now: new Date(clock.renderedAt), timeZone: clock.timeZone, channel },
      );
      steps.push({
        delayMinutes: step.delayMinutes,
        message: rendered.body,
        subject: rendered.subject || undefined,
        htmlContent: rendered.html || undefined,
        sourceTemplateId: step.templateId,
        sourceTemplateVersion: step.templateVersion,
      });
    }
    const destination =
      item.recipient ||
      (channel === "email"
        ? recipient.email
        : channel === "sms"
          ? normalizeMSG91Phone(recipient.phone)
          : channel === "whatsapp"
            ? recipient.phone.replace(/[^0-9]/g, "")
            : channel === "instagram"
              ? lead.instagramHandle || lead.instagram
              : lead.facebook);
    recipients[String(item.leadId)] = {
      recipient: String(destination || ""),
      steps,
    };
  }
  const reviewId = randomUUID();
  const snapshot = {
    campaign,
    channel,
    sequenceChecksum: row.checksum,
    recipients,
    originIds: originReview ? [originReview.originId] : [],
    originReview,
  };
  await db.execute(sql`INSERT INTO campaign_manual_reviews(id,user_id,business_profile_id,sequence_id,sequence_version,snapshot,expires_at)
    VALUES(${reviewId},${userId},${scope.businessProfileId},${row.id},${row.version},${JSON.stringify(snapshot)}::jsonb,now()+interval '1 hour')`);
  return { reviewId, sequence: dto(campaign, channel, row), recipients };
}
export async function enrollManualReview(
  userId: number,
  requestedChannel: unknown,
  reviewId: unknown,
  leadId: number,
  recipient: string,
): Promise<ManualEnrollment> {
  const scope = scopeFor(userId),
    channel = channelFor(requestedChannel);
  if (typeof reviewId !== "string" || !/^[0-9a-f-]{36}$/i.test(reviewId))
    throw new CampaignManualError(
      "Preview and review this campaign sequence before sending.",
    );
  const result =
    await db.execute(sql`SELECT r.snapshot,r.sequence_version,s.version,c.configuration,c.checksum FROM campaign_manual_reviews r
    JOIN campaign_manual_sequences s ON s.id=r.sequence_id JOIN campaign_manual_sequence_revisions c ON c.sequence_id=s.id AND c.version=r.sequence_version
    WHERE r.id=${reviewId} AND r.user_id=${userId} AND r.business_profile_id=${scope.businessProfileId} AND r.expires_at>now()`);
  const row = result.rows[0];
  if (!row || row.version !== row.sequence_version)
    throw new CampaignManualError(
      "The campaign review expired or its sequence changed. Preview and review again.",
      409,
      "CAMPAIGN_SEQUENCE_CONFLICT",
    );
  const snapshot = row.snapshot;
  await assertManualCampaignOwner(userId, snapshot.campaign);
  const selected = snapshot.recipients?.[String(leadId)];
  if (
    snapshot.channel !== channel ||
    !selected ||
    !recipient ||
    selected.recipient !== recipient
  )
    throw new CampaignManualError(
      "The campaign review does not match this recipient and channel.",
    );
  await assertTemplates(userId, channel, row.configuration);
  return {
    version: 1,
    campaign: snapshot.campaign,
    channel,
    sequenceVersion: row.sequence_version,
    sequenceChecksum: row.checksum,
    reviewId,
    userId,
    leadId,
    businessProfileId: scope.businessProfileId,
    recipient,
    steps: selected.steps,
  };
}
/** Dispatch validates the pinned revision; the latest sequence is never substituted. */
export async function assertManualEnrollment(
  userId: number,
  enrollment: ManualEnrollment,
) {
  const scope = scopeFor(userId);
  if (
    enrollment.version !== 1 ||
    enrollment.userId !== userId ||
    enrollment.businessProfileId !== scope.businessProfileId
  )
    throw new CampaignManualError(
      "The manual enrollment has no verifiable originating business.",
    );
  const campaign = await assertManualCampaignOwner(userId, enrollment.campaign),
    channel = channelFor(enrollment.channel);
  const result =
    await db.execute(sql`SELECT r.configuration,r.checksum FROM campaign_manual_sequences s JOIN campaign_manual_sequence_revisions r ON r.sequence_id=s.id
    WHERE s.user_id=${userId} AND s.business_profile_id=${scope.businessProfileId} AND s.${campaignColumn(campaign)}=${campaign.id}
      AND s.channel=${channel} AND r.version=${enrollment.sequenceVersion}`);
  const row = result.rows[0];
  if (!row || row.checksum !== enrollment.sequenceChecksum)
    throw new CampaignManualError(
      "The pinned campaign sequence is unavailable. Owner review is required.",
    );
  const review = await db.execute(
    sql`SELECT snapshot FROM campaign_manual_reviews WHERE id=${enrollment.reviewId} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId}`,
  );
  const snapshot = review.rows[0]?.snapshot;
  const approved = snapshot?.recipients?.[String(enrollment.leadId)];
  if (
    !approved ||
    approved.recipient !== enrollment.recipient ||
    checksum(approved.steps) !== checksum(enrollment.steps) ||
    checksum(snapshot.campaign) !== checksum(campaign) ||
    snapshot.sequenceChecksum !== row.checksum ||
    snapshot.channel !== channel
  )
    throw new CampaignManualError(
      "The manual sequence no longer matches its immutable recipient review.",
    );
  await assertTemplates(userId, channel, row.configuration);
}
/** Atomic admission point: a concurrent campaign edit cannot admit a stale review. */
export async function admitManualOrigin(
  userId: number,
  originId: number,
  enrollment: ManualEnrollment,
) {
  const scope = scopeFor(userId);
  const result =
    await db.execute(sql`UPDATE outreach_messages m SET metadata=jsonb_set(m.metadata,'{outreachCreation,campaignManualAdmitted}','true'::jsonb)
    FROM campaign_manual_sequences s WHERE m.id=${originId} AND m.user_id=${userId} AND m.business_profile_id=${scope.businessProfileId}
      AND m.status='pending' AND m.provider_call_state='not_started'
      AND s.user_id=${userId} AND s.business_profile_id=${scope.businessProfileId} AND s.${campaignColumn(enrollment.campaign)}=${enrollment.campaign.id}
      AND s.channel=${enrollment.channel} AND s.version=${enrollment.sequenceVersion}
      AND m.metadata->'outreachCreation'->'campaignManual'->>'reviewId'=${enrollment.reviewId} RETURNING m.id`);
  if (result.rows.length !== 1)
    throw new CampaignManualError(
      "The campaign changed before enrollment was admitted. Review its current sequence again.",
      409,
      "CAMPAIGN_SEQUENCE_CONFLICT",
    );
}

/** Only an explicitly reviewed set of safe, unsent enrollments may change revision. */
export async function previewPendingManualEnrollments(
  userId: number,
  input: { campaign: unknown; channel: unknown; expectedVersion: unknown },
) {
  const campaign = await assertManualCampaignOwner(userId, input.campaign),
    channel = channelFor(input.channel),
    scope = scopeFor(userId);
  const rows =
    await db.execute(sql`SELECT m.id,m.metadata,m.status,m.provider_call_state,c.lead_id FROM outreach_messages m
    JOIN outreach_conversations c ON c.id=m.conversation_id
    WHERE m.user_id=${userId} AND m.business_profile_id=${scope.businessProfileId} AND m.message_kind='outreach'
      AND m.metadata->'outreachCreation'->'campaignManual'->'campaign'=${JSON.stringify(campaign)}::jsonb
      AND m.metadata->'outreachCreation'->'campaignManual'->>'channel'=${channel}
      AND m.follow_up_cancelled_at IS NULL AND m.status IN ('pending','sent','delivered','read')
      AND m.manual_review_required=false
      AND (m.status='pending' OR m.metadata->'outreachCreation'->>'followUpsActivated'='true')
      AND NOT EXISTS(SELECT 1 FROM outreach_messages child WHERE child.follow_up_origin_message_id=m.id
        AND ((child.status<>'pending' AND NOT(child.status='cancelled' AND child.error_message='Removed by explicitly reviewed campaign revision'))
          OR child.provider_call_state<>'not_started' OR child.manual_review_required))
      AND NOT EXISTS(SELECT 1 FROM outreach_messages reply WHERE reply.conversation_id=m.conversation_id AND reply.direction='inbound'
        AND reply.created_at>COALESCE(m.sent_at,m.created_at))
      AND c.session_ended_at IS NULL AND c.automation_mode NOT IN ('human_owned','approval_pending','resolved','closed','opted_out') ORDER BY m.id LIMIT 100`);
  const items = [];
  for (const row of rows.rows) {
    const creation = row.metadata.outreachCreation,
      enrollment = creation.campaignManual as ManualEnrollment;
    const preview = await previewManualSequence(
      userId,
      {
        ...input,
        recipients: [
          {
            leadId: Number(row.lead_id),
            recipient: enrollment.recipient,
            subject: creation.delivery.subject,
          },
        ],
      },
      {
        originId: Number(row.id),
        previousReviewId: enrollment.reviewId,
        deliveryChecksum: checksum(creation.delivery),
      },
    );
    items.push({
      originId: Number(row.id),
      previousVersion: enrollment.sequenceVersion,
      previousReviewId: enrollment.reviewId,
      ...preview,
    });
  }
  return { items };
}
export async function applyPendingManualEnrollment(
  userId: number,
  input: { originId: number; reviewId: string; previousReviewId: string },
) {
  const scope = scopeFor(userId);
  if (!Number.isSafeInteger(input.originId) || input.originId < 1)
    throw new CampaignManualError("Select a reviewed pending enrollment.", 400);
  const origin =
    await db.execute(sql`SELECT m.*,c.lead_id FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id
    WHERE m.id=${input.originId} AND m.user_id=${userId} AND m.business_profile_id=${scope.businessProfileId}`);
  const row = origin.rows[0],
    old = row?.metadata?.outreachCreation;
  if (!old?.campaignManual)
    throw new CampaignManualError(
      "The original campaign enrollment is unavailable.",
    );
  if (old.campaignManual.reviewId === input.reviewId)
    return { applied: true, duplicate: true };
  const review = await db.execute(
    sql`SELECT snapshot FROM campaign_manual_reviews WHERE id=${input.reviewId} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId}`,
  );
  if (
    JSON.stringify(review.rows[0]?.snapshot?.originIds) !==
    JSON.stringify([input.originId])
  )
    throw new CampaignManualError(
      "Preview this exact pending enrollment before applying a revision.",
    );
  const reviewedOrigin = review.rows[0].snapshot.originReview;
  if (
    reviewedOrigin?.previousReviewId !== input.previousReviewId ||
    reviewedOrigin.deliveryChecksum !== checksum(old.delivery)
  )
    throw new CampaignManualError(
      "The original enrollment changed after preview. Review it again.",
    );
  const next = await enrollManualReview(
    userId,
    old.delivery.channel,
    input.reviewId,
    Number(row.lead_id),
    old.campaignManual.recipient,
  );
  if (checksum(next.campaign) !== checksum(old.campaignManual.campaign))
    throw new CampaignManualError(
      "Pending enrollments cannot move to another campaign.",
    );
  // Assignment/runtime must be ready at re-admission; a held job cannot borrow new setup.
  const { admitCustomerDeliveryJob } =
    await import("../assistants/CustomerDeliveryJobs.js");
  await admitCustomerDeliveryJob("send_outreach_message", {
    ...old.delivery,
    userId,
    businessProfileId: scope.businessProfileId,
  });
  return db.transaction(async (tx: typeof db) => {
    const latest =
      await tx.execute(sql`SELECT version FROM campaign_manual_sequences WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId}
      AND ${campaignColumn(next.campaign)}=${next.campaign.id} AND channel=${next.channel} FOR SHARE`);
    if (latest.rows[0]?.version !== next.sequenceVersion)
      throw new CampaignManualError(
        "The campaign changed before applying this review.",
        409,
        "CAMPAIGN_SEQUENCE_CONFLICT",
      );
    const locked = await tx.execute(
      sql`SELECT m.* FROM outreach_messages m WHERE m.id=${input.originId} AND m.user_id=${userId} AND m.business_profile_id=${scope.businessProfileId} FOR UPDATE`,
    );
    const current = locked.rows[0],
      creation = current?.metadata?.outreachCreation;
    if (creation?.campaignManual?.reviewId === input.reviewId)
      return { applied: true, duplicate: true };
    if (
      !creation ||
      creation.campaignManual?.reviewId !== input.previousReviewId ||
      checksum(creation.delivery) !== reviewedOrigin.deliveryChecksum ||
      current.follow_up_cancelled_at ||
      current.manual_review_required ||
      !["pending", "sent", "delivered", "read"].includes(current.status) ||
      (current.status === "pending" &&
        current.provider_call_state !== "not_started") ||
      (current.status !== "pending" && creation.followUpsActivated !== true)
    )
      throw new CampaignManualError(
        "The pending enrollment changed or is processing. Reload and review it again.",
      );
    const children = await tx.execute(
      sql`SELECT * FROM outreach_messages WHERE follow_up_origin_message_id=${input.originId} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} FOR UPDATE`,
    );
    if (
      children.rows.some(
        (child: any) =>
          (child.status !== "pending" &&
            !(
              child.status === "cancelled" &&
              child.error_message ===
                "Removed by explicitly reviewed campaign revision"
            )) ||
          child.provider_call_state !== "not_started" ||
          child.manual_review_required ||
          child.provider_message_id ||
          child.external_message_id,
      )
    )
      throw new CampaignManualError(
        "This enrollment includes sent, claimed, held, or uncertain work and cannot be revised automatically.",
      );
    const stop =
      await tx.execute(sql`SELECT 1 FROM outreach_conversations c WHERE c.id=${current.conversation_id}
      AND c.session_ended_at IS NULL AND c.automation_mode NOT IN ('human_owned','approval_pending','resolved','closed','opted_out')
      AND NOT EXISTS(SELECT 1 FROM outreach_messages reply WHERE reply.conversation_id=c.id AND reply.direction='inbound' AND reply.created_at>COALESCE(${current.sent_at},${current.created_at})::timestamp)`);
    if (!stop.rows.length)
      throw new CampaignManualError(
        "The contact replied or automation was stopped.",
      );
    for (const child of children.rows) {
      const step = next.steps[Number(child.follow_up_step) - 1];
      if (!step) {
        await tx.execute(
          sql`UPDATE outreach_messages SET status='cancelled',error_message='Removed by explicitly reviewed campaign revision',updated_at=now() WHERE id=${child.id}`,
        );
        continue;
      }
      const delivery = {
        ...creation.delivery,
        message: step.message,
        subject: step.subject || creation.delivery.subject,
        templateName: step.templateName,
        templateLanguage: step.templateLanguage,
        templateComponents: step.templateComponents,
        templateDefinitionHash: step.templateDefinitionHash,
        campaignManualReviewId: next.reviewId,
      };
      const dueAt = new Date(
        parseUtcDatabaseTimestamp(
          current.sent_at || current.created_at,
        ).getTime() +
          step.delayMinutes * 60000,
      );
      const metadata = {
        ...child.metadata,
        scheduledAt: dueAt.toISOString(),
        outreachCreation: {
          version: 1,
          delivery,
          followUps: [],
          followUpSource: "campaign_manual",
          campaignManual: next,
          whatsappOptInConfirmed: creation.whatsappOptInConfirmed,
        },
      };
      await tx.execute(sql`UPDATE outreach_messages SET status='pending',content=${step.message},subject=${delivery.subject || null},html_content=${step.htmlContent || null},
        send_intent_id=${randomUUID()},confirmation_expires_at=${new Date(Math.max(dueAt.getTime(), Date.now()) + 3600000)},metadata=${JSON.stringify(metadata)}::jsonb,error_message=NULL,updated_at=now() WHERE id=${child.id}`);
    }
    const metadata = {
      ...current.metadata,
      outreachCreation: {
        ...creation,
        delivery: {
          ...creation.delivery,
          campaignManualReviewId: next.reviewId,
        },
        followUps: next.steps,
        campaignManual: next,
        followUpsActivated: false,
        campaignManualRequeue: current.status === "pending",
      },
    };
    await tx.execute(sql`UPDATE outreach_messages SET metadata=${JSON.stringify(metadata)}::jsonb,
      send_intent_id=CASE WHEN status='pending' THEN ${randomUUID()}::uuid ELSE send_intent_id END,updated_at=now() WHERE id=${input.originId}`);
    return { applied: true, duplicate: false };
  });
}
