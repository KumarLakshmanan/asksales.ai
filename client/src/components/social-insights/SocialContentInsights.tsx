"use client";

import styles from "@/components/marketing/marketing.module.css";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { previewSources, useSocialMedia } from "./socialMedia";
import { socialPostHref } from "@/lib/socialPostLinks";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  BarChart3,
  CalendarDays,
  ExternalLink,
  Film,
  ImageIcon,
  MessageCircle,
  RefreshCw,
} from "lucide-react";
import { socialInsightsGet } from "@/lib/socialInsightsApi";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { compactMetric as metric } from "@/lib/display-format";

export type ContentItem = {
  id: string;
  platform: string;
  type: string;
  publishedAt: string;
  caption: string;
  permalink: string | null;
  thumbnailUrl: string | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
  children?: Array<{
    id: string;
    type: string;
    mediaUrl: string | null;
    thumbnailUrl: string | null;
  }>;
  metrics: Partial<
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
  metricsUpdatedAt: string | null;
  limitations: string[];
  contributionPercent?: number | null;
};
type PublishingDay = {
  date: string;
  posts: number;
  reels: number;
  stories: number;
  items: Array<{ id: string; type: string; caption: string }>;
};
export type SocialContentData = {
  items: ContentItem[];
  nextOffset: number | null;
  totalPosts: number;
  matchedPosts?: number;
  metricTotals: ContentItem["metrics"];
  metricCoverage: ContentItem["metrics"];
  formats: Array<{
    type: string;
    posts: number;
    metricTotals: ContentItem["metrics"];
    metricCoverage: ContentItem["metrics"];
  }>;
  timeline: PublishingDay[];
  topContent: ContentItem[];
  rankingMetric: keyof ContentItem["metrics"];
  truncated: boolean;
  sync: null | {
    status: string;
    last_succeeded_at: string | null;
    limitations: string[];
  };
};
export type ContentFilters = {
  kind?: string;
  sort?: string;
  q?: string;
  day?: string;
};
const readable = (value: string) => value.replaceAll("_", " ");
const dateLabel = (date: string) =>
  new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

export function useSocialContent(
  credentialId: string,
  platform: string,
  startDate: string,
  endDate: string,
  enabled: boolean,
  revision: number,
) {
  const [data, setData] = useState<SocialContentData | null>(null);
  const [dataScope, setDataScope] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(loading);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  const request = useRef(0);
  const filtersRef = useRef<ContentFilters>({});
  const hasLoadedMore = useRef(false);
  const scope = `${credentialId}:${platform}:${startDate}:${endDate}`;
  const supported = platform === "facebook" || platform === "instagram";
  const load = useCallback(
    async (offset = 0, filters?: ContentFilters) => {
      if (!enabled || !credentialId || !supported) return;
      const id = ++request.current;
      setLoading(true);
      setError(null);
      if (filters) filtersRef.current = filters;
      try {
        const query = new URLSearchParams({
          credentialId,
          platform,
          startDate,
          endDate,
          offset: String(offset),
          ...filtersRef.current,
        });
        const next = await socialInsightsGet<SocialContentData>(
          `/api/social-analytics/content?${query}`,
        );
        if (id !== request.current) return;
        // Defensive shape check also keeps earlier clients usable during rollout.
        if (!next || !Array.isArray(next.items)) return;
        hasLoadedMore.current = offset > 0;
        setDataScope(scope);
        setData((previous) => ({
          ...next,
          items:
            offset && previous
              ? [
                  ...previous.items,
                  ...next.items.filter(
                    (item) => !previous.items.some((old) => old.id === item.id),
                  ),
                ]
              : next.items,
        }));
      } catch (cause) {
        if (id === request.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Posts could not be loaded.",
          );
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [credentialId, enabled, endDate, platform, scope, startDate, supported],
  );
  useEffect(() => {
    filtersRef.current = {};
    hasLoadedMore.current = false;
  }, [scope]);
  useEffect(() => {
    setData(null);
    setDataScope("");
    void load();
    return () => {
      request.current++;
    };
  }, [load, revision]);
  useEffect(() => {
    if (!enabled || !supported) return;
    const timer = setInterval(() => {
      // Preserve older pages while someone is browsing; explicit refresh resets them.
      // Never supersede a read still running (it would be discarded and redone).
      if (document.visibilityState === "visible" && !hasLoadedMore.current && !loadingRef.current)
        void load();
    }, 60_000);
    return () => clearInterval(timer);
  }, [enabled, supported, load]);
  return {
    data: dataScope === scope ? data : null,
    error,
    loading,
    supported,
    load,
  };
}

export function PublishingTrend({
  trends,
  timeline,
  startDate,
  endDate,
}: {
  trends: Array<{ date: string; reach?: number; engagements?: number }>;
  timeline: PublishingDay[];
  startDate: string;
  endDate: string;
}) {
  const byDay = new Map(trends.map((point) => [point.date, point]));
  const publications = new Map(timeline.map((day) => [day.date, day]));
  const points: Array<{
    date: string;
    reach?: number;
    engagements?: number;
    posts: number;
    reels: number;
    stories: number;
    items?: PublishingDay["items"];
  }> = [];
  for (
    let stamp = Date.parse(`${startDate}T00:00:00Z`),
      last = Date.parse(`${endDate}T00:00:00Z`);
    stamp <= last && points.length < 366;
    stamp += 86400000
  ) {
    const date = new Date(stamp).toISOString().slice(0, 10);
    points.push({
      date,
      ...byDay.get(date),
      posts: 0,
      reels: 0,
      stories: 0,
      ...publications.get(date),
    });
  }
  return <div className="space-y-3">
    <div className={styles.twoCharts}>
      <Card className="min-w-0 overflow-hidden"><CardHeader><CardTitle className="text-sm">Organic reach trend</CardTitle><CardDescription>Daily account reach and engagements in the selected period.</CardDescription></CardHeader>
        <CardContent><div className="h-48 min-w-0" role="img" aria-label={`Organic reach, engagements, and publishing activity from ${startDate} through ${endDate}.`}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}><ComposedChart data={points} margin={{ left: -12, right: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))"/><XAxis dataKey="date" tickFormatter={dateLabel} tick={{ fontSize: 10 }}/><YAxis tickFormatter={metric} tick={{ fontSize: 10 }}/><Tooltip labelFormatter={label => `${label} · UTC`}/>
            <Area type="monotone" dataKey="reach" name="Reach" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={.1} connectNulls={false}/><Area type="monotone" dataKey="engagements" name="Engagements" stroke="#10b981" fill="transparent" connectNulls={false}/>
          </ComposedChart></ResponsiveContainer>
        </div><p className="mt-2 text-[10px] text-muted-foreground">● Reach <span className="ml-3 text-emerald-600">● Engagements</span></p></CardContent>
      </Card>
      <Card className="min-w-0 overflow-hidden"><CardHeader><CardTitle className="text-sm">Content publishing activity</CardTitle><CardDescription>Captured posts, reels and stories by publication date (UTC).</CardDescription></CardHeader>
        <CardContent><div className="h-48 min-w-0" role="img" aria-label="Content publishing activity by day">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}><ComposedChart data={points} margin={{ left: -20, right: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))"/><XAxis dataKey="date" tickFormatter={dateLabel} tick={{ fontSize: 10 }}/><YAxis allowDecimals={false} tick={{ fontSize: 10 }}/><Tooltip content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as (typeof points)[number];
              return <div className="max-w-xs rounded-lg border bg-popover p-3 text-xs shadow-lg"><p className="font-medium">{String(label)} · UTC</p><p>{point.posts} posts · {point.reels} reels · {point.stories} stories</p>{point.items?.slice(0, 3).map(item => <p className="mt-1 line-clamp-2" key={item.id}>{readable(item.type)} · {item.caption || "Untitled content"}</p>)}</div>;
            }}/><Bar dataKey="posts" name="Posts" stackId="published" fill="#0ea5e9" maxBarSize={18}/><Bar dataKey="reels" name="Reels" stackId="published" fill="#8b5cf6" maxBarSize={18}/><Bar dataKey="stories" name="Stories" stackId="published" fill="#f59e0b" maxBarSize={18}/>
          </ComposedChart></ResponsiveContainer>
        </div><p className="mt-2 text-[10px] text-muted-foreground">Publication timing supplies context; it does not establish causation.</p></CardContent>
      </Card>
    </div>
            <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">
            Accessible daily values
          </summary>
          <div className="mt-2 max-h-48 overflow-auto">
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reach</th>
                  <th>Engagements</th>
                  <th>Posts</th>
                  <th>Reels</th>
                  <th>Stories</th>
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr className="border-t" key={point.date}>
                    <td>{point.date}</td>
                    <td>{point.reach ?? "—"}</td>
                    <td>{point.engagements ?? "—"}</td>
                    <td>{point.posts}</td>
                    <td>{point.reels}</td>
                    <td>{point.stories}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
  </div>;
}

export function ContentOverview({
  data,
  credentialId,
  onDay,
  onBrowse,
}: {
  data: SocialContentData | null;
  credentialId?: string;
  onDay: (date: string) => void;
  onBrowse: () => void;
}) {
  if (!data) return null;
  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(220px,.75fr)_minmax(0,1.25fr)]">
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4" />
            Publishing activity
          </CardTitle>
          <CardDescription>
            {data.totalPosts} published items in this range. Dates use UTC to
            match the account chart.
          </CardDescription>
        </CardHeader>
        <CardContent className="max-h-[330px] divide-y overflow-y-auto">
          {data.timeline.length ? (
            [...data.timeline].reverse().map((day) => (
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 border-b py-3 text-left text-sm hover:bg-muted"
                key={day.date}
                onClick={() => onDay(day.date)}
              >
                <span className="font-medium">{dateLabel(day.date)}</span>
                <span className="text-right text-muted-foreground">
                  {[
                    day.posts
                      ? `${day.posts} post${day.posts === 1 ? "" : "s"}`
                      : "",
                    day.reels
                      ? `${day.reels} reel${day.reels === 1 ? "" : "s"}`
                      : "",
                    day.stories
                      ? `${day.stories} stor${day.stories === 1 ? "y" : "ies"}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            ))
          ) : (
            <p className="py-5 text-sm text-muted-foreground">
              No published content was captured for this range. Sync to import
              available posts.
            </p>
          )}
        </CardContent>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4" />
            {data.rankingMetric === "profile_visits"
              ? "Posts driving profile visits"
              : "Top content"}
          </CardTitle>
          <CardDescription>
            Ranked by lifetime {readable(data.rankingMetric)} among posts
            published in this range. Percentages describe captured posts, not
            unique visitors or website traffic.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.topContent.length ? (
            data.topContent.map((item, index) => (
              <div
                key={item.id}
                className="flex items-start gap-3 border-b py-4"
              >
                <span className="mt-0.5 text-xs text-muted-foreground">
                  {index + 1}
                </span>
                <ContentThumbnail key={`${credentialId}:${item.id}:${item.thumbnailUrl}`} item={item} credentialId={credentialId} compact />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm">
                    {item.caption ||
                      `${readable(item.type)} · ${dateLabel(item.publishedAt)}`}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {metric(item.metrics[data.rankingMetric])}{" "}
                    {readable(data.rankingMetric)} · {item.contributionPercent}%
                    of captured total
                  </p>
                </div>
                {item.permalink && (
                  <a
                    href={item.permalink}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open top post"
                    className="p-1 text-primary"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            ))
          ) : (
            <p className="py-5 text-sm text-muted-foreground">
              Meta has not returned measurable post performance yet. You can
              still browse published content and comments.
            </p>
          )}
          <Button variant="outline" className="w-full" onClick={onBrowse}>
            Browse posts &amp; comments
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function ContentThumbnail({
  item,
  credentialId,
  compact = false,
}: {
  item: ContentItem;
  credentialId?: string;
  compact?: boolean;
}) {
  const { media, recover, refreshing } = useSocialMedia(item, credentialId);
  const [failed, setFailed] = useState<string[]>([]);
  const src = previewSources(media).find(url => !failed.includes(url));
  useEffect(() => { if (!src) void recover(); }, [src, recover]);
  return (
    <div
      className={`flex shrink-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-border/50 bg-muted/40 ${compact ? "h-14 w-14" : "h-28 w-28 sm:h-36 sm:w-36"}`}
    >
      {src ? (
        <img
          src={src}
          alt="Post preview"
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(previous => [...previous, src])}
        />
      ) : (
        <>
          {["reel", "story", "video"].includes(item.type) ? (
            <Film className="h-6 w-6 text-muted-foreground" />
          ) : (
            <ImageIcon className="h-6 w-6 text-muted-foreground" />
          )}
          {!compact && (
            <span className="px-1 text-center text-[10px] text-muted-foreground">
              {refreshing ? "Refreshing preview…" : "Preview unavailable"}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function subscribeContentLayout(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia("(min-width: 1280px)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const contentLayoutSnapshot = () => typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1280px)").matches;
const contentLayoutServerSnapshot = () => false;

export function ContentFeed({ credentialId, data, loading, error, load, day, clearDay, startDate, endDate }: {
  credentialId: string; data: SocialContentData | null; loading: boolean; error: string | null;
  load: (offset?: number, filters?: ContentFilters) => Promise<void>; day: string | null; clearDay: () => void; startDate?: string; endDate?: string;
}) {
  const [kind, setKind] = useState("all");
  const [sort, setSort] = useState("published");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ContentItem | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const wide = useSyncExternalStore(subscribeContentLayout, contentLayoutSnapshot, contentLayoutServerSnapshot);
  const filtered = data?.items || [];
  const current = filtered.find(item => item.id === selected?.id) || filtered[0];
  useEffect(() => {
    const timer = setTimeout(() => void load(0, { kind, sort, q: query.trim(), ...(day ? { day } : {}) }), 250);
    return () => clearTimeout(timer);
  }, [kind, sort, query, day, load]);
  useEffect(() => { setSelected(null); setCommentsOpen(false); setKind("all"); setSort("published"); setQuery(""); }, [credentialId]);
  const choose = (item: ContentItem) => { setSelected(item); if (!wide) setCommentsOpen(true); };
  const detailsHref = (item: ContentItem) => socialPostHref(item.id, item.platform, credentialId, { startDate, endDate });
  const conversation = current ? <>
    <header><ContentThumbnail credentialId={credentialId} item={current} compact/><div className="min-w-0"><h3>{current.caption || "Post without a caption"}</h3><p className="capitalize">{current.platform} · {dateLabel(current.publishedAt)} · UTC</p></div></header>
    <dl className={styles.contentSummary}>{(["reach", "engagements", "views"] as const).map(key => <div key={key}><dt className="capitalize">{readable(key)}</dt><dd>{metric(current.metrics[key])}</dd></div>)}</dl>
    <div className="flex flex-wrap gap-2"><Button asChild size="sm" variant="outline"><Link href={detailsHref(current)}>View post details <ExternalLink className="ml-2 h-3 w-3"/></Link></Button>{current.permalink && <Button asChild size="sm" variant="ghost"><a href={current.permalink} target="_blank" rel="noreferrer">View on {current.platform === "instagram" ? "Instagram" : "Facebook"}<ExternalLink className="ml-2 h-3 w-3"/></a></Button>}</div>
    <details className="rounded-lg border p-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">More metrics &amp; data availability</summary><dl className="mt-3 grid grid-cols-2 gap-3">{(["likes", "comments", "shares", "profile_visits", "saved", "follows", "clicks"] as const).map(key => <div key={key}><dt className="capitalize">{readable(key)}</dt><dd className="mt-1 font-medium text-foreground">{metric(current.metrics[key])}</dd></div>)}</dl><p className="mt-3">Insights fetched: {current.metricsUpdatedAt ? new Date(current.metricsUpdatedAt).toLocaleString() : "Not available"}. “—” means Meta did not supply this metric.</p>{current.limitations.map(note => <p className="mt-1" key={note}>{note}</p>)}</details>
    {current.type === "story" ? <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">Story comments are unavailable through this reporting connection.</p> : <section aria-label="Selected post conversation"><h3 className="mb-3 text-sm font-semibold">Comments &amp; replies</h3><PostComments key={`${credentialId}:${current.id}`} credentialId={credentialId} item={current}/></section>}
  </> : null;
  return <div className={styles.workspace}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">Posts, reels &amp; stories</h2><p className="mt-1 text-xs text-muted-foreground">{data?.matchedPosts ?? data?.totalPosts ?? 0} matching items · performance is lifetime, last fetched from Meta.</p></div></div>
    <div className="flex flex-wrap gap-2"><Input className="min-w-40 flex-1" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search captions" aria-label="Search content captions"/>
      <Select value={kind} onValueChange={setKind}><SelectTrigger className="w-40" aria-label="Content type"><SelectValue/></SelectTrigger><SelectContent>{["all", "post", "photo", "carousel", "video", "reel", "story"].map(type => <SelectItem key={type} value={type}>{type === "all" ? "All content" : type[0].toUpperCase() + type.slice(1)}</SelectItem>)}</SelectContent></Select>
      <Select value={sort} onValueChange={setSort}><SelectTrigger className="w-40" aria-label="Sort content"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="published">Newest first</SelectItem><SelectItem value="reach">Highest reach</SelectItem><SelectItem value="saved">Most saves</SelectItem><SelectItem value="shares">Most shares</SelectItem><SelectItem value="engagement_rate">Engagement rate</SelectItem><SelectItem value="profile_visits">Profile visits</SelectItem></SelectContent></Select>
    </div>
    {day && <div className="flex items-center justify-between rounded-lg border p-3 text-xs"><span>Published on {dateLabel(day)} (UTC)</span><Button size="sm" variant="ghost" onClick={clearDay}>Show all dates</Button></div>}
    {error && <Callout tone="danger" size="sm" actions={<Button variant="outline" size="sm" onClick={() => void load()}>Retry posts</Button>}>{error}</Callout>}
    {Boolean(data?.sync?.limitations?.length) && <details className="rounded-lg border p-3 text-xs text-muted-foreground"><summary className="cursor-pointer">Sync coverage &amp; availability</summary>{data?.sync?.limitations?.map(note => <p className="mt-2" key={note}>{note}</p>)}</details>}
    {data?.truncated && <p className="text-xs text-amber-600">This range has more than 10,000 captured posts. Narrow the dates to see the remainder.</p>}
    <div className={wide ? styles.contentBrowser : styles.workspace}>
      <div className={styles.contentTable}><div className="overflow-x-auto"><table aria-label="Published content"><thead><tr>{["Content", "Type", "Published (UTC)", "Reach", "Engagements", "Views", "Actions"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{filtered.map(item => <tr key={item.id} aria-selected={current?.id === item.id}>
        <td><button className="flex min-w-44 max-w-72 items-center gap-3 text-left" onClick={() => choose(item)} aria-label={`Select post: ${item.caption || item.type}`}><ContentThumbnail credentialId={credentialId} item={item} compact/><span className="line-clamp-2 text-xs font-medium">{item.caption || "No caption"}</span></button></td>
        <td className="capitalize"><Badge variant="secondary" className="text-[10px]">{item.type}</Badge></td><td className="whitespace-nowrap text-muted-foreground">{dateLabel(item.publishedAt)}</td><td className="tabular-nums">{metric(item.metrics.reach)}</td><td className="tabular-nums">{metric(item.metrics.engagements)}</td><td className="tabular-nums">{metric(item.metrics.views)}</td><td><div className="flex gap-1"><Button asChild variant="ghost" size="icon" aria-label={`View ${item.type} details`}><Link href={detailsHref(item)}><ExternalLink className="h-3.5 w-3.5"/></Link></Button>{item.type !== "story" && <Button variant="ghost" size="sm" onClick={() => choose(item)}><MessageCircle className="mr-1 h-3.5 w-3.5"/>View comments</Button>}</div></td>
      </tr>)}</tbody></table></div>
      {!filtered.length && !loading && <p className="p-8 text-center text-xs text-muted-foreground">No captured content matches this view. Try another date range or sync the account.</p>}
      <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground"><span>{filtered.length} of {data?.matchedPosts ?? data?.totalPosts ?? 0} items</span>{data?.nextOffset != null && <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(data.nextOffset!)}>Load more posts</Button>}{loading && <span role="status">Loading posts…</span>}</div></div>
      {wide && current && <aside className={styles.postConversation} aria-label="Post preview and conversation">{conversation}</aside>}
    </div>
    <Sheet open={!wide && commentsOpen && Boolean(current)} onOpenChange={setCommentsOpen}><SheetContent overlayClassName={styles.drawerOverlay} className={styles.drawer}><SheetHeader><SheetTitle>Post comments</SheetTitle><SheetDescription>Conversation and lifetime measurements for the selected post.</SheetDescription></SheetHeader><div className="mt-5">{conversation}</div></SheetContent></Sheet>
  </div>;
}

type Comment = {
  id: string;
  body: string;
  author: string;
  publishedAt: string | null;
  likes: number | null;
  permalink: string | null;
  replies?: Comment[];
  moreReplies?: boolean;
  repliesNextCursor?: string | null;
  repliesTotal?: number | null;
  isOwn?: boolean;
  source?: string;
  hidden?: boolean;
  canHide?: boolean;
  canReply?: boolean;
  workflowStatus?: string;
};
type CommentCapabilities = {
  reply: boolean;
  moderate: boolean;
  reason: string | null;
};
function CommentText({ comment }: { comment: Comment }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="font-medium">{comment.author}</span>
        {comment.isOwn && (
          <Badge variant="secondary" className="text-[10px]">
            Your account
          </Badge>
        )}
        {comment.source === "sent" && (
          <span className="text-muted-foreground">Sent from AskSales</span>
        )}
        {comment.source === "agent" && (
          <Badge variant="outline" className="text-[10px]">AI agent reply</Badge>
        )}
        <span className="text-muted-foreground">
          {comment.publishedAt
            ? new Date(comment.publishedAt).toLocaleString()
            : ""}
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">
        {comment.body || "Media comment"}
      </p>
      {comment.likes !== null && (
        <p className="text-xs text-muted-foreground">
          {metric(comment.likes)} likes
        </p>
      )}
    </div>
  );
}
export function PostComments({
  credentialId,
  item,
}: {
  credentialId: string;
  item: ContentItem;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitation, setLimitation] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [replyLoading, setReplyLoading] = useState<string | null>(null);
  const [replyError, setReplyError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [accessError, setAccessError] = useState("");
  const [capabilities, setCapabilities] = useState<CommentCapabilities>({
    reply: false,
    moderate: false,
    reason: null,
  });
  const request = useRef(0);
  const load = useCallback(
    async (after?: string) => {
      const id = ++request.current;
      setReplyLoading(null);
      setReplyError(null);
      setLoading(true);
      setError(null);
      try {
        const query = new URLSearchParams({
          credentialId,
          platform: item.platform,
          ...(after ? { after } : {}),
        });
        const result = await socialInsightsGet<{
          comments: Comment[];
          nextCursor: string | null;
          limitation: string;
          capabilities?: CommentCapabilities;
        }>(
          `/api/social-analytics/content/${encodeURIComponent(item.id)}/comments?${query}`,
        );
        if (id !== request.current) return;
        setComments((previous) =>
          after
            ? [
                ...previous,
                ...result.comments.filter(
                  (comment) => !previous.some((old) => old.id === comment.id),
                ),
              ]
            : result.comments,
        );
        setCursor(result.nextCursor);
        setLimitation(result.limitation);
        setCapabilities(
          result.capabilities || {
            reply: false,
            moderate: false,
            reason:
              "Reconnect with comment management permissions to reply or moderate.",
          },
        );
      } catch (cause) {
        if (id === request.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Comments could not be loaded.",
          );
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [credentialId, item.id, item.platform],
  );
  useEffect(() => {
    setComments([]);
    setCursor(null);
    setQuery("");
    setFilter("all");
    void load();
    return () => {
      request.current++;
    };
  }, [load]);
  const loadReplies = async (comment: Comment) => {
    const generation = request.current;
    setReplyLoading(comment.id);
    setReplyError(null);
    try {
      const params = new URLSearchParams({
        credentialId,
        platform: item.platform,
        ...(comment.repliesNextCursor
          ? { after: comment.repliesNextCursor }
          : {}),
      });
      const result = await socialInsightsGet<{
        replies: Comment[];
        nextCursor: string | null;
      }>(
        `/api/social-analytics/content/${encodeURIComponent(item.id)}/comments/${encodeURIComponent(comment.id)}/replies?${params}`,
      );
      if (generation !== request.current) return;
      setComments((previous) =>
        previous.map((row) =>
          row.id === comment.id
            ? {
                ...row,
                replies: [
                  ...(row.replies || []).map((existing) =>
                    result.replies.find((reply) => reply.id === existing.id && reply.source === "agent") || existing,
                  ),
                  ...result.replies.filter(
                    (reply) => !row.replies?.some((old) => old.id === reply.id),
                  ),
                ],
                repliesNextCursor: result.nextCursor,
                moreReplies: Boolean(result.nextCursor),
              }
            : row,
        ),
      );
    } catch (cause) {
      if (generation === request.current)
        setReplyError({
          id: comment.id,
          message:
            cause instanceof Error
              ? cause.message
              : "Replies could not be loaded.",
        });
    } finally {
      if (generation === request.current) setReplyLoading(null);
    }
  };
  const visibleComments = comments.filter((comment) => {
    const matchesSearch =
      !query.trim() ||
      `${comment.author} ${comment.body} ${(comment.replies || []).map((reply) => `${reply.author} ${reply.body}`).join(" ")}`
        .toLowerCase()
        .includes(query.trim().toLowerCase());
    const matchesFilter =
      filter === "all" ||
      (filter === "replies" &&
        Boolean(comment.replies?.length || comment.moreReplies)) ||
      (filter === "liked" && Number(comment.likes || 0) > 0) ||
      (filter === "follow_up" && comment.workflowStatus === "follow_up") ||
      (filter === "escalated" && comment.workflowStatus === "escalated");
    return matchesSearch && matchesFilter;
  });
  return (
    <div className="mt-6 space-y-4">
      <div className="grid gap-2 sm:grid-cols-[1fr_160px]">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search loaded comments"
          aria-label="Search loaded comments"
        />
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger aria-label="Filter loaded comments">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All comments</SelectItem>
            <SelectItem value="replies">With replies</SelectItem>
            <SelectItem value="liked">With likes</SelectItem>
            <SelectItem value="follow_up">Follow-up</SelectItem>
            <SelectItem value="escalated">Escalated</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {capabilities.reason && (
        <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
          <p>{capabilities.reason}</p>
          <Button size="sm" variant="outline" onClick={async () => {
            setAccessError("");
            try {
              const feature = item.platform === "instagram" ? "instagram_manage_comments" : "pages_manage_engagement";
              const result = await api.get<{ url: string }>(`/api/${item.platform}/oauth/authorize?format=json&feature=${feature}`);
              if (!result.url) throw new Error("Comment authorization could not be started.");
              window.location.assign(result.url);
            } catch (cause) {
              setAccessError(cause instanceof Error ? cause.message : "Comment authorization could not be started.");
            }
          }}>Enable comment access</Button>
          {accessError && <p role="alert" className="text-destructive">{accessError}</p>}
        </div>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={loading}
        onClick={() => void load()}
      >
        <RefreshCw className="mr-2 h-3 w-3" />
        Refresh comments
      </Button>
      {limitation && (
        <p className="text-xs text-muted-foreground">{limitation}</p>
      )}
      {error && (
        <Callout
          tone="danger"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load(cursor || undefined)}
            >
              Retry comments
            </Button>
          }
        >
          {error}
        </Callout>
      )}
      {visibleComments.map((comment) => (
        <article
          id={`comment-${comment.id}`}
          key={comment.id}
          className="space-y-3 rounded-xl border bg-background/50 p-4"
        >
          <CommentText comment={comment} />
          <CommentActions
            comment={comment}
            item={item}
            credentialId={credentialId}
            capabilities={capabilities}
            onPublished={() =>
              void loadReplies({ ...comment, repliesNextCursor: null })
            }
            onChange={(patch) =>
              setComments((previous) =>
                previous.map((row) =>
                  row.id === comment.id ? { ...row, ...patch } : row,
                ),
              )
            }
          />
          {comment.replies?.map((reply) => (
            <div className="ml-3 border-l pl-3" key={reply.id}>
              <CommentText comment={reply} />
            </div>
          ))}
          {comment.moreReplies && (
            <Button
              variant="ghost"
              size="sm"
              disabled={Boolean(replyLoading) || loading}
              onClick={() => void loadReplies(comment)}
            >
              {replyLoading === comment.id
                ? "Loading replies…"
                : "Load more replies"}
            </Button>
          )}
          {replyError?.id === comment.id && (
            <p role="alert" className="text-xs text-destructive">
              {replyError.message}
            </p>
          )}
        </article>
      ))}
      {!loading && !error && !comments.length && (
        <p className="py-6 text-sm text-muted-foreground">
          Meta returned no visible comments for this post.
        </p>
      )}
      {!loading && !error && comments.length > 0 && !visibleComments.length && (
        <p className="py-6 text-sm text-muted-foreground">
          No loaded comment matches this search and filter.
        </p>
      )}
      {loading && (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Spinner size="sm" label={null} />
          Loading comments…
        </p>
      )}
      {cursor && (
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          Load more comments
        </Button>
      )}
    </div>
  );
}

function CommentActions({
  comment,
  item,
  credentialId,
  capabilities,
  onChange,
  onPublished,
}: {
  comment: Comment;
  item: ContentItem;
  credentialId: string;
  capabilities: CommentCapabilities;
  onChange: (patch: Partial<Comment>) => void;
  onPublished: () => void;
}) {
  const [action, setAction] = useState<"reply" | "hide" | "unhide" | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const receipt = useRef<{ payload: string; key: string } | null>(null);
  const submit = async (next: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice("");
    const payload = JSON.stringify([next, message.trim()]);
    if (!receipt.current || receipt.current.payload !== payload)
      receipt.current = { payload, key: crypto.randomUUID() };
    try {
      const result = await api.post<{
        status?: string;
        success?: boolean;
        hidden?: boolean | null;
      }>(
        `/api/social-analytics/content/${encodeURIComponent(item.id)}/comments/${encodeURIComponent(comment.id)}/actions`,
        {
          credentialId,
          platform: item.platform,
          action: next,
          ...(next === "reply" ? { message: message.trim() } : {}),
          idempotencyKey: receipt.current.key,
        },
      );
      if (result.status) onChange({ workflowStatus: result.status });
      else if (typeof result.hidden === "boolean")
        onChange({ hidden: result.hidden });
      setNotice(
        next === "reply"
          ? "Reply published."
          : next === "hide" || next === "unhide"
            ? result.hidden === null
              ? "Meta accepted the action. Refresh comments to confirm visibility."
              : result.hidden
                ? "Comment hidden. It may remain visible to its author."
                : "Meta reports this comment is visible."
            : "Comment status saved.",
      );
      if (next === "reply") onPublished();
      setAction(null);
      setMessage("");
      receipt.current = null;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The action could not be confirmed. Check the original post before retrying.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {comment.hidden && <Badge variant="secondary">Hidden</Badge>}
        {comment.workflowStatus && comment.workflowStatus !== "open" && (
          <Badge variant="secondary">{readable(comment.workflowStatus)}</Badge>
        )}
        {capabilities.reply && comment.canReply !== false && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setAction("reply");
              setError(null);
            }}
          >
            Reply
          </Button>
        )}
        {capabilities.moderate && comment.canHide !== false && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setAction(comment.hidden ? "unhide" : "hide");
              setError(null);
            }}
          >
            {comment.hidden ? "Unhide" : "Hide"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || comment.workflowStatus === "follow_up"}
          onClick={() => void submit("follow_up")}
        >
          Follow up
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || comment.workflowStatus === "escalated"}
          onClick={() => void submit("escalate")}
        >
          Escalate
        </Button>
        {comment.workflowStatus &&
          !["open", "resolved"].includes(comment.workflowStatus) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void submit("resolve")}
            >
              Resolve
            </Button>
          )}
      </div>
      {action && (
        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          {action === "reply" ? (
            <>
              <label
                className="text-xs font-medium"
                htmlFor={`reply-${comment.id}`}
              >
                Public reply from your connected account
              </label>
              <textarea
                id={`reply-${comment.id}`}
                maxLength={2000}
                rows={3}
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                disabled={busy}
              />
            </>
          ) : (
            <p className="text-sm">
              {action === "hide"
                ? "Hide this comment on the original post? The author may still be able to see it."
                : "Make this comment visible again on the original post?"}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || (action === "reply" && !message.trim())}
              onClick={() => void submit(action)}
            >
              {busy
                ? "Saving…"
                : action === "reply"
                  ? "Publish reply"
                  : action === "hide"
                    ? "Confirm hide"
                    : "Confirm unhide"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setAction(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      <p className="text-[10px] text-muted-foreground">
        Follow-up and escalation are internal review statuses; they do not send
        messages.
      </p>
    </div>
  );
}
