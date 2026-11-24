import type { FollowUpProvenance } from "../../../shared/followUpProvenance.js";
import { verifyTemplateRenderContext } from "../content/TemplateRenderContext.js";
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { requireBusinessScope } from "../../tenancy/businessContext.js";
import type { FollowUpChannel } from "../../../shared/followUpChannels.js";
import { FOLLOW_UP_CHANNELS } from "../../../shared/followUpChannels.js";
import { followUpSettingsRevision } from "../../utils/followUpSettingsRevision.js";
import { ContentBrandContextError } from "../content/ContentBrandContextService.js";
import {
  loadFollowUpTemplate,
  FollowUpTemplateError,
} from "../followUpTemplateService.js";
import { captureJobBusiness, type JobBusinessPayload } from "../../tenancy/jobBusinessScope.js";
import { BillingOrganizationError } from "../billing/organizations.js";
import { logger } from "../../utils/logger.js";
import { admitCustomerDeliveryJob, runCustomerDeliveryJob } from '../assistants/CustomerDeliveryJobs.js';
import { deliverySetupFailure } from '../assistants/CustomerDeliveryGate.js';

export class ConfiguredFollowUpStoppedError extends Error {}

export interface ConfiguredFollowUpDispatch {
  version: 1;
  state: "pending" | "dispatched" | "cancelled" | "review_required";
  /** Stable authority failure code; does not authorize a replay. */
  reviewReason?: string;
  channel: FollowUpChannel;
  jobId: string;
  payload: Record<string, unknown> & JobBusinessPayload & { userId: number };
}
export async function configuredFollowUpDispatch(
  channel: FollowUpChannel,
  originId: number,
  step: number,
  payload: ConfiguredFollowUpDispatch["payload"],
): Promise<ConfiguredFollowUpDispatch> {
  const scope = requireBusinessScope();
  if (
    payload.userId !== scope.userId ||
    !Number.isSafeInteger(originId) ||
    originId < 1 ||
    !Number.isSafeInteger(step) ||
    step < 1
  )
    throw new Error("Invalid configured follow-up dispatch scope.");
  // Resolve authority at intent creation, before a reservation persists it.
  // Recovery must never reconstruct these fields from its inventory owner.
  const name = channel === 'email' ? 'send_follow_up_email' : channel === 'sms' ? 'send_follow_up_sms' : 'send_follow_up_social';
  const originating = await admitCustomerDeliveryJob(name, await captureJobBusiness({ ...payload, channel, businessProfileId: scope.businessProfileId }));
  return {
    version: 1,
    state: "pending",
    channel,
    jobId: `configured-follow-up-${scope.businessProfileId}-${scope.userId}-${channel}-${originId}-${step}`,
    payload: {
      ...originating,
      businessProfileId: scope.businessProfileId,
      followUpOriginMessageId: originId,
      followUpStep: step,
    },
  };
}

/** Final delivery preflight contract: run after preparation, then the channel's final claim. */
export async function assertConfiguredFollowUpReady(
  userId: number,
  channel: FollowUpChannel,
  provenance?: FollowUpProvenance,
  expected?: { originMessageId: number; step: number },
): Promise<void> {
  const scope = requireBusinessScope();
  if (scope.userId !== userId)
    throw new Error("Invalid follow-up business scope.");
  if (provenance?.templateId !== undefined)
    throw new ConfiguredFollowUpStoppedError('Manual follow-ups require an immutable campaign sequence and recipient review. Review this legacy schedule; global templates cannot authorize it.');
  const result =
    await db.execute(sql`SELECT enable_auto_follow_up,channel_follow_ups FROM outreach_settings
    WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId}`);
  const settings = result.rows[0];
  const config = settings?.channel_follow_ups?.[channel];
  if (!settings?.enable_auto_follow_up || !config?.enabled)
    throw new ConfiguredFollowUpStoppedError(
      "Automatic follow-ups are disabled for this channel.",
    );
  if (!provenance)
    throw new ConfiguredFollowUpStoppedError(
      "Follow-up approval metadata is unavailable. Review the pending sequence.",
    );
  if (
    provenance.version !== 1 ||
    provenance.userId !== userId ||
    provenance.businessProfileId !== scope.businessProfileId ||
    provenance.originTable !==
      (channel === "sms" ? "sent_messages" : "outreach_messages") ||
    !Number.isSafeInteger(provenance.originMessageId) ||
    provenance.originMessageId < 1 ||
    !Number.isSafeInteger(provenance.step) ||
    provenance.step < 1 ||
    (expected &&
      (expected.originMessageId !== provenance.originMessageId ||
        expected.step !== provenance.step))
  )
    throw new ConfiguredFollowUpStoppedError(
      "Follow-up provenance no longer matches its durable origin and business. Review it again.",
    );
  if (
    provenance.channel !== channel ||
    provenance.settingsRevision !== followUpSettingsRevision(config)
  )
    throw new ConfiguredFollowUpStoppedError(
      "Follow-up settings changed after this delivery was prepared. Review the pending sequence.",
    );
  const selectedStep = Array.isArray(config.followUps)
    ? config.followUps.filter((step: { enabled?: boolean }) => step?.enabled)[
        provenance.step - 1
      ]
    : undefined;
  if (!selectedStep)
    throw new ConfiguredFollowUpStoppedError(
      "This follow-up step is no longer enabled. Review the sequence.",
    );
  const selectedTemplateId =
    Number(selectedStep.templateId) > 0
      ? Number(selectedStep.templateId)
      : undefined;
  if (
    provenance.templateId !== selectedTemplateId ||
    (provenance.templateId === undefined &&
      provenance.templateVersion !== undefined)
  )
    throw new ConfiguredFollowUpStoppedError(
      "The selected follow-up template changed or its provenance is missing. Review it again.",
    );
  if (provenance.templateId !== undefined) {
    try {
      const { template } = await loadFollowUpTemplate(
        userId,
        channel,
        provenance.templateId,
      );
      if (provenance.templateRenderContext) {
        try {
          verifyTemplateRenderContext(
            userId,
            provenance.templateId,
            provenance.templateVersion!,
            provenance.templateRenderContext,
          );
        } catch {
          throw new ConfiguredFollowUpStoppedError(
            "The follow-up rendering context changed. Review it again.",
          );
        }
      }
      if (template.version !== provenance.templateVersion)
        throw new ConfiguredFollowUpStoppedError(
          "The follow-up template changed after preparation. Review it again.",
        );
    } catch (error) {
      if (
        error instanceof FollowUpTemplateError ||
        error instanceof ContentBrandContextError
      )
        throw new ConfiguredFollowUpStoppedError(error.message);
      throw error;
    }
  }
}

/** The SMS counter and pending dispatch are written together, before any queue I/O. */
export async function reserveSmsFollowUpDispatch(
  originId: number,
  expectedStep: number | null,
  step: number,
  dispatch: ConfiguredFollowUpDispatch,
): Promise<boolean> {
  const scope = requireBusinessScope();
  const result = await db.execute(sql`UPDATE sent_messages
    SET follow_up_step=${step},follow_up_dispatches=jsonb_set(COALESCE(follow_up_dispatches,'{}'::jsonb),
      ARRAY[${String(step)}]::text[],${JSON.stringify(dispatch)}::jsonb),updated_at=NOW()
    WHERE id=${originId} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
      AND channel='sms' AND is_reply=false AND COALESCE(follow_up_step,0)=${expectedStep || 0}
    RETURNING id`);
  return result.rows.length === 1;
}

/** Queue acknowledgement is deliberately separate from reservation. A rejected/unknown enqueue
 * retains the original envelope. Persistent BullMQ IDs deduplicate a lost acknowledgement. */
export async function recoverConfiguredFollowUpDispatches(
  limit = 100,
): Promise<number> {
  const scope = requireBusinessScope();
  const rows = await db.execute(sql`
    SELECT 'outreach' AS source,id,metadata->'configuredFollowUpDispatch' AS dispatch,NULL::text AS step
    FROM outreach_messages WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
      AND metadata->'configuredFollowUpDispatch'->>'state'='pending'
      AND status IN ('queued','pending')
    UNION ALL
    SELECT 'sms' AS source,message.id,entry.value AS dispatch,entry.key AS step
    FROM sent_messages message CROSS JOIN LATERAL jsonb_each(message.follow_up_dispatches) entry
    WHERE message.user_id=${scope.userId} AND message.business_profile_id=${scope.businessProfileId}
      AND entry.value->>'state'='pending'
    LIMIT ${Math.min(100, Math.max(1, limit))}`);
  let dispatched = 0;
  for (const row of rows.rows) {
    const dispatch = row.dispatch as ConfiguredFollowUpDispatch;
    if (
      dispatch?.version !== 1 ||
      !FOLLOW_UP_CHANNELS.includes(dispatch.channel) ||
      (dispatch.payload?.userId !== undefined && dispatch.payload.userId !== scope.userId) ||
      (dispatch.payload?.businessProfileId !== undefined && dispatch.payload.businessProfileId !== scope.businessProfileId) ||
      !dispatch.jobId?.startsWith(
        `configured-follow-up-${scope.businessProfileId}-${scope.userId}-`,
      )
    ) {
      logger.error(
        { id: row.id },
        "Invalid configured follow-up dispatch requires review",
      );
      continue;
    }
    let state: "dispatched" | "cancelled" | "review_required" = "dispatched";
    let reviewReason: string | undefined;
    try {
      await captureJobBusiness(dispatch.payload ?? {}, { requireOriginatingIdentity: true });
      const name = dispatch.channel === 'email' ? 'send_follow_up_email' : dispatch.channel === 'sms' ? 'send_follow_up_sms' : 'send_follow_up_social';
      await runCustomerDeliveryJob(name, dispatch.payload, async () => undefined);
      await assertConfiguredFollowUpReady(
        scope.userId,
        dispatch.channel,
        dispatch.payload.followUpProvenance as FollowUpProvenance | undefined,
        {
          originMessageId: Number(dispatch.payload.followUpOriginMessageId),
          step: Number(dispatch.payload.followUpStep),
        },
      );
    } catch (error) {
      // Approval/settings failures must remain visible and unsent. Transient DB
      // failures leave the envelope pending for the next recovery sweep.
      const setup = deliverySetupFailure(error);
      if (setup) {
        state = 'review_required';
        reviewReason = `${setup.code}:${setup.reason}`;
      } else if (error instanceof BillingOrganizationError) {
        state = "review_required";
        reviewReason = error.code;
      } else if (error instanceof ConfiguredFollowUpStoppedError) state = "cancelled";
      else {
        logger.warn(
          { err: error, id: row.id },
          "Follow-up authorization could not be checked; dispatch remains pending",
        );
        continue;
      }
    }
    try {
      if (state === "dispatched") {
        const { queueRegistry, QUEUE_NAMES } =
          await import("../../queues/index.js");
        const queue =
          dispatch.channel === "email"
            ? QUEUE_NAMES.EMAIL_SENDING
            : dispatch.channel === "sms"
              ? QUEUE_NAMES.SMS_SENDING
              : QUEUE_NAMES.OUTREACH;
        const name =
          dispatch.channel === "email"
            ? "send_follow_up_email"
            : dispatch.channel === "sms"
              ? "send_follow_up_sms"
              : "send_follow_up_social";
        const payload = {
          ...dispatch.payload,
          createdAt: String(
            dispatch.payload.createdAt || new Date().toISOString(),
          ),
          ...(row.source === "outreach"
            ? dispatch.channel === "email"
              ? { followUpMessageId: Number(row.id) }
              : { socialFollowUpMessageId: Number(row.id) }
            : {}),
        };
        await queueRegistry.addJob(queue, name, payload, {
          jobId: dispatch.jobId,
          removeOnComplete: false,
          removeOnFail: false,
        });
      }
      if (row.source === "sms")
        await db.execute(sql`UPDATE sent_messages
        SET follow_up_dispatches=jsonb_set(follow_up_dispatches,ARRAY[${row.step}]::text[],
          (follow_up_dispatches->${row.step}) || ${JSON.stringify({ state, ...(reviewReason ? { reviewReason } : {}) })}::jsonb)
        WHERE id=${row.id} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
          AND follow_up_dispatches->${row.step}->>'jobId'=${dispatch.jobId}
          AND follow_up_dispatches->${row.step}->>'state'='pending'`);
      else
        await db.execute(sql`WITH cancelled_schedule AS (
          UPDATE social_follow_up_schedules SET status='cancelled',cancelled_at=COALESCE(cancelled_at,NOW()),
            cancellation_reason='configuration_changed',version=version+1,updated_at=NOW()
          WHERE ${state}='cancelled' AND id=${Number(dispatch.payload.socialFollowUpScheduleId) || 0}
            AND delivery_message_id=${row.id} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
            AND status='queued' RETURNING id
        ) UPDATE outreach_messages SET metadata=jsonb_set(metadata,'{configuredFollowUpDispatch}',
          (metadata->'configuredFollowUpDispatch') || ${JSON.stringify({ state, ...(reviewReason ? { reviewReason } : {}) })}::jsonb),
        status=CASE WHEN ${state}='cancelled' AND status IN ('pending','queued') THEN 'cancelled'
          WHEN ${Boolean(reviewReason?.startsWith('ASSISTANT_SETUP_REQUIRED'))} AND status IN ('pending','queued')
            AND COALESCE(provider_call_state,'not_started')='not_started' THEN 'setup_required' ELSE status END,updated_at=NOW()
        WHERE id=${row.id} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
          AND metadata->'configuredFollowUpDispatch'->>'jobId'=${dispatch.jobId}
          AND metadata->'configuredFollowUpDispatch'->>'state'='pending'`);
      if (state === "dispatched") dispatched++;
    } catch (error) {
      const setup = deliverySetupFailure(error);
      if (setup) {
        const failure = JSON.stringify({ state: 'review_required', reviewReason: `${setup.code}:${setup.reason}` });
        if (row.source === 'sms') await db.execute(sql`UPDATE sent_messages SET follow_up_dispatches=jsonb_set(follow_up_dispatches,
          ARRAY[${row.step}]::text[],(follow_up_dispatches->${row.step})||${failure}::jsonb) WHERE id=${row.id}
          AND user_id=${scope.userId} AND follow_up_dispatches->${row.step}->>'state'='pending'`);
        else await db.execute(sql`UPDATE outreach_messages SET status='setup_required',error_message=${setup.error},
          metadata=jsonb_set(metadata,'{configuredFollowUpDispatch}',(metadata->'configuredFollowUpDispatch')||${failure}::jsonb),updated_at=NOW()
          WHERE id=${row.id} AND user_id=${scope.userId} AND status IN ('pending','queued')
            AND COALESCE(provider_call_state,'not_started')='not_started'`);
        continue;
      }
      logger.warn(
        { err: error, id: row.id },
        "Configured follow-up dispatch remains pending for recovery",
      );
    }
  }
  return dispatched;
}
