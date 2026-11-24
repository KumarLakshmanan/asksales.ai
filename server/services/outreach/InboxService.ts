import { sql, type SQL } from "drizzle-orm";
import { db } from "../../models/db.js";
import { redactPiiWithStableTokens } from "../agents/orchestration/PrivacyVaultService.js";
import {
  resolveOfficialProviderBinding,
  type OfficialProviderChannel,
} from "./ProviderBindingService.js";
import { hasActiveWhatsAppWindow } from "../whatsappServiceWindow.js";
import { currentBusinessScope } from "../../tenancy/businessContext.js";
import { normalizeMSG91Phone } from "../../../shared/msg91.js";
import { emailDisplayText, legacyEmailFormat } from '../../utils/emailDisplay.js';
import type { EmailTextFormat } from '../../../shared/emailDisplay.js';
import { inboxEmailDisplayText } from './InboxEmailPresentation.js';
import { customerDeliveryReadiness } from '../assistants/CustomerDeliveryGate.js';
import {
  INBOX_CHANNELS,
  type InboxChannel,
  type InboxItem,
  type InboxPage,
  type InboxReplyAvailability,
} from "../../../shared/outreachInbox.js";

export interface InboxQuery {
  channel?: InboxChannel;
  leadId?: number;
  unread?: boolean;
  search: string;
  limit: number;
  cursor?: { at: string; kind: string; id: number };
}

export function parseInboxQuery(query: Record<string, unknown>): InboxQuery {
  const { channel, leadId, unread, search = "", limit = "50", cursor } = query;
  if (leadId !== undefined && (typeof leadId !== 'string' || !/^\d+$/.test(leadId)
    || !Number.isSafeInteger(Number(leadId)) || Number(leadId) <= 0)) throw new Error('Invalid inbox contact.');
  if (
    channel !== undefined &&
    channel !== "all" &&
    !INBOX_CHANNELS.includes(channel as InboxChannel)
  )
    throw new Error("Invalid inbox channel.");
  if (unread !== undefined && !["true", "false"].includes(unread as string))
    throw new Error("Invalid unread filter.");
  if (typeof search !== "string" || search.length > 200)
    throw new Error("Search must be at most 200 characters.");
  if (
    typeof limit !== "string" ||
    !/^\d+$/.test(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 100
  )
    throw new Error("Limit must be between 1 and 100.");
  let decoded: InboxQuery["cursor"];
  if (cursor !== undefined) {
    try {
      if (typeof cursor !== "string" || cursor.length > 500) throw new Error();
      decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (
        !decoded ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(decoded.at) ||
        !Number.isFinite(Date.parse(decoded.at)) ||
        !["conversation", "legacy"].includes(decoded.kind) ||
        !Number.isSafeInteger(decoded.id) ||
        decoded.id < 1
      )
        throw new Error();
    } catch {
      throw new Error("Invalid inbox cursor.");
    }
  }
  return {
    leadId: leadId === undefined ? undefined : Number(leadId),
    channel:
      channel && channel !== "all" ? (channel as InboxChannel) : undefined,
    unread: unread === "true",
    search: search.trim(),
    limit: Number(limit),
    cursor: decoded,
  };
}

export function safeInboxText(text: string | null | undefined, format: EmailTextFormat = 'text'): string {
  return redactPiiWithStableTokens(
    emailDisplayText(text || '', format),
  ).redactedText;
}

// Raw bodies are never used in a search predicate. The invalidation triggers
// cover SQL writers as well as model writers; compare-and-set prevents a late
// projection from overwriting a newer edit. The rollout script prewarms history.
const indexing = new Map<string, Promise<void>>();
export async function prepareInboxSearch(userId: number): Promise<void> {
  const scopeKey = `${userId}:${currentBusinessScope()?.businessProfileId ?? "default"}`;
  const running = indexing.get(scopeKey);
  if (running) return running;
  const work = (async () => {
    for (const kind of ["conversation", "legacy"] as const) {
      for (;;) {
        const result =
          kind === "conversation"
            ? await db.execute(sql`SELECT m.id, m.content AS body, m.html_content AS html, m.subject, m.redacted_content AS redacted
              FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id
              WHERE c.user_id=${userId} AND m.inbox_search_text IS NULL ORDER BY m.id LIMIT 250`)
            : await db.execute(sql`SELECT id, message AS body, subject, NULL::text AS html, channel, to_jsonb(sent_messages)->>'message_format' AS message_format, NULL::text AS redacted
              FROM sent_messages WHERE user_id=${userId} AND inbox_search_text IS NULL ORDER BY id LIMIT 250`);
        const rows = result.rows as Array<{
          id: number;
          body: string;
          subject: string | null;
          redacted: string | null;
          channel?: string;
          message_format?: string | null;
          html: string | null;
        }>;
        if (!rows.length) break;
        const values = rows.map(row => {
          const format = kind === "legacy"
            ? legacyEmailFormat(row.body || "", row.channel || "", row.message_format)
            : row.redacted == null && row.html ? "html" : "text";
          const searchText = `${safeInboxText(row.subject)}\n${safeInboxText(row.redacted ?? (row.html || row.body), format)}`
            // PostgreSQL's text parser ignores HTML-looking tags. Literal examples
            // must contribute words to search after their content is made inert.
            .replace(/[<>]/g, " ");
          return sql`(${row.id}::integer, ${row.body}::text, ${row.subject}::text, ${row.redacted}::text,
            ${row.message_format ?? null}::text, ${row.html}::text, ${searchText}::text)`;
        });
        if (kind === "conversation")
          await db.execute(sql`
          UPDATE outreach_messages m SET inbox_search_text=v.safe FROM (VALUES ${sql.join(values, sql`,`)}) v(id,body,subject,redacted,format,html,safe), outreach_conversations c
          WHERE m.id=v.id AND c.id=m.conversation_id AND c.user_id=${userId}
            AND m.content IS NOT DISTINCT FROM v.body AND m.subject IS NOT DISTINCT FROM v.subject AND m.redacted_content IS NOT DISTINCT FROM v.redacted AND m.html_content IS NOT DISTINCT FROM v.html`);
        else
          await db.execute(sql`
          UPDATE sent_messages m SET inbox_search_text=v.safe FROM (VALUES ${sql.join(values, sql`,`)}) v(id,body,subject,redacted,format,html,safe)
          WHERE m.id=v.id AND m.user_id=${userId} AND m.message IS NOT DISTINCT FROM v.body AND m.subject IS NOT DISTINCT FROM v.subject AND (to_jsonb(m)->>'message_format') IS NOT DISTINCT FROM v.format`);
      }
    }
  })();
  indexing.set(scopeKey, work);
  try {
    await work;
  } finally {
    indexing.delete(scopeKey);
  }
}

// This projection intentionally preserves each native conversation and each
// unlinked historical send. A contact name is never a threading key.
function inboxRows(userId: number): SQL {
  return sql`
    SELECT 'conversation'::text AS kind, c.id, c.lead_id, CASE WHEN c.channel='gmail' THEN 'email' ELSE c.channel END AS channel,
      COALESCE(NULLIF(l.full_name,''), NULLIF(l.name,''), c.lead_name, l.email, l.phone, 'Unknown contact') AS lead_name,
      COALESCE(l.email,c.lead_email) AS lead_email, l.phone AS lead_phone, COALESCE(l.company,l.company_name,c.lead_company) AS lead_company,
      c.lead_avatar, COALESCE(c.subject,(SELECT subject FROM outreach_messages WHERE conversation_id=c.id AND subject IS NOT NULL ORDER BY id LIMIT 1)) AS subject,
      COALESCE(c.last_message_at,c.created_at) AS activity_at, accounts.unread_count,
      accounts.total_messages, c.status, COALESCE(c.integration_provider,CASE WHEN c.channel='gmail' THEN 'gmail' END) AS integration_provider,
      CASE WHEN c.channel IN ('facebook','instagram') THEN NULLIF(c.provider_account_id,'')
        ELSE COALESCE(NULLIF(c.provider_account_id,''), CASE WHEN accounts.n=1 THEN accounts.account END,
          CASE WHEN c.channel='whatsapp' THEN c.metadata->>'phoneNumberId' END) END AS provider_account_id,
      c.external_thread_id, c.lead_instagram,
      CASE WHEN c.channel IN ('email','gmail') THEN c.lead_email
        WHEN c.channel='whatsapp' THEN COALESCE(c.external_thread_id,c.metadata->>'phoneNumber',l.phone)
        WHEN c.channel='sms' THEN COALESCE(c.external_thread_id,l.phone)
        WHEN c.channel='instagram' THEN COALESCE(c.external_thread_id,c.lead_instagram)
        WHEN c.channel='facebook' THEN COALESCE(c.external_thread_id,c.metadata->>'facebookPsid') END AS recipient,
      COALESCE(l.blacklisted,false) OR COALESCE(l.do_not_contact,false)
        OR (c.channel IN ('email','gmail') AND COALESCE(l.email_unsubscribed,false)) AS opted_out,
      senders.sender_id,
      preview.preview_body, preview.preview_is_html, NULL::text AS message_format, preview.message_id AS preview_message_id
    FROM outreach_conversations c LEFT JOIN leads l ON l.id=c.lead_id AND l.user_id=c.user_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN m.direction='inbound' AND m.privacy_vault_id IS NOT NULL THEN m.id END AS message_id,
        COALESCE(m.redacted_content,NULLIF(m.html_content,''),m.content) AS preview_body,
        (m.redacted_content IS NULL AND NULLIF(m.html_content,'') IS NOT NULL) AS preview_is_html
      FROM outreach_messages m WHERE m.conversation_id=c.id
      ORDER BY COALESCE(m.sent_at,m.created_at) DESC,m.id DESC LIMIT 1
    ) preview ON true
    LEFT JOIN LATERAL (SELECT COUNT(*) AS total_messages, COUNT(*) FILTER(WHERE m.direction='inbound' AND COALESCE(m.is_read,false)=false) AS unread_count,
      COUNT(DISTINCT COALESCE(NULLIF(m.provider_account_id,''),NULLIF(m.phone_number_id,''))) AS n,
      MIN(COALESCE(NULLIF(m.provider_account_id,''),NULLIF(m.phone_number_id,''))) AS account FROM outreach_messages m WHERE m.conversation_id=c.id) accounts ON true
    LEFT JOIN LATERAL (SELECT CASE WHEN COUNT(DISTINCT s.sender_id)=1 THEN MIN(s.sender_id) END AS sender_id
      FROM sent_messages s JOIN outreach_messages m ON m.id=s.outreach_message_id
      WHERE m.conversation_id=c.id AND s.user_id=c.user_id) senders ON true
    WHERE c.user_id=${userId} AND c.channel IN ('email','gmail','whatsapp','instagram','facebook','sms')
      AND accounts.total_messages>0
    UNION ALL
    SELECT 'legacy', s.id, s.lead_id, CASE WHEN s.channel='gmail' THEN 'email' ELSE s.channel END,
      COALESCE(NULLIF(l.full_name,''),NULLIF(l.name,''),s.lead_name,'Unknown contact'),l.email,l.phone,COALESCE(l.company,l.company_name),
      NULL::text,s.subject,s.sent_at,0,1,COALESCE(s.delivery_status,s.status),CASE WHEN s.channel='gmail' THEN 'gmail' END,
      NULL::text,NULL::text,NULL::text,CASE WHEN s.channel IN ('email','gmail') THEN l.email ELSE l.phone END,false,s.sender_id,s.message,false,to_jsonb(s)->>'message_format',NULL::integer
    FROM sent_messages s LEFT JOIN leads l ON l.id=s.lead_id AND l.user_id=s.user_id
    WHERE s.user_id=${userId} AND s.outreach_message_id IS NULL
      AND s.channel IN ('email','gmail','whatsapp','instagram','facebook','sms')
      AND s.status IN ('sent','delivered','read','opened','clicked','replied','bounced')`;
}

type Row = {
  kind: "conversation" | "legacy";
  id: number;
  lead_id: number;
  channel: InboxChannel;
  lead_name: string;
  lead_email: string | null;
  lead_phone: string | null;
  lead_company: string | null;
  lead_avatar: string | null;
  subject: string | null;
  activity_at: Date | string;
  cursor_at?: string;
  unread_count: number;
  total_messages: number;
  status: string;
  integration_provider: string | null;
  provider_account_id: string | null;
  recipient: string | null;
  opted_out: boolean;
  sender_id: number | null;
  preview_body: string | null;
  preview_message_id?: number;
  preview_is_html: boolean;
  message_format: string | null;
};

export async function replyAvailability(
  userId: number,
  row: Row,
): Promise<InboxReplyAvailability> {
  const result: InboxReplyAvailability = {
    canReply: false,
    reason: null,
    accountLabel: row.provider_account_id,
    providerAccountId: row.provider_account_id,
  };
  const block = (reason: string) => ({ ...result, reason });
  if (row.kind === "legacy")
    return block(
      "Historical send. Its original conversation and sending account could not be verified.",
    );
  if (row.opted_out || ["unsubscribed", "opted_out"].includes(row.status))
    return block("This contact has opted out of outreach.");
  if (row.status === "bounced")
    return block(
      "Delivery to this address bounced. Check the contact details before sending.",
    );
  if (!row.recipient)
    return block("This conversation has no verified recipient.");
  if (row.channel === "sms" && !normalizeMSG91Phone(row.recipient)) {
    return block("Add a valid SMS phone number before replying.");
  }
  let account = row.provider_account_id;
  let credentialId: number | undefined;
  if (row.channel === "email" && row.sender_id) {
    const sender = (
      await db.execute(
        sql`SELECT id,email,type,credential_id,is_verified FROM email_senders WHERE id=${row.sender_id} AND user_id=${userId}`,
      )
    ).rows[0];
    if (!sender?.is_verified || sender.type !== row.integration_provider)
      return block(
        "The original email sender is unavailable. Reconnect that sender.",
      );
    credentialId = sender.credential_id || undefined;
    result.senderId = sender.id;
    result.accountLabel = sender.email;
    let senderAccount: string | undefined;
    if (sender.type === "resend") senderAccount = sender.email.split("@")[1];
    else {
      const credential = (
        await db.execute(
          sql`SELECT account_identifier FROM channel_credentials WHERE id=${credentialId || 0} AND user_id=${userId}`,
        )
      ).rows[0];
      senderAccount = credential?.account_identifier;
    }
    if (
      !senderAccount ||
      (account && account.toLowerCase() !== senderAccount.toLowerCase())
    )
      return block(
        "The original sender no longer matches this conversation. Reconnect the original account to reply.",
      );
    account = senderAccount;
  }
  if (!account)
    return block(
      "The original sending account is unknown. Open a conversation from a verified account to reply.",
    );
  result.providerAccountId = account;
  if (
    row.channel === "email" &&
    row.integration_provider === "resend" &&
    !result.senderId
  ) {
    const senders = (
      await db.execute(sql`SELECT id,email FROM email_senders WHERE user_id=${userId} AND type='resend'
      AND is_verified=true AND LOWER(split_part(email,'@',2))=LOWER(${account}) ORDER BY id LIMIT 2`)
    ).rows;
    if (senders.length !== 1)
      return block(
        "The original sender address is unavailable. Verify its email sender before replying.",
      );
    result.senderId = senders[0].id;
    result.accountLabel = senders[0].email;
  }
  if (
    row.channel === "email" &&
    !["gmail", "resend"].includes(row.integration_provider || "")
  )
    return block("The original email provider could not be verified.");
  const binding = await resolveOfficialProviderBinding(
    userId,
    row.channel as OfficialProviderChannel,
    {
      providerAccountId: account,
      ...(credentialId ? { credentialId } : {}),
      ...(row.channel === "email"
        ? { providerVariant: row.integration_provider as "gmail" | "resend" }
        : {}),
    },
  );
  if (!binding)
    return block(
      "The original sending account is disconnected or lacks permission. Reconnect it to reply.",
    );
  const assistant = await customerDeliveryReadiness({ userId, channel: row.channel,
    accountId: row.channel === 'email' ? result.accountLabel || '' : account,
    surface: 'private' });
  result.assistant = assistant;
  if (!assistant.ready) return block(assistant.error || 'Configure the assigned assistant before replying.');
  return {
    ...result,
    canReply: true,
    accountLabel: result.accountLabel || binding.accountName || account,
    requiresTemplate:
      row.channel === "whatsapp" &&
      !(await hasActiveWhatsAppWindow(userId, row.lead_id, account)),
  };
}

async function presentRow(userId: number, row: Row, actorUserId?: number): Promise<InboxItem> {
  if (row.channel === "sms" && row.recipient) row = { ...row, recipient: normalizeMSG91Phone(row.recipient) };
  let reply: InboxReplyAvailability;
  try {
    reply = await replyAvailability(userId, row);
  } catch {
    reply = {
      canReply: false,
      reason:
        "Connection status could not be verified. Refresh this conversation to try again.",
      accountLabel: row.provider_account_id,
      providerAccountId: row.provider_account_id,
    };
  }
  const display = row.kind === 'conversation' && row.channel === 'email'
    ? await inboxEmailDisplayText(userId, actorUserId, row.id, row.preview_message_id)
    : null;
  return {
    key: `${row.kind}:${row.id}`,
    kind: row.kind,
    id: row.id,
    channel: row.channel,
    leadId: row.lead_id,
    leadName: row.lead_name,
    leadEmail: row.lead_email,
    leadPhone: row.lead_phone,
    leadCompany: row.lead_company,
    leadAvatar: row.lead_avatar,
    recipient: row.recipient,
    subject: row.subject,
    preview: (display ?? safeInboxText(row.preview_body, row.kind === 'legacy' ? legacyEmailFormat(row.preview_body || '', row.channel, row.message_format) : row.preview_is_html ? 'html' : 'text'))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180),
    // Preserve the same precision as the cursor when the client merges pages.
    activityAt: row.cursor_at || new Date(row.activity_at).toISOString(),
    unreadCount: Number(row.unread_count),
    totalMessages: Number(row.total_messages),
    status: row.status,
    integrationProvider: row.integration_provider,
    reply,
  };
}

export async function listInbox(
  userId: number,
  query: InboxQuery,
  actorUserId?: number,
): Promise<InboxPage> {
  if (query.search) await prepareInboxSearch(userId);
  const searchLike = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
  const searchFilter = !query.search
    ? sql``
    : sql`AND (
    concat_ws(' ',r.lead_name,r.lead_email,r.lead_phone,r.lead_company,r.recipient) ILIKE ${searchLike}
    OR to_tsvector('simple',COALESCE(r.subject,'')) @@ plainto_tsquery('simple',${query.search})
    OR (r.kind='conversation' AND EXISTS(SELECT 1 FROM outreach_messages m WHERE m.conversation_id=r.id
      AND to_tsvector('simple',COALESCE(m.inbox_search_text,'')) @@ plainto_tsquery('simple',${query.search})))
    OR (r.kind='legacy' AND EXISTS(SELECT 1 FROM sent_messages s WHERE s.id=r.id AND s.user_id=${userId}
      AND to_tsvector('simple',COALESCE(s.inbox_search_text,'')) @@ plainto_tsquery('simple',${query.search}))))`;
  const rows = (
    await db.execute(sql`WITH inbox AS (${inboxRows(userId)}) SELECT r.*,
      to_char(r.activity_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM inbox r WHERE true
      ${query.channel ? sql`AND r.channel=${query.channel}` : sql``}
      ${query.leadId ? sql`AND r.lead_id=${query.leadId}` : sql``}
      ${query.unread ? sql`AND r.unread_count>0` : sql``} ${searchFilter}
      ${query.cursor ? sql`AND (r.activity_at,r.kind,r.id)<(${query.cursor.at}::timestamptz AT TIME ZONE 'UTC',${query.cursor.kind},${query.cursor.id})` : sql``}
      ORDER BY r.activity_at DESC,r.kind DESC,r.id DESC LIMIT ${query.limit + 1}`)
  ).rows as Row[];
  const counts = (
    await db.execute(sql`SELECT CASE WHEN c.channel='gmail' THEN 'email' ELSE c.channel END AS channel,COUNT(*)::int AS count
    FROM outreach_conversations c WHERE c.user_id=${userId}
      ${query.leadId ? sql`AND c.lead_id=${query.leadId}` : sql``}
      AND EXISTS(SELECT 1 FROM outreach_messages m WHERE m.conversation_id=c.id AND m.direction='inbound' AND COALESCE(m.is_read,false)=false)
      AND c.channel IN ('email','gmail','whatsapp','instagram','facebook','sms') GROUP BY 1`)
  ).rows as Array<{ channel: InboxChannel; count: number }>;
  const unreadThreads = Object.fromEntries(
    [...INBOX_CHANNELS, "all"].map((c) => [c, 0]),
  ) as InboxPage["unreadThreads"];
  for (const row of counts) {
    unreadThreads[row.channel] = Number(row.count);
    unreadThreads.all += Number(row.count);
  }
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: await Promise.all(page.map((row) => presentRow(userId, row, actorUserId))),
    unreadThreads,
    nextCursor:
      rows.length > query.limit && last
        ? Buffer.from(
            JSON.stringify({
              at: last.cursor_at,
              kind: last.kind,
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  };
}

export async function getInboxItem(
  userId: number,
  kind: "conversation" | "legacy",
  id: number,
  actorUserId?: number,
) {
  const row = (
    await db.execute(
      sql`WITH inbox AS (${inboxRows(userId)}) SELECT r.*,
        to_char(r.activity_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM inbox r WHERE kind=${kind} AND id=${id}`,
    )
  ).rows[0] as Row | undefined;
  if (!row) return null;
  const item = await presentRow(userId, row, actorUserId);
  return {
    item,
    ...(kind === "legacy"
      ? {
          message: {
            id,
            conversationId: 0,
            direction: "outbound",
            content: safeInboxText(row.preview_body, legacyEmailFormat(row.preview_body || '', row.channel, row.message_format)),
            subject: row.subject,
            status: row.status,
            createdAt: item.activityAt,
            sentAt: item.activityAt,
            deliveredAt: null,
            readAt: null,
            isRead: true,
          },
        }
      : {}),
  };
}
