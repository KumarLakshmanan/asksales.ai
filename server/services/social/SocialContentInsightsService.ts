import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import {
  createMetaInsightsClient,
  MetaInsightsError,
  record,
  records,
  type MetaRecord,
} from "./MetaInsightsClient.js";
import { httpsUrlOrNull as httpsUrl } from "../../utils/httpsUrl.js";

export type ContentMetrics = Partial<
  Record<
    | "views"
    | "reach"
    | "likes"
    | "comments"
    | "shares"
    | "engagements"
    | "saved"
    | "clicks"
    | "profile_visits"
    | "follows",
    number
  >
>;
export type SocialContentItem = {
  id: string;
  platform: "facebook" | "instagram";
  type: string;
  publishedAt: string;
  caption: string;
  permalink: string | null;
  thumbnailUrl: string | null;
  providerMediaId?: string | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
  children?: Array<{
    id: string;
    type: string;
    mediaUrl: string | null;
    thumbnailUrl: string | null;
  }>;
  metrics: ContentMetrics;
  metricsUpdatedAt: string | null;
  limitations: string[];
};
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const METRICS: Record<string, keyof ContentMetrics> = {
  views: "views",
  post_media_view: "views",
  reach: "reach",
  post_total_media_view_unique: "reach",
  total_interactions: "engagements",
  likes: "likes",
  comments: "comments",
  shares: "shares",
  saved: "saved",
  profile_visits: "profile_visits",
  follows: "follows",
  post_clicks: "clicks",
};
export function contentMetricValues(payload: unknown): ContentMetrics {
  const result: ContentMetrics = {};
  for (const row of records(record(payload).data)) {
    const key = METRICS[String(row.name)];
    const value =
      number(record(row.total_value).value) ??
      number(records(row.values)[0]?.value);
    if (key && value !== undefined) result[key] = value;
  }
  return result;
}
export function normalizeContent(
  platform: "facebook" | "instagram",
  row: MetaRecord,
  story = false,
): SocialContentItem | null {
  const id = String(row.id || "");
  const date = String(row.timestamp || row.created_time || "");
  if (!/^[\d_]+$/.test(id) || !Number.isFinite(Date.parse(date))) return null;
  const attachment = records(record(row.attachments).data)[0] || {};
  const kind = String(row.media_product_type || "").toUpperCase();
  const type =
    story || kind === "STORY"
      ? "story"
      : kind === "REELS"
        ? "reel"
        : row.media_type === "CAROUSEL_ALBUM" ||
            records(record(attachment.subattachments).data).length > 1
          ? "carousel"
          : row.media_type === "VIDEO" || attachment.media_type === "video"
            ? "video"
            : row.media_type === "IMAGE" || attachment.media_type === "photo"
              ? "photo"
              : "post";
  const metrics: ContentMetrics = {};
  const likes =
    number(row.like_count) ??
    number(record(record(row.reactions).summary).total_count);
  const comments =
    number(row.comments_count) ??
    number(record(record(row.comments).summary).total_count);
  const shares = number(record(row.shares).count);
  if (likes !== undefined) metrics.likes = likes;
  if (comments !== undefined) metrics.comments = comments;
  if (shares !== undefined) metrics.shares = shares;
  return {
    id,
    platform,
    type,
    publishedAt: new Date(date).toISOString(),
    caption: String(row.caption || row.message || attachment.title || "").slice(
      0,
      30_000,
    ),
    permalink: httpsUrl(row.permalink || row.permalink_url),
    thumbnailUrl: httpsUrl(
      row.thumbnail_url ||
        row.full_picture ||
        record(record(attachment.media).image).src ||
        (row.media_type !== "VIDEO" ? row.media_url : null),
    ),
    mediaUrl: httpsUrl(
      row.media_url ||
        row.source ||
        record(attachment.media).source ||
        (attachment.media_type !== "video"
          ? record(record(attachment.media).image).src
          : null),
    ),
    mediaType: String(row.media_type || attachment.media_type || "") || null,
    providerMediaId:
      platform === "facebook"
        ? String(record(attachment.target).id || (type === "reel" ? id : "")) ||
          null
        : null,
    children: records(record(row.children).data)
      .map((child) => ({
        id: String(child.id || ""),
        type: String(child.media_type || "IMAGE").toLowerCase(),
        mediaUrl: httpsUrl(child.media_url),
        thumbnailUrl: httpsUrl(
          child.thumbnail_url ||
            (child.media_type !== "VIDEO" ? child.media_url : null),
        ),
      }))
      .concat(
        records(record(attachment.subattachments).data).map((child) => ({
          id: String(record(child.target).id || ""),
          type: String(child.media_type || "photo"),
          mediaUrl: httpsUrl(
            record(child.media).source ||
              (child.media_type !== "video"
                ? record(record(child.media).image).src
                : null),
          ),
          thumbnailUrl: httpsUrl(record(record(child.media).image).src),
        })),
      ),
    metrics,
    metricsUpdatedAt: null,
    limitations: [],
  };
}

export function normalizeOfficialListeningComment(
  platform: "facebook" | "instagram",
  item: Pick<SocialContentItem, "id" | "permalink">,
  comment: MetaRecord,
): {
  providerEventId: string;
  publicUrl: string | null;
  author: string | null;
  body: string;
  occurredAt: string;
} | null {
  const providerEventId = String(comment.id || "");
  const body = String(comment.text || comment.message || "").trim();
  const occurredAt = String(comment.timestamp || comment.created_time || "");
  if (
    !/^[\d_]+$/.test(providerEventId) ||
    !body ||
    !Number.isFinite(Date.parse(occurredAt))
  )
    return null;
  const author =
    platform === "instagram"
      ? String(comment.username || "").trim()
      : String(record(comment.from).name || "").trim();
  return {
    providerEventId,
    publicUrl: httpsUrl(comment.permalink_url) || item.permalink,
    author: author || null,
    body: body.slice(0, 20_000),
    occurredAt: new Date(occurredAt).toISOString(),
  };
}

const publicError = (error: unknown) =>
  error instanceof MetaInsightsError
    ? error.message
    : "Some content could not be refreshed. Previously saved content is still available.";
const shouldStop = (error: unknown) =>
  error instanceof MetaInsightsError &&
  [
    "SOCIAL_PROVIDER_RATE_LIMITED",
    "SOCIAL_ANALYTICS_RECONNECT_REQUIRED",
  ].includes(error.code);

export async function collectOfficialCommentPages(
  graph: {
    platform: string;
    request: (
      path: string,
      query: Record<string, string>,
    ) => Promise<MetaRecord>;
  },
  postId: string,
  onComment: (comment: MetaRecord) => Promise<void>,
  maxPages = 10,
  resume?: {
    after?: string;
    onCursor: (after: string | null) => Promise<void>;
  },
) {
  let after: string | undefined = resume?.after,
    count = 0;
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const response = await graph.request(`${postId}/comments`, {
      fields:
        graph.platform === "instagram"
          ? "id,text,username,timestamp,like_count"
          : "id,message,created_time,from,permalink_url",
      limit: "50",
      ...(after ? { after } : {}),
    });
    const comments = records(response.data);
    for (const comment of comments) {
      await onComment(comment);
      count++;
    }
    const paging = record(response.paging),
      next = record(paging.cursors).after;
    if (!paging.next || typeof next !== "string" || !comments.length) {
      await resume?.onCursor(null);
      return { count, truncated: false };
    }
    // Persist only provider-issued cursors, never provider next URLs.
    if (seen.has(next) || next === after) {
      await resume?.onCursor(null);
      return { count, truncated: true };
    }
    await resume?.onCursor(next);
    if (page === maxPages - 1) return { count, truncated: true };
    seen.add(next);
    after = next;
  }
  return { count, truncated: true };
}

/** Discover account history in bounded pages independently of the selected
 * reporting window. Daily cycles also recover content missed during outages. */
export async function discoverSocialContentHistory(
  userId: number,
  credentialId: number,
  graph: Pick<
    Awaited<ReturnType<typeof createMetaInsightsClient>>,
    "platform" | "credential" | "request"
  >,
) {
  const saved = await db.execute(
    sql`SELECT discovery_state FROM social_content_syncs WHERE user_id=${userId} AND credential_id=${credentialId}`,
  );
  const state = record(records(record(saved).rows)[0]?.discovery_state);
  let captured = 0;
  const pending: string[] = [];
  const errors: string[] = [];
  let stopped: unknown;
  for (const edge of graph.platform === "instagram"
    ? ["media"]
    : ["published_posts", "video_reels"]) {
    let checkpoint = record(state[edge]);
    const freshOnly =
      checkpoint.complete === true &&
      Date.now() - Date.parse(String(checkpoint.completedAt || "")) <
        86_400_000;
    if (checkpoint.complete === true && !freshOnly) checkpoint = {};
    let after =
      typeof checkpoint.after === "string" ? checkpoint.after : undefined;
    let scanned = Number(checkpoint.scanned || 0);
    const seen = new Set<string>();
    try {
      for (let page = 0; page < 2; page++) {
        const fields =
          graph.platform === "instagram"
            ? "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count,children{id,media_type,media_url,thumbnail_url}"
            : edge === "video_reels"
              ? "id,description,created_time,permalink_url,picture"
              : "id,message,created_time,permalink_url,full_picture,attachments{media_type,type,title,target{id},media,subattachments{media_type,target{id},media}},shares,comments.limit(0).summary(true),reactions.limit(0).summary(true)";
        const response = await graph.request(
          `${graph.credential.accountIdentifier}/${edge}`,
          // Always refresh page one for newly published content, then resume
          // older discovery at its persisted cursor on the second request.
          { fields, limit: "50", ...(page > 0 && after ? { after } : {}) },
        );
        const rows = records(response.data);
        for (const row of rows) {
          const item = normalizeContent(
            graph.platform,
            edge === "video_reels"
              ? {
                  ...row,
                  message: row.description,
                  full_picture: row.picture,
                  media_product_type: "REELS",
                  permalink_url:
                    typeof row.permalink_url === "string" &&
                    row.permalink_url.startsWith("/reel/")
                      ? `https://www.facebook.com${row.permalink_url}`
                      : row.permalink_url,
                }
              : row,
          );
          if (!item) continue;
          await saveContent(userId, credentialId, item, true);
          captured++;
        }
        const paging = record(response.paging),
          next = record(paging.cursors).after;
        const exhausted =
          !paging.next || typeof next !== "string" || !rows.length;
        if (page === 0 && freshOnly) break;
        if (page === 0 && after && !exhausted) continue;
        scanned += rows.length;
        const repeated =
          !exhausted &&
          (seen.has(next as string) || (page > 0 && next === after));
        state[edge] = {
          after: exhausted || repeated ? null : next,
          scanned,
          complete: exhausted,
          completedAt: exhausted ? new Date().toISOString() : null,
        };
        await db.execute(
          sql`UPDATE social_content_syncs SET discovery_state=${JSON.stringify(state)}::jsonb WHERE user_id=${userId} AND credential_id=${credentialId}`,
        );
        if (exhausted) break;
        if (repeated) {
          errors.push(
            `${edge}: Meta repeated a discovery cursor; this edge will restart on the next sync.`,
          );
          break;
        }
        seen.add(next as string);
        after = next as string;
      }
    } catch (error) {
      errors.push(publicError(error));
      // An expired cursor should restart discovery; rate limits preserve it.
      if (after && !shouldStop(error)) {
        state[edge] = { ...record(state[edge]), after: null, complete: false };
        await db.execute(
          sql`UPDATE social_content_syncs SET discovery_state=${JSON.stringify(state)}::jsonb WHERE user_id=${userId} AND credential_id=${credentialId}`,
        );
      }
      if (shouldStop(error)) {
        stopped = error;
        break;
      }
    }
    if (record(state[edge]).complete !== true) pending.push(edge);
  }
  const finished = (
    graph.platform === "instagram"
      ? ["media"]
      : ["published_posts", "video_reels"]
  ).every((edge) => record(state[edge]).complete === true);
  return { captured, complete: finished, pending, errors, stopped };
}

export async function synchronizeSocialContent(
  userId: number,
  credentialId: number,
  startDate: string,
  endDate: string,
) {
  const graph = await createMetaInsightsClient(userId, credentialId);
  await db.execute(sql`INSERT INTO social_content_syncs (credential_id, user_id, status, window_start, window_end) VALUES (${credentialId},${userId},'running',${startDate}::date,${endDate}::date)
    ON CONFLICT (credential_id) DO UPDATE SET status='running', last_attempt_at=NOW(), window_start=EXCLUDED.window_start, window_end=EXCLUDED.window_end`);
  const limitations = new Set<string>();
  if (graph.platform === "instagram")
    limitations.add(
      "Stories are available only while Meta exposes them, usually for 24 hours. Previously captured stories remain in this list.",
    );
  else
    limitations.add(
      "Facebook may return posts and reactions without Page or post insights. Missing metrics are shown as unavailable.",
    );
  const items = new Map<string, SocialContentItem>();
  const facebookTargets = new Map<string, string>();
  let complete = true;
  try {
    for (const edge of graph.platform === "instagram"
      ? ["media", "stories"]
      : ["published_posts", "video_reels", "stories"]) {
      let after: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 100; page++) {
        let fields =
          graph.platform === "instagram"
            ? "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count"
            : "id,message,created_time,permalink_url,full_picture,attachments{media_type,type,title,target{id},media,subattachments{media_type,target{id},media}},shares,comments.limit(0).summary(true),reactions.limit(0).summary(true)";
        if (graph.platform === "instagram" && edge === "media")
          fields += ",children{id,media_type,media_url,thumbnail_url}";
        if (graph.platform === "facebook" && edge !== "published_posts")
          fields = "id,description,created_time,permalink_url,picture";
        let response: MetaRecord;
        try {
          response = await graph.request(
            `${graph.credential.accountIdentifier}/${edge}`,
            {
              fields,
              limit: "50",
              ...(after ? { after } : {}),
              ...(graph.platform === "facebook"
                ? {
                    since: startDate,
                    until: String(
                      Math.floor(
                        new Date(`${endDate}T23:59:59.999Z`).getTime() / 1000,
                      ) + 1,
                    ),
                  }
                : {}),
            },
          );
        } catch (error) {
          if (
            (edge === "stories" || edge === "video_reels") &&
            !shouldStop(error)
          ) {
            limitations.add(
              `${edge === "stories" ? "Stories" : "Reels"}: ${publicError(error)}`,
            );
            complete = false;
            break;
          }
          throw error;
        }
        const rows = records(response.data);
        for (const row of rows) {
          const normalizedRow =
            graph.platform === "facebook" && edge !== "published_posts"
              ? {
                  ...row,
                  message: row.description,
                  full_picture: row.picture,
                  permalink_url:
                    typeof row.permalink_url === "string" &&
                    row.permalink_url.startsWith("/reel/")
                      ? `https://www.facebook.com${row.permalink_url}`
                      : row.permalink_url,
                  media_product_type:
                    edge === "video_reels" ? "REELS" : "STORY",
                }
              : row;
          const item = normalizeContent(
            graph.platform,
            normalizedRow,
            edge === "stories",
          );
          if (
            item &&
            (edge === "stories" ||
              (item.publishedAt.slice(0, 10) >= startDate &&
                item.publishedAt.slice(0, 10) <= endDate))
          ) {
            const target = String(
              record(records(record(row.attachments).data)[0]?.target).id || "",
            );
            if (target) facebookTargets.set(target, item.id);
            const existingId =
              edge === "video_reels" ? facebookTargets.get(item.id) : undefined;
            if (existingId && items.has(existingId))
              items.get(existingId)!.type = "reel";
            else items.set(item.id, item);
          }
        }
        // Instagram media is reverse chronological. Stories can include active
        // items outside yesterday's account measurement window; the UI can include today.
        const dates = rows
          .map((row) =>
            String(row.timestamp || row.created_time || "").slice(0, 10),
          )
          .filter(Boolean);
        if (dates.length && dates.every((date) => date < startDate)) break;
        const paging = record(response.paging);
        const cursor = record(paging.cursors).after;
        if (!paging.next || typeof cursor !== "string" || !rows.length) break;
        if (seen.has(cursor) || page === 99) {
          complete = false;
          limitations.add(
            "Meta returned more content than this sync could finish. Narrow the date range to retrieve the remaining posts.",
          );
          break;
        }
        seen.add(cursor);
        after = cursor;
      }
    }
    // Bounded concurrency avoids serial per-post requests timing out a worker.
    const pending = [...items.values()];
    let cursor = 0;
    let stopped: unknown;
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (cursor < pending.length && !stopped) {
          const item = pending[cursor++];
          const requested =
            graph.platform === "facebook"
              ? [
                  "post_media_view",
                  "post_total_media_view_unique",
                  "post_clicks",
                ]
              : item.type === "story"
                ? ["views", "reach", "total_interactions"]
                : [
                    "views",
                    "reach",
                    "total_interactions",
                    "saved",
                    "shares",
                    "profile_visits",
                    "follows",
                  ];
          let measured: ContentMetrics = {};
          try {
            try {
              measured = contentMetricValues(
                await graph.request(`${item.id}/insights`, {
                  metric: requested.join(","),
                  ...(graph.platform === "facebook"
                    ? { period: "lifetime" }
                    : {}),
                }),
              );
            } catch (error) {
              if (
                !(error instanceof MetaInsightsError) ||
                error.code !== "SOCIAL_METRIC_UNAVAILABLE"
              )
                throw error;
              for (const metric of requested) {
                try {
                  Object.assign(
                    measured,
                    contentMetricValues(
                      await graph.request(`${item.id}/insights`, {
                        metric,
                        ...(graph.platform === "facebook"
                          ? { period: "lifetime" }
                          : {}),
                      }),
                    ),
                  );
                } catch (metricError) {
                  if (shouldStop(metricError)) throw metricError;
                }
              }
            }
            if (Object.keys(measured).length)
              item.metricsUpdatedAt = new Date().toISOString();
            else
              item.limitations.push(
                "Meta returned no post insights. Reaction and comment counts may still be available.",
              );
          } catch (error) {
            item.limitations.push(publicError(error));
            complete = false;
            if (shouldStop(error)) stopped = error;
          }
          item.metrics = { ...item.metrics, ...measured };
          await saveContent(userId, credentialId, item);
        }
      }),
    );
    if (stopped) {
      complete = false;
      limitations.add(publicError(stopped));
    }
    // Keep publication history even when an insights rate limit halted enrichment.
    for (const item of pending.slice(cursor)) {
      item.limitations.push("Post insights await the next sync.");
      await saveContent(userId, credentialId, item);
    }
    if (!stopped) {
      const discovery = await discoverSocialContentHistory(
        userId,
        credentialId,
        graph,
      );
      limitations.add(
        discovery.complete
          ? `Account history discovery completed its latest pass through content exposed by Meta. Listening includes all captured posts and reels; ${discovery.captured} items were refreshed in this discovery batch.`
          : `Account history discovery is in progress: ${discovery.captured} items were refreshed in this batch. Older posts are collected automatically over subsequent syncs, up to 100 items per content edge per batch.`,
      );
      if (discovery.stopped) {
        stopped = discovery.stopped;
        complete = false;
      }
      for (const error of discovery.errors)
        limitations.add(`History discovery: ${error}`);
    }
    // Rotate over all captured posts, including older posts outside this metrics
    // window. Unchecked posts lead, then least recently attempted posts. Saved
    // comment cursors continue on the next sync instead of repeating page one.
    const coverageResult = await db.execute(
      sql`SELECT COUNT(*)::int AS total FROM social_content_items WHERE user_id=${userId} AND credential_id=${credentialId} AND content_type <> 'story'`,
    );
    const eligibleCount = Number(
      records(record(coverageResult).rows)[0]?.total || 0,
    );
    const batchResult = await db.execute(
      sql`SELECT * FROM social_content_items WHERE user_id=${userId} AND credential_id=${credentialId} AND content_type <> 'story' ORDER BY listening_attempted_at ASC NULLS FIRST,published_at DESC,provider_id LIMIT 100`,
    );
    const listeningPosts = records(record(batchResult).rows);
    let listeningFailures = 0,
      listeningComments = 0,
      listeningTruncated = 0,
      listeningCursor = 0;
    let listeningStopped = stopped;
    await Promise.all(
      Array.from({ length: Math.min(3, listeningPosts.length) }, async () => {
        while (listeningCursor < listeningPosts.length && !listeningStopped) {
          const stored = listeningPosts[listeningCursor++];
          const item = contentFromRow(stored);
          await db.execute(
            sql`UPDATE social_content_items SET listening_attempted_at=NOW() WHERE user_id=${userId} AND credential_id=${credentialId} AND provider_id=${item.id}`,
          );
          try {
            const collection = await collectOfficialCommentPages(
              graph,
              item.id,
              async (comment) => {
                const normalizedComment = normalizeOfficialListeningComment(
                  graph.platform,
                  item,
                  comment,
                );
                if (!normalizedComment) return;
                await db.execute(sql`INSERT INTO social_listening_events (user_id,platform,provider_event_id,public_url,author_handle,body,occurred_at,sentiment,metadata,source)
            VALUES (${userId},${graph.platform},${normalizedComment.providerEventId},${normalizedComment.publicUrl},${normalizedComment.author},${normalizedComment.body},${normalizedComment.occurredAt}::timestamptz,'unknown',${JSON.stringify({ contentId: item.id, collection: "owned_post_comments", credentialId })}::jsonb,'official_api')
            ON CONFLICT (business_profile_id, user_id,platform,provider_event_id) DO UPDATE SET body=EXCLUDED.body,public_url=EXCLUDED.public_url,author_handle=EXCLUDED.author_handle,metadata=social_listening_events.metadata || EXCLUDED.metadata`);
                listeningComments++;
              },
              10,
              {
                after:
                  typeof stored.listening_after === "string"
                    ? stored.listening_after
                    : undefined,
                onCursor: async (after) => {
                  await db.execute(
                    sql`UPDATE social_content_items SET listening_after=${after},listening_completed_at=CASE WHEN ${after === null} THEN NOW() ELSE listening_completed_at END WHERE user_id=${userId} AND credential_id=${credentialId} AND provider_id=${item.id}`,
                  );
                },
              },
            );
            if (collection.truncated) listeningTruncated++;
          } catch (error) {
            listeningFailures += 1;
            if (stored.listening_after && !shouldStop(error))
              await db.execute(
                sql`UPDATE social_content_items SET listening_after=NULL WHERE user_id=${userId} AND credential_id=${credentialId} AND provider_id=${item.id}`,
              );
            if (shouldStop(error)) listeningStopped = error;
          }
        }
      }),
    );
    limitations.add(
      `Official listening checked ${listeningComments} comments across ${listeningCursor} of ${eligibleCount} captured posts and reels in this sync, up to 500 comments per post per batch. All captured posts are included in the rotating collection. Story replies are private messages and are not exposed through this reporting connection.`,
    );
    if (listeningTruncated || eligibleCount > 100)
      limitations.add(
        `Listening collection reached its safety limit: ${listeningTruncated} posts have more comments and ${Math.max(0, eligibleCount - listeningCursor)} posts were outside this sync batch. Remaining posts and comment pages continue automatically on subsequent syncs. Open a post for its live conversation.`,
      );
    if (listeningFailures)
      limitations.add(
        `Comments from ${listeningFailures} post${listeningFailures === 1 ? "" : "s"} could not be collected for listening and will be retried by a later sync.`,
      );
    if (listeningStopped)
      limitations.add(`Listening paused: ${publicError(listeningStopped)}`);
    // Only official account-tagged content is queried; do not treat this as
    // arbitrary public keyword search or add others' posts to owned metrics.
    try {
      if (listeningStopped) throw listeningStopped;
      let after: string | undefined,
        taggedCount = 0;
      const seen = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const response = await graph.request(
          `${graph.credential.accountIdentifier}/${graph.platform === "instagram" ? "tags" : "tagged"}`,
          {
            fields:
              graph.platform === "instagram"
                ? "id,caption,timestamp,permalink,username"
                : "id,message,created_time,permalink_url,from",
            limit: "50",
            ...(after ? { after } : {}),
            ...(graph.platform === "instagram"
              ? {
                  posted_after: startDate,
                  posted_before: `${endDate}T23:59:59Z`,
                }
              : { since: startDate, until: `${endDate}T23:59:59Z` }),
          },
        );
        const rows = records(response.data);
        for (const row of rows) {
          const entry = normalizeOfficialListeningComment(
            graph.platform,
            {
              id: String(row.id),
              permalink: httpsUrl(row.permalink || row.permalink_url),
            },
            { ...row, text: row.caption || row.message },
          );
          if (
            !entry ||
            entry.occurredAt.slice(0, 10) < startDate ||
            entry.occurredAt.slice(0, 10) > endDate
          )
            continue;
          await db.execute(sql`INSERT INTO social_listening_events(user_id,platform,provider_event_id,public_url,author_handle,body,occurred_at,sentiment,metadata,source)
            VALUES(${userId},${graph.platform},${`${credentialId}:tagged:${entry.providerEventId}`},${entry.publicUrl},${entry.author},${entry.body},${entry.occurredAt}::timestamptz,'unknown',${JSON.stringify({ credentialId, contentId: entry.providerEventId, collection: "account_tagged_content" })}::jsonb,'official_api')
            ON CONFLICT(business_profile_id, user_id,platform,provider_event_id) DO NOTHING`);
          taggedCount++;
        }
        const paging = record(response.paging),
          next = record(paging.cursors).after;
        if (!paging.next || typeof next !== "string" || !rows.length) break;
        if (page === 9 || seen.has(next)) {
          limitations.add(
            "Tagged-content collection reached its 500-item safety limit. Narrow the sync dates for additional coverage.",
          );
          break;
        }
        seen.add(next);
        after = next;
      }
      limitations.add(
        `Official listening also captured ${taggedCount} tagged posts in the selected period. These appear under Tagged posts, separately from comments. Tags are limited to what Meta exposes to this connection.`,
      );
    } catch (error) {
      limitations.add(
        `Tagged content is unavailable for this connection: ${publicError(error)}`,
      );
    }
  } catch (error) {
    complete = false;
    limitations.add(publicError(error));
  }
  await db.execute(
    sql`UPDATE social_content_syncs SET status=${complete ? "succeeded" : "partial"}, last_succeeded_at=CASE WHEN ${complete} THEN NOW() ELSE last_succeeded_at END, limitations=${JSON.stringify([...limitations])}::jsonb WHERE credential_id=${credentialId} AND user_id=${userId}`,
  );
  return { count: items.size, complete, limitations: [...limitations] };
}

async function saveContent(
  userId: number,
  credentialId: number,
  item: SocialContentItem,
  metadataOnly = false,
) {
  if (item.platform === "facebook" && item.providerMediaId) {
    // A Facebook published post and its video_reels entry can have different
    // IDs for the same media. Reuse the first captured owned identity.
    const aliases = await db.execute(
      sql`SELECT provider_id FROM social_content_items WHERE user_id=${userId} AND credential_id=${credentialId} AND (provider_id=${item.id} OR provider_media_id=${item.providerMediaId} OR provider_id=${item.providerMediaId}) ORDER BY CASE WHEN provider_id=${item.id} THEN 0 ELSE 1 END LIMIT 1`,
    );
    const existing = records(record(aliases).rows)[0];
    if (existing?.provider_id)
      item = { ...item, id: String(existing.provider_id) };
  }
  await db.execute(sql`INSERT INTO social_content_items (user_id,credential_id,provider_id,platform,content_type,published_at,caption,permalink,thumbnail_url,media_url,media_type,media_children,provider_media_id,metrics,metrics_updated_at,limitations)
    VALUES (${userId},${credentialId},${item.id},${item.platform},${item.type},${item.publishedAt}::timestamptz,${item.caption},${item.permalink},${item.thumbnailUrl},${item.mediaUrl || null},${item.mediaType || null},${JSON.stringify(item.children || [])}::jsonb,${item.providerMediaId || null},${JSON.stringify(item.metrics)}::jsonb,${item.metricsUpdatedAt}::timestamptz,${JSON.stringify(item.limitations)}::jsonb)
    ON CONFLICT (credential_id,provider_id) DO UPDATE SET content_type=CASE WHEN social_content_items.content_type='reel' THEN 'reel' ELSE EXCLUDED.content_type END,published_at=EXCLUDED.published_at,caption=CASE WHEN EXCLUDED.caption='' THEN social_content_items.caption ELSE EXCLUDED.caption END,permalink=COALESCE(EXCLUDED.permalink,social_content_items.permalink),thumbnail_url=COALESCE(EXCLUDED.thumbnail_url,social_content_items.thumbnail_url),media_url=COALESCE(EXCLUDED.media_url,social_content_items.media_url),media_type=COALESCE(EXCLUDED.media_type,social_content_items.media_type),media_children=CASE WHEN jsonb_array_length(EXCLUDED.media_children)>0 THEN EXCLUDED.media_children ELSE social_content_items.media_children END,provider_media_id=COALESCE(EXCLUDED.provider_media_id,social_content_items.provider_media_id),
    metrics=social_content_items.metrics || EXCLUDED.metrics,metrics_updated_at=COALESCE(EXCLUDED.metrics_updated_at,social_content_items.metrics_updated_at),limitations=CASE WHEN ${metadataOnly} THEN social_content_items.limitations ELSE EXCLUDED.limitations END,updated_at=NOW()`);
}

export function contentFromRow(row: MetaRecord): SocialContentItem {
  return {
    id: String(row.provider_id),
    platform: row.platform as "facebook" | "instagram",
    type: String(row.content_type),
    publishedAt: new Date(String(row.published_at)).toISOString(),
    caption: String(row.caption || ""),
    permalink: httpsUrl(row.permalink),
    thumbnailUrl: httpsUrl(row.thumbnail_url),
    mediaUrl: httpsUrl(row.media_url),
    mediaType: typeof row.media_type === "string" ? row.media_type : null,
    children: records(row.media_children).map((child) => ({
      id: String(child.id || ""),
      type: String(child.type || "image"),
      mediaUrl: httpsUrl(child.mediaUrl),
      thumbnailUrl: httpsUrl(child.thumbnailUrl),
    })),
    metrics: record(row.metrics) as ContentMetrics,
    metricsUpdatedAt: row.metrics_updated_at
      ? new Date(String(row.metrics_updated_at)).toISOString()
      : null,
    limitations: Array.isArray(row.limitations)
      ? row.limitations.map(String)
      : [],
  };
}

export function summarizeContent(items: SocialContentItem[]) {
  const timeline = new Map<
    string,
    {
      date: string;
      posts: number;
      reels: number;
      stories: number;
      items: Array<{ id: string; type: string; caption: string }>;
    }
  >();
  for (const item of items) {
    const date = item.publishedAt.slice(0, 10);
    const day = timeline.get(date) || {
      date,
      posts: 0,
      reels: 0,
      stories: 0,
      items: [],
    };
    if (item.type === "story") day.stories++;
    else if (item.type === "reel") day.reels++;
    else day.posts++;
    day.items.push({
      id: item.id,
      type: item.type,
      caption: item.caption.slice(0, 140),
    });
    timeline.set(date, day);
  }
  const metric = items.some((item) => (item.metrics.profile_visits || 0) > 0)
    ? "profile_visits"
    : items.some((item) => (item.metrics.views || 0) > 0)
      ? "views"
      : "likes";
  const ranked = items
    .filter((item) => (item.metrics[metric] || 0) > 0)
    .sort((a, b) => (b.metrics[metric] || 0) - (a.metrics[metric] || 0));
  const total = ranked.reduce(
    (sum, item) => sum + (item.metrics[metric] || 0),
    0,
  );
  return {
    timeline: [...timeline.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    ),
    topContent: ranked.slice(0, 5).map((item) => ({
      ...item,
      contributionPercent: total
        ? Math.round(((item.metrics[metric] || 0) / total) * 1000) / 10
        : null,
    })),
    rankingMetric: metric,
    totalPosts: items.length,
  };
}
