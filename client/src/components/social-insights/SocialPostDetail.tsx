"use client";

import styles from "@/components/marketing/marketing.module.css";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ImageOff,
  MessageCircle,
  RefreshCw,
} from "lucide-react";
import { socialInsightsGet } from "@/lib/socialInsightsApi";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PageShell } from "@/components/ui/page-shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PostComments, type ContentItem } from "./SocialContentInsights";
import { useSocialMedia } from "./socialMedia";
import { SocialListeningPanel } from "./SocialListeningPanel";

type Detail = {
  item: ContentItem;
  account: {
    id: number | string;
    name: string;
    identifier: string;
    platform: string;
    pictureUrl?: string | null;
  };
};
const labels: Record<string, string> = {
  views: "Views",
  reach: "Reach",
  engagements: "Engagements",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  saved: "Saves",
  profile_visits: "Profile visits",
  follows: "Follows",
  clicks: "Clicks",
};
const format = (value?: number) =>
  value == null
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
        value,
      );

export function SocialPostDetail({
  postId,
  credentialId,
  platform,
  startDate,
  endDate,
}: {
  postId: string;
  credentialId: string;
  platform: string;
  startDate: string;
  endDate: string;
}) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const request = useRef(0);
  const valid =
    /^[\d_]+$/.test(postId) &&
    /^\d+$/.test(credentialId) &&
    ["instagram", "facebook"].includes(platform);
  const backQuery = new URLSearchParams({
    platform,
    account: credentialId,
    tab: "content",
  });
  if (startDate) backQuery.set("start", startDate);
  if (endDate) backQuery.set("end", endDate);
  const backHref = `/dashboard/marketing/analytics?${backQuery}`;
  const load = useCallback(async () => {
    const id = ++request.current;
    if (!valid) {
      setError("Choose a post from a connected Facebook or Instagram account.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ credentialId, platform, refreshMetrics: "1" });
      const result = await socialInsightsGet<Detail>(
        `/api/social-analytics/content/${encodeURIComponent(postId)}?${query}`,
      );
      if (id === request.current) setData(result);
    } catch (cause) {
      if (id === request.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "This post could not be loaded.",
        );
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [postId, credentialId, platform, valid]);
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [load]);
  const item = error || loading ? undefined : data?.item;
  const platformName = platform === "facebook" ? "Facebook" : "Instagram";
  const engagementRate =
    item?.metrics.reach && item.metrics.engagements != null
      ? (item.metrics.engagements / item.metrics.reach) * 100
      : null;
  return (
    <PageShell maxWidth="2xl" className={`${styles.surface} mx-0`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" className="-ml-3">
          <Link href={backHref}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to posts
          </Link>
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || !valid}
          onClick={() => {
            void load();
            setRevision((value) => value + 1);
          }}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`}
          />
          Refresh page
        </Button>
      </div>
      {error && (
        <Callout
          tone="danger"
          actions={
            <Button variant="outline" onClick={() => void load()}>
              Retry post
            </Button>
          }
        >
          {error}
        </Callout>
      )}
      {!item && loading && (
        <div
          role="status"
          className="rounded-2xl border p-12 text-center text-muted-foreground"
        >
          Loading post and performance…
        </div>
      )}
      {item && data && (
        <>
          <header className={`${styles.header} flex flex-wrap items-center justify-between gap-3`}>
            <div className="flex min-w-0 items-center gap-3">
              <Avatar className="h-12 w-12 shrink-0 border">
                {data.account.pictureUrl && <AvatarImage src={data.account.pictureUrl} alt="" referrerPolicy="no-referrer" />}
                <AvatarFallback className="bg-primary/10 font-semibold text-primary">
                  {(data.account.name || platformName).slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  {platformName} ·{" "}
                  <span className="capitalize">{item.type}</span>
                </p>
                <h1 className="mt-1 break-words text-xl font-semibold sm:text-2xl">
                  {data.account.name || "Post details"}
                </h1>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <time
                className="text-muted-foreground"
                dateTime={item.publishedAt}
              >
                {new Date(item.publishedAt).toLocaleString()}
              </time>
              {item.permalink && (
                <Button asChild variant="outline" size="sm">
                  <a href={item.permalink} target="_blank" rel="noreferrer">
                    View on {platformName}
                    <ExternalLink className="ml-2 h-3.5 w-3.5" />
                  </a>
                </Button>
              )}
            </div>
          </header>
          <div className={styles.postThreeColumns}>
            <article className="min-w-0 overflow-hidden rounded-2xl border bg-card">
              <PostMedia key={`${credentialId}:${item.id}:${item.mediaUrl}`} item={item} credentialId={credentialId} />
              <div className="space-y-3 p-4">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="capitalize">
                    {item.type}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    Published content
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words text-xs leading-6">
                  {item.caption || "This post has no caption."}
                </p>
              </div>
            </article>
            <section
              aria-label="Post conversation"
              className="min-w-0 rounded-xl border bg-card p-4 xl:max-h-[calc(100dvh-12rem)] xl:overflow-y-auto"
            >
              <div className="flex items-center gap-2">
                <MessageCircle className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold">Conversation</h2>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Comments and replies stay together here. Replies from your
                connected account are marked “Your account”; published agent replies are labeled.
              </p>
              {item.type === "story" ? (
                <div className="mt-5 rounded-xl border bg-muted/30 p-5">
                  <h3 className="font-medium">
                    Story replies are private messages
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    This reporting connection provides story performance, but
                    does not provide story replies or reactions. View those in
                    your {platformName} inbox. Previously captured story metrics
                    remain available below.
                  </p>
                  {item.permalink && (
                    <Button asChild variant="outline" className="mt-4">
                      <a href={item.permalink} target="_blank" rel="noreferrer">
                        Open story on {platformName}
                        <ExternalLink className="ml-2 h-4 w-4" />
                      </a>
                    </Button>
                  )}
                </div>
              ) : (
                <Tabs defaultValue="comments" className="mt-5">
                  <TabsList className="h-auto max-w-full flex-wrap">
                    <TabsTrigger value="comments">
                      Comments &amp; replies
                    </TabsTrigger>
                    <TabsTrigger value="listening">
                      Listening review
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="comments">
                    <PostComments
                      key={`${credentialId}:${item.id}:${revision}`}
                      credentialId={credentialId}
                      item={item}
                    />
                  </TabsContent>
                  <TabsContent value="listening" className="mt-5">
                    <SocialListeningPanel
                      postId={item.id}
                      platform={platform}
                      credentialId={credentialId}
                      startDate={startDate}
                      endDate={endDate}
                      revision={revision}
                    />
                  </TabsContent>
                </Tabs>
              )}
            </section>
          <section
            aria-labelledby="post-performance-heading"
            className="min-w-0 rounded-xl border bg-card p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2
                  id="post-performance-heading"
                  className="text-lg font-semibold"
                >
                  Post performance
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Lifetime metrics for this {item.type}, last captured from{" "}
                  {platformName}.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Updated{" "}
                {item.metricsUpdatedAt
                  ? new Date(item.metricsUpdatedAt).toLocaleString()
                  : "when Meta supplies metrics"}
              </p>
            </div>
            {item.limitations.length > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">{item.limitations.join(" ")}</p>
            )}
            <dl className="mt-5 grid grid-cols-2 gap-3">
              {Object.entries(labels).map(([key, label]) => (
                <div
                  key={key}
                  className="min-w-0 border-l-2 border-primary/20 pl-4"
                >
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-words text-2xl font-semibold tabular-nums">
                    {format(item.metrics[key as keyof ContentItem["metrics"]])}
                  </dd>
                </div>
              ))}
              <div className="border-l-2 border-primary/20 pl-4">
                <dt className="text-xs text-muted-foreground">
                  Engagement rate
                </dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">
                  {engagementRate == null ? "—" : `${format(engagementRate)}%`}
                </dd>
              </div>
            </dl>
            <p className="mt-6 text-xs leading-5 text-muted-foreground">
              “—” means Meta did not provide this metric. Engagement rate is
              engagements divided by reach; it is unavailable when either
              measurement is missing.
            </p>
            {item.limitations.length > 0 && (
              <details className="mt-4 text-sm text-muted-foreground">
                <summary className="cursor-pointer">
                  Metric availability
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {item.limitations.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>
          </div>
        </>
      )}
    </PageShell>
  );
}

function PostMedia({ item: savedItem, credentialId }: { item: ContentItem; credentialId: string }) {
  const { media: item, recover, refreshing } = useSocialMedia(savedItem, credentialId);
  const [index, setIndex] = useState(0);
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const media = item.children?.length
    ? item.children
    : [
        {
          id: item.id,
          type: item.mediaType || item.type,
          mediaUrl: item.mediaUrl || null,
          thumbnailUrl: item.thumbnailUrl,
        },
      ];
  const current = media[Math.min(index, media.length - 1)];
  const video = /video|reel/i.test(current.type);
  const src = [current.mediaUrl, current.thumbnailUrl].find(url => url && !failedSources.includes(url));
  const failed = failedSources.length > 0;
  useEffect(() => { if (!src) void recover(); }, [src, recover]);
  return (
    <div className="relative bg-muted/50">
      <div
        className={`flex min-h-48 items-center justify-center ${item.type === "story" ? "aspect-[9/12] max-h-[680px]" : "aspect-[4/3] max-h-[360px]"}`}
      >
        {src ? (
          video && src === current.mediaUrl ? (
            <video
              key={src}
              src={src}
              poster={current.thumbnailUrl || undefined}
              controls
              playsInline
              preload="metadata"
              className="h-full w-full object-contain"
              onError={() => setFailedSources(previous => [...previous, src])}
            />
          ) : (
            <img
              src={src}
              alt={`${item.type} by the connected account${media.length > 1 ? `, image ${index + 1} of ${media.length}` : ""}`}
              className="h-full w-full object-contain"
              referrerPolicy="no-referrer"
              onError={() => setFailedSources(previous => [...previous, src])}
            />
          )
        ) : (
          <div className="max-w-xs space-y-3 p-6 text-center text-muted-foreground">
            <ImageOff className="mx-auto h-8 w-8" />
            <p className="text-sm">
              {refreshing ? "Refreshing media preview…" : failed
                ? "This media link has expired or is unavailable."
                : "Media preview is unavailable."}
            </p>
            <p className="text-xs">
              The captured performance remains available. Open the original post
              to view its media.
            </p>
          </div>
        )}
      </div>
      {media.length > 1 && (
        <div className="flex items-center justify-center gap-4 border-t bg-card p-3">
          <Button
            aria-label="Previous media"
            size="icon"
            variant="outline"
            disabled={index === 0}
            onClick={() => {
              setIndex((value) => value - 1);

            }}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span aria-live="polite" className="text-sm tabular-nums">
            {index + 1} / {media.length}
          </span>
          <Button
            aria-label="Next media"
            size="icon"
            variant="outline"
            disabled={index === media.length - 1}
            onClick={() => {
              setIndex((value) => value + 1);

            }}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
