import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { channelCredentialsTable } from "../models/channelCredentials/schema.js";
import { isValidIsoDate } from "./socialAnalyticsController.js";
import { commentCapabilities } from "./socialEngagementController.js";
import {
  createMetaInsightsClient,
  MetaInsightsError,
  record,
  records,
} from "../services/social/MetaInsightsClient.js";
import { contentFromRow, contentMetricValues, normalizeContent } from "../services/social/SocialContentInsightsService.js";
import { findInstagramConnectionForUserAndAccount } from "../models/metaPageConnections/functions.js";
import { httpsUrlOrNull as safeUrl } from "../utils/httpsUrl.js";

const owner = (req: Request) =>
  businessOwnerUserId(req);
async function ownedCredential(userId: number, value: unknown) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return (
    (
      await db
        .select()
        .from(channelCredentialsTable)
        .where(
          and(
            eq(channelCredentialsTable.id, id),
            eq(channelCredentialsTable.userId, userId),
            eq(channelCredentialsTable.isActive, true),
          ),
        )
        .limit(1)
    )[0] || null
  );
}
const credentialMatchesPlatform = (
  credentialPlatform: string,
  platform: unknown,
) =>
  platform === "facebook"
    ? ["facebook_api", "facebook_page"].includes(credentialPlatform)
    : platform === "instagram"
      ? credentialPlatform === "instagram_api"
      : false;
export async function listSocialContent(req: Request, res: Response) {
  const userId = owner(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const credential = await ownedCredential(userId, req.query.credentialId);
  const platform = req.query.platform;
  if (platform !== "facebook" && platform !== "instagram")
    return res
      .status(400)
      .json({ error: "Facebook or Instagram is required." });
  if (!credential || !credentialMatchesPlatform(credential.platform, platform))
    return res.status(404).json({ error: "Social account not found." });
  const start = req.query.startDate;
  const end = req.query.endDate;
  const offset = Number(req.query.offset || 0);
  if (
    !isValidIsoDate(start) ||
    !isValidIsoDate(end) ||
    start > end ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1_000_000
  )
    return res
      .status(400)
      .json({ error: "A valid date range and offset are required." });
  const kind = String(req.query.kind || "all");
  const sort = String(req.query.sort || "published");
  const query = String(req.query.q || "").trim();
  const day = req.query.day;
  if (
    !["all", "post", "photo", "carousel", "video", "reel", "story"].includes(
      kind,
    ) ||
    ![
      "published",
      "reach",
      "saved",
      "shares",
      "engagement_rate",
      "profile_visits",
    ].includes(sort) ||
    query.length > 500 ||
    (day !== undefined && (!isValidIsoDate(day) || day < start || day > end))
  )
    return res.status(400).json({ error: "Invalid content filters." });
  const base = sql`user_id=${userId} AND credential_id=${credential.id} AND published_at>=${start}::date AND published_at<${end}::date+INTERVAL '1 day'`;
  const filters = sql`${base} AND (${kind}='all' OR content_type=${kind}) AND (${query}='' OR POSITION(LOWER(${query}) IN LOWER(caption))>0)`;
  if (day)
    filters.append(
      sql` AND published_at>=${day}::date AND published_at<${day}::date+INTERVAL '1 day'`,
    );
  const order =
    sort === "published"
      ? sql`published_at DESC`
      : sort === "engagement_rate"
        ? sql`CASE WHEN (metrics->>'reach')::numeric>0 THEN (metrics->>'engagements')::numeric/(metrics->>'reach')::numeric END DESC NULLS LAST`
        : sql`(metrics->>${sort})::numeric DESC NULLS LAST`;
  const [page, counts, aggregate, timeline, syncResult] = await Promise.all([
    db.execute(
      sql`SELECT * FROM social_content_items WHERE ${filters} ORDER BY ${order},published_at DESC,provider_id DESC LIMIT 51 OFFSET ${offset}`,
    ),
    db.execute(
      sql`SELECT COUNT(*)::int AS count FROM social_content_items WHERE ${filters}`,
    ),
    db.execute(sql`WITH selected AS (SELECT content_type,metrics FROM social_content_items WHERE ${base}),
      groups AS (SELECT content_type AS type,COUNT(*)::int AS posts FROM selected GROUP BY content_type),
      measurements AS (SELECT content_type AS type,key,SUM(value::text::numeric) AS total,COUNT(*)::int AS coverage FROM selected CROSS JOIN LATERAL jsonb_each(metrics) WHERE jsonb_typeof(value)='number' GROUP BY content_type,key)
      SELECT groups.*,COALESCE((SELECT jsonb_object_agg(key,total) FROM measurements WHERE measurements.type=groups.type),'{}') AS metric_totals,
      COALESCE((SELECT jsonb_object_agg(key,coverage) FROM measurements WHERE measurements.type=groups.type),'{}') AS metric_coverage FROM groups`),
    db.execute(sql`SELECT TO_CHAR(published_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,
      COUNT(*) FILTER (WHERE content_type NOT IN ('reel','story'))::int AS posts,
      COUNT(*) FILTER (WHERE content_type='reel')::int AS reels,COUNT(*) FILTER (WHERE content_type='story')::int AS stories
      FROM social_content_items WHERE ${base} GROUP BY 1 ORDER BY 1`),
    db.execute(
      sql`SELECT status,last_attempt_at,last_succeeded_at,window_start,window_end,limitations FROM social_content_syncs WHERE user_id=${userId} AND credential_id=${credential.id}`,
    ),
  ]);
  const metricTotals: Record<string, number> = {};
  const metricCoverage: Record<string, number> = {};
  const formats = records(aggregate.rows).map((row) => {
    for (const [key, value] of Object.entries(record(row.metric_totals)))
      metricTotals[key] = (metricTotals[key] || 0) + Number(value);
    for (const [key, value] of Object.entries(record(row.metric_coverage)))
      metricCoverage[key] = (metricCoverage[key] || 0) + Number(value);
    return {
      type: String(row.type),
      posts: Number(row.posts),
      metricTotals: record(row.metric_totals),
      metricCoverage: record(row.metric_coverage),
    };
  });
  const rankingMetric =
    metricTotals.profile_visits > 0
      ? "profile_visits"
      : metricTotals.views > 0
        ? "views"
        : "likes";
  const top = await db.execute(
    sql`SELECT * FROM social_content_items WHERE ${base} AND (metrics->>${rankingMetric})::numeric>0 ORDER BY (metrics->>${rankingMetric})::numeric DESC,provider_id DESC LIMIT 5`,
  );
  return res.json({
    items: records(page.rows)
      .slice(0, 50)
      .map((row) => contentFromRow(row)),
    nextOffset: page.rows.length > 50 ? offset + 50 : null,
    matchedPosts: Number(counts.rows[0]?.count || 0),
    totalPosts: formats.reduce((sum, row) => sum + row.posts, 0),
    metricTotals,
    metricCoverage,
    formats,
    rankingMetric,
    topContent: records(top.rows).map((row) => ({
      ...contentFromRow(row),
      contributionPercent:
        Math.round(
          (Number(record(row.metrics)[rankingMetric]) /
            metricTotals[rankingMetric]) *
            1000,
        ) / 10,
    })),
    timeline: records(timeline.rows).map((row) => ({ ...row, items: [] })),
    sync: syncResult.rows[0] || null,
    truncated: false,
  });
}

const validCursor = (value: unknown) =>
  value === undefined ||
  (typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !Array.from(value).some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f) &&
    !/^https?:/i.test(value));
const nextCursor = (pagingValue: unknown, current?: unknown) => {
  const paging = record(pagingValue);
  const cursor = record(paging.cursors).after;
  return paging.next &&
    typeof cursor === "string" &&
    validCursor(cursor) &&
    cursor !== current
    ? cursor
    : null;
};

export async function getSocialContent(req: Request, res: Response) {
  const userId = owner(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const platform = req.query.platform;
  if (platform !== "facebook" && platform !== "instagram")
    return res
      .status(400)
      .json({ error: "Facebook or Instagram is required." });
  const credential = await ownedCredential(userId, req.query.credentialId);
  const postId = String(req.params.id || "");
  if (
    !credential ||
    !credentialMatchesPlatform(credential.platform, platform) ||
    !/^[\d_]+$/.test(postId)
  )
    return res.status(404).json({ error: "Social content not found." });
  const row = (
    await db.execute(
      sql`SELECT * FROM social_content_items WHERE user_id=${userId} AND credential_id=${credential.id} AND platform=${platform} AND provider_id=${postId} LIMIT 1`,
    )
  ).rows[0];
  if (!row) return res.status(404).json({ error: "Social content not found." });
  let item = contentFromRow(row);
  if (req.query.refreshMetrics === "1") {
    try {
      const graph = await createMetaInsightsClient(userId, credential.id);
      if (graph.platform !== platform) return res.status(404).json({ error: "Social account not found." });
      const requested = platform === "facebook"
        ? ["post_media_view", "post_total_media_view_unique", "post_clicks"]
        : item.type === "story"
          ? ["views", "reach", "total_interactions"]
          : ["views", "reach", "total_interactions", "saved", "shares", "profile_visits", "follows"];
      let measured = {} as ReturnType<typeof contentMetricValues>;
      try {
        measured = contentMetricValues(await graph.request(`${postId}/insights`, {
          metric: requested.join(","), ...(platform === "facebook" ? { period: "lifetime" } : {}),
        }));
      } catch (error) {
        if (!(error instanceof MetaInsightsError) || error.code !== "SOCIAL_METRIC_UNAVAILABLE") throw error;
        for (const metric of requested) {
          try {
            Object.assign(measured, contentMetricValues(await graph.request(`${postId}/insights`, {
              metric, ...(platform === "facebook" ? { period: "lifetime" } : {}),
            })));
          } catch (metricError) {
            if (metricError instanceof MetaInsightsError && metricError.code === "SOCIAL_METRIC_UNAVAILABLE") continue;
            throw metricError;
          }
        }
      }
      if (Object.keys(measured).length) {
        item = { ...item, metrics: { ...item.metrics, ...measured }, metricsUpdatedAt: new Date().toISOString() };
        await db.execute(sql`UPDATE social_content_items SET metrics=metrics || ${JSON.stringify(measured)}::jsonb,
          metrics_updated_at=NOW(), updated_at=NOW()
          WHERE user_id=${userId} AND credential_id=${credential.id} AND platform=${platform} AND provider_id=${postId}`);
      } else {
        item = { ...item, limitations: [...item.limitations, "Meta did not provide insights for this post. Engagement counts may still be available."] };
      }
    } catch (error) {
      item = { ...item, limitations: [...item.limitations,
        error instanceof MetaInsightsError && error.code === "SOCIAL_ANALYTICS_PERMISSION_REQUIRED"
          ? "Reconnect this account with insights access to refresh performance."
          : "Post insights could not be refreshed. Try again later."] };
    }
  }
  // Refresh signed CDN links only on demand, after verifying account ownership.
  if (req.query.refreshMedia === "1" && platform === "instagram") {
    try {
      const graph = await createMetaInsightsClient(userId, credential.id);
      const media = await graph.request(postId, {
        fields: "id,media_type,media_url,thumbnail_url,children{id,media_type,media_url,thumbnail_url}",
      });
      const fresh = normalizeContent(platform, {
        ...media, id: postId, timestamp: item.publishedAt,
      });
      if (fresh) {
        item = { ...item, mediaUrl: fresh.mediaUrl, thumbnailUrl: fresh.thumbnailUrl,
          mediaType: fresh.mediaType, children: fresh.children };
        await db.execute(sql`UPDATE social_content_items SET thumbnail_url=${item.thumbnailUrl},
          media_url=${item.mediaUrl || null},media_type=${item.mediaType || null},
          media_children=${JSON.stringify(item.children || [])}::jsonb
          WHERE user_id=${userId} AND credential_id=${credential.id} AND provider_id=${postId} AND platform=${platform}`);
      }
    } catch (error) {
      return res.status(error instanceof MetaInsightsError ? error.status : 503).json({
        error: error instanceof MetaInsightsError ? error.message : "Media preview could not be refreshed.",
        code: error instanceof MetaInsightsError ? error.code : "SOCIAL_MEDIA_UNAVAILABLE",
      });
    }
  }
  const instagramProfile = platform === "instagram" && credential.accountIdentifier
    ? await findInstagramConnectionForUserAndAccount(userId, credential.accountIdentifier).catch(() => null)
    : null;
  return res.json({
    item,
    account: {
      id: credential.id,
      platform,
      name: instagramProfile?.pageName || credential.accountName || credential.accountIdentifier,
      identifier: credential.accountIdentifier,
      pictureUrl: safeUrl(instagramProfile?.instagramProfilePicture),
    },
    capabilities: commentCapabilities(platform, credential.grantedScopes),
  });
}

type CommentIdentity = {
  platform: string;
  accountIdentifier?: string | null;
  accountName?: string | null;
};
export function normalizeSocialComment(
  row: Record<string, unknown>,
  identity: CommentIdentity,
  permalink: unknown,
  workflows: Record<string, unknown>[] = [],
) {
  const from = record(row.from);
  const ownId = String(identity.accountIdentifier || "");
  const username = String(row.username || from.username || "")
    .replace(/^@/, "")
    .toLowerCase();
  const ownUsername = String(identity.accountName || "")
    .replace(/^@/, "")
    .toLowerCase();
  const isOwn =
    Boolean(ownId && String(from.id || "") === ownId) ||
    (identity.platform === "instagram" &&
      Boolean(
        username &&
        /^[a-z0-9._]+$/.test(ownUsername) &&
        username === ownUsername,
      ));
  return {
    id: String(row.id),
    body: String(row.text || row.message || ""),
    author: String(
      row.username || from.username || from.name || "Facebook / Instagram user",
    ),
    publishedAt: row.timestamp || row.created_time || null,
    likes: typeof row.like_count === "number" ? row.like_count : null,
    permalink: safeUrl(row.permalink_url) || safeUrl(permalink),
    hidden: row.hidden === true || row.is_hidden === true,
    canHide: row.can_hide !== false,
    canReply: row.can_comment !== false,
    workflowStatus:
      workflows.find((workflow) => workflow.comment_id === row.id)?.status ||
      "open",
    isOwn,
    source: "provider" as "provider" | "sent" | "agent",
  };
}

export function mergeSentReplies(
  replies: ReturnType<typeof normalizeSocialComment>[],
  receipts: Record<string, unknown>[],
  commentId: string,
  identity: CommentIdentity,
  permalink: unknown,
) {
  const result = [...replies];
  for (const receipt of receipts) {
    if (receipt.comment_id !== commentId) continue;
    const sent = record(receipt.result);
    const id = String(sent.providerId || "");
    if (
      !/^[\d_]+$/.test(id) ||
      typeof sent.body !== "string" ||
      result.some((reply) => reply.id === id)
    )
      continue;
    result.push({
      ...normalizeSocialComment(
        {
          id,
          text: sent.body,
          timestamp: sent.publishedAt || receipt.created_at,
          username: identity.accountName || "Your account",
        },
        identity,
        permalink,
      ),
      isOwn: true,
      source: "sent",
      canHide: false,
      canReply: false,
    });
  }
  return result;
}

export function mergeAgentReplies(
  replies: ReturnType<typeof normalizeSocialComment>[],
  receipts: Record<string, unknown>[],
  commentId: string,
  identity: CommentIdentity,
  permalink: unknown,
) {
  const result = [...replies];
  for (const receipt of receipts) {
    if (String(receipt.comment_id) !== commentId) continue;
    const id = String(receipt.provider_message_id || "");
    const body = receipt.body;
    if (!/^[\d_]+$/.test(id) || typeof body !== "string" || !body.trim()) continue;
    const existing = result.findIndex((reply) => reply.id === id);
    if (existing >= 0) {
      result[existing] = { ...result[existing], isOwn: true, source: "agent" };
      continue;
    }
    result.push({
      ...normalizeSocialComment(
        { id, text: body, timestamp: receipt.sent_at, username: identity.accountName || "Your account" },
        identity,
        permalink,
      ),
      isOwn: true,
      source: "agent",
      canHide: false,
      canReply: false,
    });
  }
  return result;
}

async function socialContentConversation(
  req: Request,
  res: Response,
  repliesOnly: boolean,
) {
  const userId = owner(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const platform = req.query.platform;
  if (platform !== "facebook" && platform !== "instagram")
    return res
      .status(400)
      .json({ error: "Facebook or Instagram is required." });
  const credential = await ownedCredential(userId, req.query.credentialId);
  const postId = String(req.params.id || "");
  const commentId = String(req.params.commentId || "");
  const after = req.query.after;
  if (
    !credential ||
    !credentialMatchesPlatform(credential.platform, platform) ||
    !/^[\d_]+$/.test(postId) ||
    (repliesOnly && !/^[\d_]+$/.test(commentId))
  )
    return res.status(404).json({ error: "Social content not found." });
  if (!validCursor(after))
    return res.status(400).json({ error: "Invalid comments cursor." });
  const item = (
    await db.execute(
      sql`SELECT permalink,content_type FROM social_content_items WHERE user_id=${userId} AND credential_id=${credential.id} AND platform=${platform} AND provider_id=${postId} LIMIT 1`,
    )
  ).rows[0];
  if (!item)
    return res.status(404).json({ error: "Social content not found." });
  if (item.content_type === "story")
    return res.json({
      ...(repliesOnly ? { replies: [] } : { comments: [] }),
      nextCursor: null,
      capabilities: {
        reply: false,
        moderate: false,
        reason:
          "Story replies are private messages and are not available through this reporting connection.",
      },
      limitation:
        "Story replies are private messages and are not available through this reporting connection.",
    });
  try {
    const graph = await createMetaInsightsClient(userId, credential.id);
    if (graph.platform !== platform)
      return res.status(404).json({ error: "Social account not found." });
    const instagram = platform === "instagram";
    if (repliesOnly) {
      const comment = await graph.request(commentId, {
        fields: instagram ? "id,media" : "id,object",
      });
      if (
        String(record(instagram ? comment.media : comment.object).id || "") !==
        postId
      )
        return res
          .status(404)
          .json({
            error: "This comment does not belong to the selected post.",
          });
    }
    const replyFields = instagram
      ? "id,text,timestamp,username,from,like_count,hidden"
      : "id,message,created_time,from,like_count,permalink_url,is_hidden,can_hide,can_comment";
    const fields = repliesOnly
      ? replyFields
      : instagram
        ? `${replyFields},replies.limit(10){${replyFields}}`
        : `${replyFields},comment_count,comments.limit(10){${replyFields}}`;
    const path = repliesOnly
      ? `${commentId}/${instagram ? "replies" : "comments"}`
      : `${postId}/comments`;
    const params = { limit: "50", ...(typeof after === "string" ? { after } : {}) };
    let response;
    let reducedFields = false;
    try {
      response = await graph.request(path, { fields, ...params });
    } catch (error) {
      // Optional metadata / nested reply expansion must not hide the thread.
      // Never retry permission, authentication, or rate-limit failures.
      if (!(error instanceof MetaInsightsError) || error.code !== "SOCIAL_METRIC_UNAVAILABLE") throw error;
      reducedFields = true;
      const basicFields = instagram ? "id,text,timestamp,username" : "id,message,created_time,from";
      response = await graph.request(path, { fields: basicFields, ...params });
    }
    const providerComments = records(response.data);
    const parentIds = repliesOnly ? [commentId] : providerComments.map((row) => String(row.id));
    const [workflowRows, receiptRows, agentRows] = await Promise.all([
      db.execute(
        sql`SELECT comment_id,status FROM social_comment_workflows WHERE user_id=${userId} AND credential_id=${credential.id} AND post_id=${postId}`,
      ),
      db.execute(
        sql`SELECT comment_id,result,created_at FROM social_comment_actions WHERE user_id=${userId} AND credential_id=${credential.id} AND post_id=${postId} AND action='reply' AND status='succeeded' ORDER BY created_at`,
      ),
      parentIds.length
        ? db.execute(sql`SELECT o.inbound_provider_message_id AS comment_id, o.provider_message_id,
            o.payload->>'text' AS body, o.sent_at
            FROM support_delivery_outbox o
            JOIN outreach_messages m ON m.delivery_action_id=o.id AND m.user_id=o.user_id AND m.is_ai_generated=TRUE
            WHERE o.user_id=${userId} AND o.channel=${`${platform}_comment`}
              AND o.status='sent' AND o.provider_message_id IS NOT NULL
              AND o.inbound_provider_message_id IN (${sql.join(parentIds.map((id) => sql`${id}`), sql`,`)})
            ORDER BY o.sent_at`)
        : Promise.resolve({ rows: [] }),
    ]);
    const workflows = records(workflowRows.rows);
    const receipts = records(receiptRows.rows);
    const agentReceipts = records(agentRows.rows);
    const identity = { ...credential, platform };
    const normalize = (row: Record<string, unknown>) =>
      normalizeSocialComment(row, identity, item.permalink, workflows);
    const comments = providerComments.map((row) => {
      const replies = record(row.replies || row.comments);
      const cursor = nextCursor(replies.paging);
      return {
        ...normalize(row),
        replies: mergeAgentReplies(
          mergeSentReplies(records(replies.data).map(normalize), receipts, String(row.id), identity, item.permalink),
          agentReceipts, String(row.id), identity, item.permalink,
        ),
        moreReplies: Boolean(cursor) || (reducedFields && !repliesOnly),
        repliesNextCursor: cursor,
        repliesTotal:
          typeof row.comment_count === "number" ? row.comment_count : null,
      };
    });
    return res.json({
      ...(repliesOnly
        ? {
            replies: mergeAgentReplies(
              mergeSentReplies(providerComments.map(normalize), receipts, commentId, identity, item.permalink),
              agentReceipts, commentId, identity, item.permalink,
            ),
          }
        : { comments }),
      capabilities: commentCapabilities(platform, credential.grantedScopes),
      nextCursor: nextCursor(response.paging, after),
      limitation:
        "Meta returns comments and replies visible to this connected account. Removed, hidden, or restricted conversations may be unavailable.",
    });
  } catch (error) {
    return res
      .status(error instanceof MetaInsightsError ? error.status : 503)
      .json({
        error:
          error instanceof MetaInsightsError
            ? error.message
            : "Comments are temporarily unavailable. Try again shortly.",
        code:
          error instanceof MetaInsightsError
            ? error.code
            : "SOCIAL_COMMENTS_UNAVAILABLE",
      });
  }
}

export async function listSocialContentComments(req: Request, res: Response) {
  return socialContentConversation(req, res, false);
}
export async function listSocialContentReplies(req: Request, res: Response) {
  return socialContentConversation(req, res, true);
}

export async function getSocialSyncJob(req: Request, res: Response) {
  const userId = owner(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const { queueRegistry, QUEUE_NAMES } = await import("../queues/index.js");
  const job = await queueRegistry
    .getQueue(QUEUE_NAMES.PERFORMANCE_SYNC)
    .getJob(String(req.params.id));
  if (
    !job ||
    job.data.userId !== userId ||
    job.data.type !== "social-account-sync"
  )
    return res.status(404).json({ error: "Sync not found." });
  const state = await job.getState();
  return res.json({
    state,
    ...(state === "completed" ? { result: job.returnvalue } : {}),
    ...(state === "failed"
      ? {
          error:
            "The sync could not finish. Saved data is still available. Try again.",
        }
      : {}),
  });
}
