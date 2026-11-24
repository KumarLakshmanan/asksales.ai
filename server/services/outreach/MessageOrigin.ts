import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import type { OutreachMessageOrigin } from "../../../shared/outreachInbox.js";

/** The fields of an outreach message that say who or what sent it. */
export interface OriginFields {
  id: number;
  direction: string;
  batchId?: string | null;
  campaignId?: number | null;
  templateName?: string | null;
  messageKind?: string | null;
  followUpStep?: number | null;
  isAutomatic?: boolean | null;
  isAiGenerated?: boolean | null;
  metadata?: unknown;
}

const APP_NAMES: Record<string, string> = {
  whatsapp: "the WhatsApp Business app (phone or web)",
  instagram: "the Instagram app",
  facebook: "Messenger",
};

function meta(message: OriginFields): Record<string, unknown> {
  return message.metadata && typeof message.metadata === "object" ? message.metadata as Record<string, unknown> : {};
}

/** Pure: how one outbound message was sent, given the names looked up for it. */
export function describeMessageOrigin(
  message: OriginFields,
  channel: string,
  names: { outreachName?: string | null; contentTemplateName?: string | null } = {},
): OutreachMessageOrigin | null {
  if (message.direction !== "outbound") return null;
  const m = meta(message);
  const origin = typeof m.origin === "string" ? m.origin : null;
  const templateName = message.templateName || names.contentTemplateName || null;
  const followUpStep = message.messageKind === "follow_up" ? message.followUpStep ?? null : null;
  if (origin === "native_app" || origin === "external_app") {
    const app = origin === "external_app" ? "another app connected to this account" : APP_NAMES[channel] || "the provider's own app";
    return { kind: "native_app", label: `Sent from ${app}` };
  }
  if (message.isAiGenerated || origin === "ai") return { kind: "ai", label: "AI assistant", templateName };
  if (origin === "crm_automation") return { kind: "automation", label: "CRM automation", templateName };
  const isOutreach = Boolean(message.batchId || message.campaignId || followUpStep !== null
    || message.messageKind === "follow_up" || message.isAutomatic || "outreachCreation" in m);
  if (isOutreach) {
    return {
      kind: "outreach",
      label: "AskSales outreach",
      outreachName: names.outreachName ?? null,
      templateName,
      followUpStep,
    };
  }
  return {
    kind: "manual",
    // Only sends stamped by the inbox are known to be manual; older ones are not claimed.
    label: origin === "inbox" ? "Sent manually in AskSales" : "Sent from AskSales",
    templateName,
  };
}

/** Adds `origin` to each outbound message, with outreach and template names
 * looked up in three batched reads scoped to the conversation's owner. */
export async function withMessageOrigins<T extends OriginFields>(
  userId: number,
  channel: string,
  messages: T[],
): Promise<Array<T & { origin: OutreachMessageOrigin | null }>> {
  const outbound = messages.filter((message) => message.direction === "outbound");
  const batchIds = [...new Set(outbound.map((m) => m.batchId).filter((id): id is string => Boolean(id)))];
  const campaignIds = [...new Set(outbound.map((m) => m.campaignId).filter((id): id is number => Number.isSafeInteger(id)))];
  const templateIds = [...new Set(outbound.map((m) => Number(meta(m).sourceTemplateId)).filter((id) => Number.isSafeInteger(id) && id > 0))];

  type NameRow = { id: string | number; name: string };
  const names = async (query: ReturnType<typeof sql> | null): Promise<NameRow[]> =>
    query ? ((await db.execute(query)).rows as NameRow[]) : [];
  const idList = (ids: Array<string | number>, cast: string) => sql.join(ids.map((id) => sql`${id}${sql.raw(cast)}`), sql`,`);
  const [batches, campaigns, templates] = await Promise.all([
    names(batchIds.length ? sql`SELECT id::text AS id, name FROM outreach_batches
      WHERE user_id=${userId} AND id IN (${idList(batchIds, "::uuid")})` : null),
    names(campaignIds.length ? sql`SELECT id, name FROM outreach_campaigns
      WHERE user_id=${userId} AND id IN (${idList(campaignIds, "::integer")})` : null),
    // Shared library templates have no owner; anyone else's templates stay theirs.
    names(templateIds.length ? sql`SELECT id, name FROM content_templates
      WHERE (user_id IS NULL OR user_id=${userId}) AND id IN (${idList(templateIds, "::integer")})` : null),
  ]);
  const batchNames = new Map<string, string>(batches.map((b) => [String(b.id), b.name]));
  const campaignNames = new Map<number, string>(campaigns.map((c) => [Number(c.id), c.name]));
  const templateNames = new Map<number, string>(templates.map((t) => [Number(t.id), t.name]));

  return messages.map((message) => ({
    ...message,
    origin: describeMessageOrigin(message, channel, {
      outreachName: (message.batchId ? batchNames.get(message.batchId) : undefined)
        ?? (message.campaignId ? campaignNames.get(message.campaignId) : undefined) ?? null,
      contentTemplateName: templateNames.get(Number(meta(message).sourceTemplateId)) ?? null,
    }),
  }));
}
