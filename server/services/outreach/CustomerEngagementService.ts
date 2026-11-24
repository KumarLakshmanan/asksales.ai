import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../models/db.js";
import { requireBusinessScope } from "../../tenancy/businessContext.js";
import { serializeUtcTimestamp } from "../../utils/supportTimestamp.js";
import { redactPiiWithStableTokens } from "../agents/orchestration/PrivacyVaultService.js";
import { campaignReportFiltersSchema } from "./CampaignReportFilters.js";
import {
  canonicalOutreachCtes,
  campaignResponseCtes,
  executeReportQuery,
  reportPredicate,
  validateReportScope,
  reportDefinitions,
} from "./CampaignReportingService.js";
import {
  campaignReportUrl,
  type CampaignReportFilters,
} from "../../../shared/campaignReporting.js";
import { DashboardOperationError } from "../operations/DashboardOperations.js";
import type {
  CampaignCustomer,
  CampaignCustomerPage,
  CampaignHistoryMessage,
  CampaignHistoryPage,
} from "../../../shared/campaignEngagement.js";
export const customerKeySchema = z
  .string()
  .regex(/^(contact|lead):[1-9][0-9]{0,15}$/);
export const engagementPageSchema = z
  .object({
    after: customerKeySchema.optional(),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    respondedOnly: z
      .union([
        z.boolean(),
        z.enum(["true", "false"]).transform((value) => value === "true"),
      ])
      .default(false),
  })
  .strict();
const historyCursorSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().max(100),
  })
  .strict();
export const historyPageSchema = z
  .object({
    customerKey: customerKeySchema.optional(),
    after: z.string().max(500).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const date = (value: unknown) => serializeUtcTimestamp(value);
const redact = (text: unknown) =>
  redactPiiWithStableTokens(typeof text === "string" ? text : "").redactedText;
export function campaignEngagementUrl(
  filters: Partial<CampaignReportFilters> = {},
  key?: string,
) {
  const url = campaignReportUrl(filters).replace(
    "/outreach/reports",
    "/outreach/engagement",
  );
  return (
    url +
    (key
      ? `${url.includes("?") ? "&" : "?"}customerKey=${encodeURIComponent(key)}`
      : "")
  );
}
export async function getCampaignCustomers(
  userId: number,
  input: unknown = {},
  page: unknown = {},
  executor = db,
  completeSnapshot = false,
): Promise<CampaignCustomerPage> {
  const filters = campaignReportFiltersSchema.parse(input),
    options = engagementPageSchema.parse(page);
  await validateReportScope(userId, filters);
  const scope = requireBusinessScope();
  const result =
    await executeReportQuery(executor, sql`WITH ${canonicalOutreachCtes(userId)},selected AS(SELECT * FROM intents i WHERE ${reportPredicate(filters)}),
    ${campaignResponseCtes(userId)},
    audience AS MATERIALIZED(SELECT customer_key,MIN(lead_id) AS lead_id,array_agg(DISTINCT channel ORDER BY channel) AS channels,COUNT(*)::int AS messages,
      COUNT(*) FILTER(WHERE state IN('accepted','delivered'))::int AS accepted,COUNT(*) FILTER(WHERE state='delivered')::int AS delivered,
      COUNT(*) FILTER(WHERE state='accepted')::int AS "awaitingConfirmation",COUNT(*) FILTER(WHERE state='queued')::int AS queued,COUNT(*) FILTER(WHERE state='failed')::int AS failed
      FROM selected GROUP BY customer_key),
    response_counts AS MATERIALIZED(SELECT customer_key,COUNT(*) FILTER(WHERE message_type='text')::int AS typed,
      COUNT(*) FILTER(WHERE message_type='button')::int AS buttons,COUNT(*) FILTER(WHERE message_type='menu')::int AS menus,
      COUNT(*) FILTER(WHERE message_type IS NULL OR message_type NOT IN('text','button','menu'))::int AS other,MAX(created_at) AS last_reply FROM replies GROUP BY customer_key),
    -- Verified bookings are few. Find them first, then match them to the cohort;
    -- starting from the cohort side took minutes on large accounts.
    booking_events AS MATERIALIZED(SELECT event.id,event.occurred_at,conversation.id AS conversation_id,
        COALESCE(conversation.provider_account_id,'') AS account_id,conversation.channel
      FROM sales_outcome_events event
      JOIN outreach_conversations conversation ON conversation.id=event.conversation_id AND event.conversation_kind='outreach'
        AND conversation.user_id=${userId} AND conversation.business_profile_id=${scope.businessProfileId}
      WHERE event.user_id=${userId} AND event.business_profile_id=${scope.businessProfileId} AND event.verified
        AND event.kind IN('booking_confirmed','booking_cancelled') AND event.occurred_at<=CURRENT_TIMESTAMP),
    booking_actions AS(SELECT DISTINCT event.id,cohort.customer_key FROM booking_events event
      JOIN conversation_customers identity ON identity.id=event.conversation_id
      JOIN cohort ON cohort.customer_key=identity.customer_key AND cohort.account_id=event.account_id
        AND (cohort.channel=event.channel OR (cohort.channel='email' AND event.channel IN('gmail','resend')))
      WHERE event.occurred_at>=cohort.starts AT TIME ZONE 'UTC'),
    -- Counted once per customer and joined. As per-customer subqueries they rescanned
    -- every message for each customer, which took minutes on accounts with 30,000+ customers.
    marker_customers AS MATERIALIZED(SELECT DISTINCT customer_key FROM reply_markers),
    booking_counts AS MATERIALIZED(SELECT customer_key,COUNT(*)::int AS actions FROM booking_actions GROUP BY customer_key),
    click_counts AS MATERIALIZED(SELECT intent.customer_key,
        COALESCE(SUM(jsonb_array_length(CASE WHEN jsonb_typeof(message.metadata->'clicks')='array' THEN message.metadata->'clicks' ELSE '[]'::jsonb END)),0)::int AS clicks
      FROM selected intent JOIN outreach_messages message ON message.id=intent.message_id AND message.user_id=${userId} AND message.business_profile_id=${scope.businessProfileId}
      GROUP BY intent.customer_key),
    customer_rows AS(SELECT audience.*,COALESCE(response.typed,0) AS "typedReplies",COALESCE(response.buttons,0) AS "quickReplies",
      COALESCE(response.menus,0) AS "menuSelections",COALESCE(response.other,0) AS "otherResponses",response.last_reply AS "lastReplyAt",
      response.customer_key IS NOT NULL OR marker.customer_key IS NOT NULL AS responded,
      COALESCE(booking.actions,0) AS "verifiedBookingActions",
      COALESCE(click.clicks,0) AS "trackedLinkClicks"
      FROM audience LEFT JOIN response_counts response USING(customer_key)
        LEFT JOIN marker_customers marker ON marker.customer_key=audience.customer_key
        LEFT JOIN booking_counts booking ON booking.customer_key=audience.customer_key
        LEFT JOIN click_counts click ON click.customer_key=audience.customer_key),
    visible AS(SELECT * FROM customer_rows ${options.respondedOnly ? sql`WHERE responded` : sql``})
    SELECT CURRENT_TIMESTAMP AS checked_at,(SELECT COUNT(*)::int FROM visible) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(item) ORDER BY item.customer_key) FROM(
        SELECT visible.*,contact.id AS contact_id,
          COALESCE(NULLIF(trim(concat_ws(' ',contact.first_name,contact.last_name)),''),NULLIF(lead.name,''),'Customer '||visible.lead_id) AS name,
          COALESCE(contact.email,lead.email) AS email,COALESCE(contact.phone,lead.phone) AS phone
        FROM visible LEFT JOIN crm_contacts contact ON visible.customer_key='contact:'||contact.id AND contact.user_id=${userId}
          AND contact.business_profile_id=${scope.businessProfileId} AND contact.deleted_at IS NULL
        LEFT JOIN leads lead ON lead.id=visible.lead_id AND lead.user_id=${userId} AND lead.business_profile_id=${scope.businessProfileId} AND lead.deleted_at IS NULL
        ${options.after ? sql`WHERE visible.customer_key>${options.after}` : sql``} ORDER BY visible.customer_key ${completeSnapshot ? sql`` : sql`LIMIT ${options.pageSize + 1}`}
      ) item),'[]'::jsonb) AS items`);
  const row = result.rows[0],
    rows = row.items as Array<Record<string, any>>,
    items: CampaignCustomer[] = (
      completeSnapshot ? rows : rows.slice(0, options.pageSize)
    ).map((item) => ({
      key: item.customer_key,
      contactId: item.contact_id || null,
      name: item.name,
      email: item.email || null,
      phone: item.phone || null,
      channels: item.channels,
      messages: item.messages,
      accepted: item.accepted,
      delivered: item.delivered,
      awaitingConfirmation: item.awaitingConfirmation,
      queued: item.queued,
      failed: item.failed,
      typedReplies: item.typedReplies,
      quickReplies: item.quickReplies,
      menuSelections: item.menuSelections,
      otherResponses: item.otherResponses,
      responded: item.responded,
      trackedLinkClicks: item.trackedLinkClicks,
      verifiedBookingActions: item.verifiedBookingActions,
      lastReplyAt: date(item.lastReplyAt),
    }));
  return {
    checkedAt: date(row.checked_at)!,
    businessProfileId: scope.businessProfileId,
    filters,
    total: Number(row.total),
    items,
    nextCursor:
      !completeSnapshot && rows.length > options.pageSize
        ? items.at(-1)!.key
        : null,
    availability: {
      callButtonClicks: "unavailable",
      untrackedWhatsAppUrlClicks: "unavailable",
      bookingActions: "verified_records_only",
    },
    attribution: reportDefinitions().attribution,
    card: {
      title: "Customer campaign engagement",
      status: "ready",
      checkedAt: date(row.checked_at)!,
      businessProfileId: scope.businessProfileId,
      metrics: [
        {
          label: options.respondedOnly
            ? "Responding customers"
            : "Selected customers",
          value: Number(row.total),
        },
        { label: "Customers on this page", value: items.length },
      ],
      actions: [
        {
          label: "View customer engagement",
          href: campaignEngagementUrl(filters),
        },
        { label: "View campaign report", href: campaignReportUrl(filters) },
      ],
    },
  };
}
export async function getCampaignHistory(
  userId: number,
  input: unknown = {},
  page: unknown = {},
  executor = db,
  completeSnapshot = false,
): Promise<CampaignHistoryPage> {
  const filters = campaignReportFiltersSchema.parse(input),
    options = historyPageSchema.parse(page);
  await validateReportScope(userId, filters);
  const scope = requireBusinessScope();
  let after: z.infer<typeof historyCursorSchema> | null = null;
  if (options.after)
    try {
      after = historyCursorSchema.parse(
        JSON.parse(Buffer.from(options.after, "base64url").toString("utf8")),
      );
    } catch {
      throw new DashboardOperationError(
        "The history cursor is invalid. Start from the first page.",
      );
    }
  const result =
    await executeReportQuery(executor, sql`WITH ${canonicalOutreachCtes(userId)},selected AS(SELECT * FROM intents i WHERE ${reportPredicate(filters)}
      ${options.customerKey ? sql`AND i.customer_key=${options.customerKey}` : sql``}),${campaignResponseCtes(userId)},
    history AS(
      SELECT 'message-'||m.id AS id,identity.customer_key,c.id AS conversation_id,
        CASE WHEN c.channel IN('gmail','resend') THEN 'email' ELSE c.channel END AS channel,COALESCE(c.provider_account_id,'') AS account_id,
        m.direction,m.message_type AS type,m.status,m.created_at,m.subject,COALESCE(NULLIF(m.redacted_content,''),m.content,'') AS content,m.metadata->'nativeSelection' AS selection
      FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
      JOIN conversation_customers identity ON identity.id=c.id WHERE m.user_id=${userId} AND m.business_profile_id=${scope.businessProfileId}
        AND (EXISTS(SELECT 1 FROM selected item WHERE item.message_id=m.id) OR EXISTS(SELECT 1 FROM response_rows response WHERE response.id=m.id))
      UNION ALL
      SELECT item.id,item.customer_key,NULL::int,item.channel,item.account_id,'outbound','text',item.raw_status,item.created_at,s.subject,COALESCE(s.message,''),NULL::jsonb
        FROM selected item JOIN sent_messages s ON item.id='legacy-sent-'||s.id AND s.user_id=${userId} AND s.business_profile_id=${scope.businessProfileId}
      UNION ALL
      SELECT item.id,item.customer_key,NULL::int,item.channel,item.account_id,'outbound','text',item.raw_status,item.created_at,j.subject,COALESCE(j.message_body,''),NULL::jsonb
        FROM selected item JOIN outreach_jobs j ON item.id='campaign-job-'||j.id AND j.user_id=${userId} AND j.business_profile_id=${scope.businessProfileId}
      UNION ALL
      SELECT 'legacy-reply-'||s.id,item.customer_key,NULL::int,item.channel,item.account_id,'inbound','text','received',s.reply_received_at,NULL::text,s.reply_content,NULL::jsonb
        FROM selected item JOIN sent_messages s ON item.id='legacy-sent-'||s.id AND s.user_id=${userId} AND s.business_profile_id=${scope.businessProfileId}
        WHERE s.reply_received_at>=item.sent_at AND s.reply_received_at<=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AND NULLIF(s.reply_content,'') IS NOT NULL
    ) SELECT * FROM history ${after ? sql`WHERE (created_at,id)>(${after.createdAt}::timestamp,${after.id})` : sql``} ORDER BY created_at,id ${completeSnapshot ? sql`` : sql`LIMIT ${options.pageSize + 1}`}`);
  const rows = result.rows as Array<Record<string, any>>,
    items: CampaignHistoryMessage[] = (
      completeSnapshot ? rows : rows.slice(0, options.pageSize)
    ).map((row) => ({
      id: row.id,
      customerKey: row.customer_key,
      conversationId: row.conversation_id || null,
      channel: row.channel,
      accountId: row.account_id,
      direction: row.direction,
      type: row.type || "other",
      status: row.status,
      createdAt: date(row.created_at)!,
      subject: row.subject ? redact(row.subject) : null,
      content: redact(row.content),
      selection:
        row.selection &&
        typeof row.selection.kind === "string" &&
        typeof row.selection.title === "string"
          ? { kind: row.selection.kind, title: redact(row.selection.title) }
          : null,
    }));
  const checkedAt = new Date().toISOString();
  return {
    checkedAt,
    businessProfileId: scope.businessProfileId,
    filters,
    customerKey: options.customerKey || null,
    items,
    nextCursor:
      !completeSnapshot && rows.length > options.pageSize
        ? Buffer.from(
            JSON.stringify({
              createdAt: items.at(-1)!.createdAt,
              id: items.at(-1)!.id,
            }),
          ).toString("base64url")
        : null,
    card: {
      title: "Campaign conversation history",
      status: "ready",
      checkedAt,
      businessProfileId: scope.businessProfileId,
      description:
        "Protected values are masked. Conversation responses belong to the selected audience and receiving account after the outreach; this is cohort attribution.",
      metrics: [{ label: "Messages on this page", value: items.length }],
      actions: [
        {
          label: "View conversations",
          href: campaignEngagementUrl(filters, options.customerKey),
        },
      ],
    },
  };
}
