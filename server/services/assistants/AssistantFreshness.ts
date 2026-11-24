import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { requireBusinessScope } from "../../tenancy/businessContext.js";
import type {
  AssistantDraft,
  AssistantProvenance,
} from "../../../shared/outreachAssistants.js";
import { SupersededSupportTurn } from "../agents/orchestration/SupportConversationTurn.js";
import {
  assistantsRuntimeEnabled,
  currentAssistant,
  freezeAssistant,
  withAssistantContext,
} from "./AssistantContext.js";
import {
  parseAssistantDraft,
  withinAssistantHours,
} from "./AssistantConfiguration.js";
import { assertCustomerDeliveryRuntime, CustomerDeliverySetupError } from './CustomerDeliveryGate.js';

function validProvenance(value: unknown): value is AssistantProvenance {
  if (!value || typeof value !== "object") return false;
  const p = value as AssistantProvenance;
  return (
    typeof p.assistantId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      p.assistantId,
    ) &&
    [p.bindingId, p.bindingVersion, p.revision, p.businessProfileId].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) &&
    typeof p.accountId === "string" &&
    Boolean(p.accountId)
  );
}
async function currentBinding(
  value: unknown,
  executor: Pick<typeof db, "execute"> = db,
  lock = false,
) {
  if (!assistantsRuntimeEnabled()) return null;
  if (!validProvenance(value)) return null;
  const p = value,
    scope = requireBusinessScope();
  if (scope.businessProfileId !== p.businessProfileId) return null;
  const result =
    await executor.execute(sql`SELECT r.configuration FROM outreach_assistant_bindings b JOIN outreach_assistants a ON a.id=b.assistant_id
    JOIN outreach_assistant_revisions r ON r.assistant_id=b.assistant_id AND r.revision=b.revision
    WHERE b.id=${p.bindingId} AND b.business_profile_id=${scope.businessProfileId} AND b.user_id=${scope.userId}
      AND b.assistant_id=${p.assistantId}::uuid AND b.revision=${p.revision} AND b.version=${p.bindingVersion}
      AND b.channel=${p.channel} AND b.surface=${p.surface} AND b.account_id=${p.accountId} AND b.enabled
      AND a.state='live' AND a.published_revision=b.revision ${lock ? sql`FOR SHARE OF b,a` : sql``}`);
  return result.rows[0] || null;
}
/** Delivery-time hours and away reservations are checked against the immutable
 * published revision. A retry cannot replay an expired/consumed away message. */
export async function assistantDeliveryCurrent(
  value: unknown,
  metadata: Record<string, unknown> = {},
  executor: Pick<typeof db, "execute"> = db,
  lock = false,
): Promise<boolean> {
  if (!value) return false;
  const row = await currentBinding(value, executor, lock);
  if (!row || !validProvenance(value)) return false;
  const availability = (row.configuration as AssistantDraft).availability;
  const open = withinAssistantHours(availability);
  if (metadata.assistantAway !== true) return open;
  const receipt = metadata.assistantAwayReceipt as
    | { id?: number; token?: string }
    | undefined;
  if (
    open ||
    !availability.awayMessage ||
    value.surface !== "private" ||
    !Number.isSafeInteger(receipt?.id) ||
    !receipt?.token ||
    !/^[0-9a-f-]{36}$/i.test(receipt.token)
  )
    return false;
  const scope = requireBusinessScope();
  const reserved =
    await executor.execute(sql`SELECT id FROM outreach_assistant_away_receipts
    WHERE id=${receipt.id!} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
      AND binding_id=${value.bindingId} AND channel=${value.channel} AND account_id=${value.accountId}
      AND reservation_token=${receipt.token}::uuid AND reserved_until>NOW()
      AND (last_sent_at IS NULL OR last_sent_at<=NOW()-INTERVAL '6 hours') ${lock ? sql`FOR UPDATE` : sql``}`);
  return reserved.rows.length === 1;
}
export async function assistantProvenanceCurrent(
  value: unknown,
  executor: Pick<typeof db, "execute"> = db,
): Promise<boolean> {
  return value
    ? Boolean(await currentBinding(value, executor))
    : false;
}
export async function assertAssistantFresh(
  executor: Pick<typeof db, "execute"> = db,
) {
  const assistant = currentAssistant();
  if (
    assistant &&
    !assistant.preview &&
    !(await assistantProvenanceCurrent(assistant.provenance, executor))
  )
    throw new SupersededSupportTurn();
}
/** Restore the exact published context for queued work; never select a new assistant. */
export async function withPublishedAssistant<T>(
  value: unknown,
  work: () => Promise<T>,
): Promise<T> {
  if (!value) throw new CustomerDeliverySetupError('assignment_required',
    'Customer delivery requires the exact published assistant assignment. Review assistant setup before sending.');
  if (validProvenance(value)) assertCustomerDeliveryRuntime(value.channel);
  const row = await currentBinding(value);
  if (!row || !validProvenance(value)) throw new SupersededSupportTurn();
  return withAssistantContext(
    freezeAssistant({
      provenance: structuredClone(value),
      configuration: parseAssistantDraft(row.configuration),
      preview: false,
    }),
    work,
  );
}

/** A public assignment cannot grant private-message permission. Cross-surface
 * delivery requires the SAME assistant/revision and original verified account. */
export async function withPrivateAssistantForPublicDelivery(
  value: unknown,
  work: () => Promise<void>,
): Promise<boolean> {
  if (!value) return false;
  if (
    !validProvenance(value) ||
    value.surface !== "public_comment" ||
    !(await currentBinding(value))
  )
    return false;
  const scope = requireBusinessScope();
  const result =
    await db.execute(sql`SELECT id,version FROM outreach_assistant_bindings
    WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
      AND assistant_id=${value.assistantId}::uuid AND revision=${value.revision}
      AND channel=${value.channel} AND surface='private' AND account_id=${value.accountId} AND enabled LIMIT 2`);
  if (result.rows.length !== 1) return false;
  await withPublishedAssistant(
    {
      ...value,
      surface: "private",
      bindingId: Number(result.rows[0].id),
      bindingVersion: Number(result.rows[0].version),
    },
    work,
  );
  return true;
}
