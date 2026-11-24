import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { requireBusinessScope } from "../../tenancy/businessContext.js";
import type { PipelineContext } from "../agents/pipeline/ChannelGateway.js";
import {
  PipelineHalt,
  type PipelineStage,
} from "../agents/pipeline/PipelineStage.js";
import { currentAssistant, markAssistantDelivery } from "./AssistantContext.js";
import { withinAssistantHours } from "./AssistantConfiguration.js";
import { redactPiiWithStableTokens } from "../agents/orchestration/PrivacyVaultService.js";

/** Availability runs after mandatory privacy, ownership, opt-out and inbound safety checks. */
export class AssistantAvailabilityStage implements PipelineStage {
  name = "AssistantAvailability";
  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const assistant = currentAssistant();
    if (
      !assistant ||
      ctx.metadata?.skipAgentGeneration ||
      withinAssistantHours(assistant.configuration.availability)
    )
      return ctx;
    const availability = assistant.configuration.availability;
    ctx.metadata = {
      ...ctx.metadata,
      availabilityClosed: true,
      suppressBusinessEffects: true,
    };
    if (
      !availability.awayMessage ||
      assistant.provenance.surface !== "private"
    ) {
      throw new PipelineHalt(
        "The assigned assistant is outside its availability hours.",
        ctx,
        "no_op",
      );
    }
    let receipt: { id: number; token: string } | undefined;
    if (!assistant.preview) {
      const scope = requireBusinessScope(),
        p = assistant.provenance,
        token = randomUUID();
      const customerKey = createHash("sha256")
        .update(
          `${scope.businessProfileId}:${p.channel}:${p.accountId}:${ctx.message.senderIdentifier}`,
        )
        .digest("hex");
      const result =
        await db.execute(sql`INSERT INTO outreach_assistant_away_receipts
        (user_id,binding_id,channel,account_id,customer_key,reserved_until,reservation_token)
        VALUES(${scope.userId},${p.bindingId},${p.channel},${p.accountId},${customerKey},NOW()+INTERVAL '5 minutes',${token}::uuid)
        ON CONFLICT(business_profile_id,channel,account_id,customer_key) DO UPDATE SET
          binding_id=EXCLUDED.binding_id,reserved_until=EXCLUDED.reserved_until,reservation_token=EXCLUDED.reservation_token
        WHERE (outreach_assistant_away_receipts.last_sent_at IS NULL OR outreach_assistant_away_receipts.last_sent_at<=NOW()-INTERVAL '6 hours')
          AND (outreach_assistant_away_receipts.reserved_until IS NULL OR outreach_assistant_away_receipts.reserved_until<=NOW()) RETURNING id`);
      if (!result.rows.length)
        throw new PipelineHalt(
          "An away reply was already sent or is being delivered for this customer/account.",
          ctx,
          "no_op",
        );
      receipt = { id: Number(result.rows[0].id), token };
      markAssistantDelivery({
        assistantAway: true,
        assistantAwayReceipt: receipt,
      });
    }
    ctx.metadata = {
      ...ctx.metadata,
      skipAgentGeneration: true,
      assistantAway: true,
      assistantAwayReceipt: receipt,
    };
    ctx.agentResult = {
      replyText: redactPiiWithStableTokens(availability.awayMessage)
        .redactedText,
      confidence: 1,
      outcome: "clarification",
      escalated: false,
      groundingStatus: "not_required",
      effectProposals: [],
      toolCallsExecuted: [],
    };
    return ctx;
  }
}

/** A reservation is not a delivery. Record the six-hour window only after an actual acknowledgement. */
export async function confirmAssistantAwayMessage(
  metadata?: Record<string, unknown>,
) {
  const receipt = metadata?.assistantAwayReceipt as
    | { id?: number; token?: string }
    | undefined;
  if (!receipt?.id || !receipt.token || !/^[0-9a-f-]{36}$/i.test(receipt.token))
    return;
  const scope = requireBusinessScope();
  await db.execute(sql`UPDATE outreach_assistant_away_receipts SET last_sent_at=NOW(),reserved_until=NULL
    WHERE id=${receipt.id} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
      AND reservation_token=${receipt.token}::uuid`);
}
