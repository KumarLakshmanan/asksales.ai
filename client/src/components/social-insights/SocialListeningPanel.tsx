"use client";
import styles from "@/components/marketing/marketing.module.css";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  MessageCircle,
  AtSign,
  FileText,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import { socialInsightsGet } from "@/lib/socialInsightsApi";
import {
  isHttpsUrl,
  validateAnalyticsWindow,
} from "@/lib/socialAnalyticsValidation";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type Source = "comments" | "tags" | "manual";
type Event = {
  id: string;
  body: string;
  sentiment: string;
  source: string;
  kind?: Source;
  public_url?: string;
  occurred_at: string;
  author_handle?: string;
  post?: {
    id: string;
    caption: string;
    type: string;
    thumbnailUrl?: string | null;
    permalink?: string | null;
  } | null;
  metadata?: {
    reviewStatus?: string;
    sentimentSource?: string;
    collection?: string;
  };
};
type Result = {
  items: Event[];
  total: number;
  nextOffset: number | null;
  summary: Record<string, number>;
  sourceSummary?: Record<Source, number>;
};
const emptyResult: Result = {
  items: [],
  total: 0,
  nextOffset: null,
  summary: {},
};
const sentiments = ["unknown", "positive", "neutral", "negative", "mixed"];
const sentimentLabel = (value: string) =>
  value === "unknown"
    ? "Not reviewed"
    : value[0].toUpperCase() + value.slice(1);
const sources = [
  { value: "comments", label: "Comments", icon: MessageCircle },
  { value: "tags", label: "Tagged posts", icon: AtSign },
  { value: "manual", label: "Manual notes", icon: FileText },
] as const;
const selectClass = "min-h-10 rounded-md border bg-background p-2 text-sm";
const eventKind = (event: Event): Source =>
  event.kind ||
  (event.source !== "official_api"
    ? "manual"
    : event.metadata?.collection === "account_tagged_content"
      ? "tags"
      : "comments");

export function SocialListeningPanel({
  platform,
  credentialId,
  startDate,
  endDate,
  revision,
  coverage,
  postId,
}: {
  coverage?: string[];
  platform: string;
  credentialId: string;
  startDate: string;
  endDate: string;
  revision: number;
  postId?: string;
}) {
  const [result, setResult] = useState<Result>(emptyResult);
  const [kind, setKind] = useState<Source>("comments");
  const [sentiment, setSentiment] = useState("all");
  const [review, setReview] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(loading);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState(false);
  const [editing, setEditing] = useState<Event | null>(null);
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [eventDate, setEventDate] = useState(`${endDate}T12:00`);
  const [manualSentiment, setManualSentiment] = useState("unknown");
  const [deleteTarget, setDeleteTarget] = useState<Event | null>(null);
  const request = useRef(0);
  const browsingOlderPages = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const load = useCallback(
    async (offset = 0) => {
      const id = ++request.current;
      if (
        !credentialId ||
        (!postId && validateAnalyticsWindow(startDate, endDate, "UTC"))
      ) {
        setLoading(false);
        return;
      }
      // Keep passive polling from replacing older pages while they are read.
      browsingOlderPages.current = offset > 0;
      setLoading(true);
      try {
        const params = new URLSearchParams({
          platform,
          credentialId,
          ...(postId
            ? { postId }
            : {
                start: `${startDate}T00:00:00Z`,
                end: `${endDate}T23:59:59.999Z`,
              }),
          kind,
          paginated: "1",
          limit: "50",
          offset: String(offset),
          search: query,
        });
        if (sentiment !== "all") params.set("sentiment", sentiment);
        if (review !== "all") params.set("status", review);
        const data = await socialInsightsGet<Result>(
          `/api/social-analytics/listening?${params}`,
        );
        if (id === request.current) {
          setResult((old) => ({
            ...data,
            items: offset
              ? [
                  ...old.items,
                  ...data.items.filter(
                    (item) =>
                      !old.items.some((existing) => existing.id === item.id),
                  ),
                ]
              : data.items,
          }));
          setError("");
        }
      } catch (cause) {
        if (id === request.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Listening could not be loaded.",
          );
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [
      platform,
      credentialId,
      startDate,
      endDate,
      query,
      sentiment,
      review,
      kind,
      postId,
    ],
  );
  useEffect(() => {
    setResult(emptyResult);
    void load();
    const timer = setInterval(() => {
      // Never supersede a read still running (it would be discarded and redone).
      if (document.visibilityState === "visible" && !browsingOlderPages.current && !loadingRef.current)
        void load();
    }, 60000);
    return () => {
      // Invalidate whichever request is active when this scope is removed.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      request.current++;
      clearInterval(timer);
    };
  }, [load, revision]);
  const activeLoader = useRef(load);
  useEffect(() => {
    activeLoader.current = load;
  }, [load]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await activeLoader.current();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The change could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const patch = (event: Event, changes: Record<string, string>) =>
    run(async () => {
      await api.patch(`/api/social-analytics/listening/${event.id}`, changes);
      setNotice("Review saved.");
    });
  const openManual = (event?: Event) => {
    setEditing(event || null);
    setBody(event?.body || "");
    setUrl(event?.public_url || "");
    setManualSentiment(event?.sentiment || "unknown");
    setEventDate(
      event
        ? new Date(event.occurred_at).toISOString().slice(0, 16)
        : postId
          ? new Date().toISOString().slice(0, 16)
          : `${endDate || new Date().toISOString().slice(0, 10)}T12:00`,
    );
    setError("");
    setEditor(true);
  };
  const postHref = (id: string) =>
    `/dashboard/marketing/analytics/posts/${encodeURIComponent(id)}?${new URLSearchParams({ platform, account: credentialId, start: startDate, end: endDate })}`;
  const occurrence = Date.parse(`${eventDate}:00Z`);
  const validDate = Number.isFinite(occurrence) && occurrence <= Date.now();
  const filtered = Boolean(query || sentiment !== "all" || review !== "all");
  const sourceLabel = sources
    .find((source) => source.value === kind)!
    .label.toLowerCase();
  const coverageNotes =
    coverage?.filter((value) => /comment|listening|tag|stor/i.test(value)) ||
    [];
  const clearFilters = () => {
    setSearch("");
    setQuery("");
    setSentiment("all");
    setReview("all");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            {postId ? "Saved conversation history" : "Conversation inbox"}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {postId
              ? "Captured comments and review notes for this post, across all dates."
              : "Comments received in the selected dates, across all posts. Open a conversation to review its full history."}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={!credentialId || busy}
          onClick={() => openManual()}
        >
          Add manual note
        </Button>
      </div>
      <div className={styles.listeningCounts} aria-label="Listening coverage">
        <div><MessageCircle className="h-5 w-5 text-primary"/><div><strong>{result.sourceSummary ? Object.values(result.sourceSummary).reduce((sum, count) => sum + count, 0) : result.total}</strong><span>{result.sourceSummary ? "Total items captured" : "Items in selected source"}</span></div></div>
        {sources.map(({ value, label, icon: Icon }) => <div key={value}><Icon className="h-5 w-5 text-primary"/><div><strong>{result.sourceSummary?.[value] ?? (kind === value ? result.total : "—")}</strong><span>{label}</span></div></div>)}
      </div>
      <div
        role="group"
        aria-label="Listening sources"
        className="flex flex-wrap gap-1 border-b pb-2"
      >
        {sources
          .filter((source) => !postId || source.value !== "tags")
          .map(({ value, label, icon: Icon }) => (
            <button
              type="button"
              key={value}
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
              className={`inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${kind === value ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}{" "}
              <span
                className={`rounded px-1.5 py-0.5 text-xs tabular-nums ${kind === value ? "bg-primary/10" : "bg-muted"}`}
              >
                {result.sourceSummary?.[value] ??
                  (kind === value ? result.total : "—")}
              </span>
            </button>
          ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search listening evidence"
          placeholder={
            kind === "comments"
              ? "Search comments or authors"
              : kind === "tags"
                ? "Search tagged posts"
                : "Search manual notes"
          }
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-48 flex-1 sm:max-w-sm"
        />
        <select
          aria-label="Listening sentiment"
          value={sentiment}
          onChange={(event) => setSentiment(event.target.value)}
          className={selectClass}
        >
          <option value="all">All sentiment</option>
          {sentiments.map((value) => (
            <option key={value} value={value}>
              {sentimentLabel(value)}
            </option>
          ))}
        </select>
        <select
          aria-label="Listening review status"
          value={review}
          onChange={(event) => setReview(event.target.value)}
          className={selectClass}
        >
          <option value="all">All review statuses</option>
          <option value="new">Needs review</option>
          <option value="reviewed">Reviewed</option>
          <option value="follow_up">Follow up</option>
          <option value="escalated">Escalated</option>
          <option value="resolved">Resolved</option>
        </select>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading || !credentialId}
          onClick={() => void load()}
        >
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>
      {error && (
        <Callout
          tone="danger"
          actions={
            <Button size="sm" variant="ghost" onClick={() => void load()}>
              Retry listening
            </Button>
          }
        >
          {error}
        </Callout>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {result.items.length} of {result.total}{" "}
        {filtered ? "matching " : "captured "}
        {sourceLabel}
        {!postId && ` · ${startDate} – ${endDate} (UTC)`}
        {kind === "comments" && result.summary?.unknown
          ? ` · ${result.summary.unknown} not reviewed for sentiment`
          : ""}
      </p>
      {loading && !result.items.length ? (
        <p role="status" className="py-8 text-sm text-muted-foreground">
          Loading {sourceLabel}…
        </p>
      ) : !result.items.length ? (
        <div className="rounded-lg border border-dashed px-5 py-10 text-center">
          <h3 className="font-medium">
            {!credentialId
              ? "Choose a connected account"
              : filtered
                ? `No ${sourceLabel} match these filters`
                : kind === "comments"
                  ? "No comments captured here yet"
                  : kind === "tags"
                    ? "No tagged posts captured here yet"
                    : "No manual notes yet"}
          </h3>
          <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
            {!credentialId
              ? "Connect a Facebook or Instagram account to see its conversations."
              : filtered
                ? "Clear the search or review filters to see more conversations."
                : kind === "comments"
                  ? postId
                    ? "Use Sync now in Social Insights to import available comment history. Comments & replies shows the live thread."
                    : "Run Sync now to collect available comments. Tagged posts have their own view and are not counted as comments."
                  : kind === "tags"
                    ? "This view contains posts that tag your connected account when the provider makes them available."
                    : "Add a source link and your note to keep useful context alongside captured conversations."}
          </p>
          {filtered && (
            <Button className="mt-4" variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <div className={styles.listeningTable}>
          <table aria-label="Listening evidence"><thead><tr>{["Source", "Content", "Sentiment", "Review status", "Observed at", "Actions"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
            <tbody>{result.items.map(event => <tr key={event.id}>
              <td className="min-w-28"><p className="text-xs font-medium">{event.author_handle || (eventKind(event) === "manual" ? "Manual note" : eventKind(event) === "tags" ? "Tagged post" : "Comment author unavailable")}</p><p className="mt-1 text-[10px] capitalize text-muted-foreground">{eventKind(event) === "manual" ? "Manual evidence" : eventKind(event) === "tags" ? "Tagged post" : "Comment"}</p></td>
              <td className="min-w-64 max-w-lg"><p className="whitespace-pre-wrap break-words text-xs leading-5">{event.body}</p>{event.post && !postId && <Link href={postHref(event.post.id)} aria-label="Open post & conversation" className="mt-2 inline-flex items-center gap-2 text-[11px] text-primary hover:underline">{event.post.thumbnailUrl && <img src={event.post.thumbnailUrl} alt="" className="h-7 w-7 rounded object-cover" loading="lazy" referrerPolicy="no-referrer"/>}<span><span className="line-clamp-1 text-muted-foreground">Your {event.post.type || "post"}: <span>{event.post.caption || "Published content"}</span></span>Open post &amp; conversation</span></Link>}</td>
              <td><label className="sr-only" htmlFor={`sentiment-${event.id}`}>Sentiment</label><select id={`sentiment-${event.id}`} className={selectClass} aria-label={`Sentiment for ${event.id}`} value={event.sentiment} disabled={busy} onChange={change => void patch(event, { sentiment: change.target.value })}>{sentiments.map(value => <option key={value} value={value}>{sentimentLabel(value)}</option>)}</select></td>
              <td><select className={selectClass} aria-label={`Review status for ${event.id}`} value={event.metadata?.reviewStatus || "new"} disabled={busy} onChange={change => void patch(event, { status: change.target.value })}><option value="new">Needs review</option><option value="reviewed">Reviewed</option><option value="follow_up">Follow up</option><option value="escalated">Escalated</option><option value="resolved">Resolved</option></select></td>
              <td className="min-w-32"><time dateTime={event.occurred_at} className="text-[11px] text-muted-foreground">{new Date(event.occurred_at).toLocaleString()}</time></td>
              <td><div className="flex flex-wrap gap-1">{event.public_url && <a className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-primary hover:underline" href={event.public_url} target="_blank" rel="noreferrer">{eventKind(event) === "tags" ? "Open tagged post" : "Open original"}<ExternalLink className="h-3 w-3"/></a>}{eventKind(event) === "manual" && <><Button variant="ghost" size="sm" disabled={busy} onClick={() => openManual(event)}>Edit note</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setDeleteTarget(event)}>Delete</Button></>}</div></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      {result.nextOffset != null && (
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void load(result.nextOffset!)}
        >
          {loading ? "Loading…" : "Load more evidence"}
        </Button>
      )}
      <details className="rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium">
          What this inbox includes
        </summary>
        <div className="mt-2 space-y-2">
          <p>
            Comments come from captured posts connected to this account. Tagged
            posts are a separate source. Story replies and private messages are
            not included. Sentiment is marked “Not reviewed” until someone
            classifies it.
          </p>
          <p>
            Counts follow the search, review, sentiment and date filters. Source
            counts keep comments, tags and notes separate.
          </p>
          {coverageNotes.map((value) => (
            <p key={value}>{value}</p>
          ))}
          {!coverageNotes.length && (
            <p>
              Provider access and sync coverage determine which conversations
              are available. Open a post to inspect its full available comment
              thread.
            </p>
          )}
        </div>
      </details>
      <Sheet open={editor} onOpenChange={setEditor}>
        <SheetContent overlayClassName={styles.drawerOverlay} className={styles.drawer}>
          <SheetHeader>
            <SheetTitle>
              {editing ? "Edit manual note" : "Add manual note"}
            </SheetTitle>
            <SheetDescription>
              {postId
                ? "Attach a cited note to this post. The original source date uses UTC."
                : "Record the original source date in UTC. Find saved notes in Manual notes."}
            </SheetDescription>
          </SheetHeader>
          <form
            className="mt-6 space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!body.trim() || !isHttpsUrl(url) || !validDate) return;
              void run(async () => {
                if (editing)
                  await api.patch(
                    `/api/social-analytics/listening/${editing.id}`,
                    {
                      body: body.trim(),
                      publicUrl: url,
                      sentiment: manualSentiment,
                    },
                  );
                else
                  await api.post("/api/social-analytics/listening", {
                    platform,
                    credentialId: Number(credentialId),
                    providerEventId: `manual:${crypto.randomUUID()}`,
                    body: body.trim(),
                    publicUrl: url,
                    occurredAt: new Date(occurrence).toISOString(),
                    source: "public_export",
                    sentiment: manualSentiment,
                    ...(postId ? { metadata: { contentId: postId } } : {}),
                  });
                setEditor(false);
                setBody("");
                setUrl("");
                setKind("manual");
                setNotice(
                  !postId &&
                    (eventDate.slice(0, 10) < startDate ||
                      eventDate.slice(0, 10) > endDate)
                    ? "Note saved outside this date window. Change the dates to view it."
                    : "Manual note saved.",
                );
              });
            }}
          >
            <label className="block text-sm">
              Note
              <textarea
                className="mt-1 block min-h-24 w-full rounded border bg-background p-2"
                required
                maxLength={10000}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              Public source URL
              <Input
                type="url"
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://…"
              />
            </label>
            <label className="block text-sm">
              Source date and time (UTC)
              <Input
                type="datetime-local"
                required
                disabled={Boolean(editing)}
                value={eventDate}
                onChange={(event) => setEventDate(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              Sentiment
              <select
                className={`${selectClass} ml-2`}
                value={manualSentiment}
                onChange={(event) => setManualSentiment(event.target.value)}
              >
                {sentiments.map((value) => (
                  <option key={value} value={value}>
                    {sentimentLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2 border-t pt-4 sm:col-span-2"><Button type="button" variant="outline" onClick={() => setEditor(false)}>Cancel</Button>
            <Button
              type="submit"
              disabled={busy || !body.trim() || !isHttpsUrl(url) || !validDate}
            >
              Save note
            </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete manual note?</DialogTitle>
            <DialogDescription>
              This removes the note from the conversation inbox.
            </DialogDescription>
          </DialogHeader>
          {error && <p role="alert">{error}</p>}
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.delete(
                  `/api/social-analytics/listening/${deleteTarget!.id}`,
                );
                setDeleteTarget(null);
              })
            }
          >
            Delete note
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
