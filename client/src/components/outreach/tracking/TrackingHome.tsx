"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Send, X } from "lucide-react";
import { creatorSessionScope } from "@/lib/creator-session";
import { subscribeBusinessProfile } from "@/lib/business-profile";
import { useTrackingQuery } from "@/hooks/use-outreach-tracking";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { presetDateRange } from "@/components/ui/date-range-field";
import { Pagination } from "@/components/ui/pagination";
import { Progress } from "@/components/ui/progress";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageEmptyState } from "@/components/EmptyState";
import { outreachReportChannels } from "../../../../../shared/campaignReporting";
import {
  activeOutreachProgress, deliveredCount, failedCount, outreachProgress, outreachTrackingUrl, reachedCount, trackingChannelLabel,
  type OutreachBatchList, type OutreachBatchListItem, type ReceiptSupport,
} from "../../../../../shared/outreachTracking";
import { ActivityByDayView } from "./ActivityByDayView";
import { viewerTimezone } from "./DayByDayCard";
import { TemplatesView } from "./TemplatesView";
import { RefreshStatus, TrackingTotalsGrid } from "./TrackingSummary";
import { UpcomingScheduleCard } from "./UpcomingScheduleCard";
import { NOT_REPORTED, formatCount, formatDateTime, formatShare, outreachProgressDisplay } from "./status";

const PAGE_SIZE = 20;

/** "312,000 of 400,000 sent", the one line that says how far an outreach has got. */
const progressText = (item: OutreachBatchListItem) =>
  `${formatCount(reachedCount(item.counts))} of ${formatCount(item.counts.total)} sent`;

/** A count with its share under it, the way WhatsApp Manager shows delivered and read. */
const withShare = (part: number, whole: number) => (
  <span className="inline-flex flex-col items-end leading-tight">
    <span className="tabular-nums">{formatCount(part)}</span>
    <span className="text-xs tabular-nums text-muted-foreground">{formatShare(part, whole)}</span>
  </span>
);

/** Delivered and read for channels without receipts are unknown, not zero. */
const receiptCell = (support: ReceiptSupport, value: number, whole: number) => support === "none"
  ? <span className="text-xs text-muted-foreground" title="This channel doesn't report deliveries or reads">{NOT_REPORTED}</span>
  : withShare(value, whole);

const columns: DataTableColumn<OutreachBatchListItem>[] = [
  {
    id: "outreach", header: "Outreach", className: "min-w-[14rem]",
    cell: item => (
      <div className="min-w-0">
        <Link href={outreachTrackingUrl(item.id)} className="font-medium text-foreground underline-offset-2 hover:underline">{item.name}</Link>
        <p className="mt-0.5 break-words text-xs text-muted-foreground">
          {trackingChannelLabel(item.channel)}{item.templateName ? ` · ${item.templateName}` : ""}
          {/* Narrow screens drop the Started column, so its date appears here. */}
          <span className="md:hidden"> · {formatDateTime(item.createdAt)}</span>
        </p>
      </div>
    ),
  },
  {
    id: "status", header: "Status",
    cell: item => {
      const display = outreachProgressDisplay[outreachProgress(item.counts, item.admission)];
      return <StatusBadge tone={display.tone} label={display.label} />;
    },
  },
  {
    id: "sent", header: "Sent", className: "min-w-[9rem]",
    cell: item => {
      const share = item.counts.total ? Math.round((reachedCount(item.counts) / item.counts.total) * 100) : 0;
      return (
        <div>
          <p className="text-sm tabular-nums">{progressText(item)}</p>
          <Progress value={share} className="mt-1 h-1.5" aria-label={`${share}% sent`} />
        </div>
      );
    },
  },
  {
    id: "delivered", header: "Delivered", align: "right", hideBelow: "sm",
    cell: item => receiptCell(item.receiptSupport, deliveredCount(item.counts), reachedCount(item.counts)),
  },
  {
    id: "read", header: "Read", align: "right", hideBelow: "md",
    cell: item => receiptCell(item.receiptSupport, item.counts.read, deliveredCount(item.counts)),
  },
  {
    id: "failed", header: "Failed", align: "right", hideBelow: "md",
    cell: item => failedCount(item.counts) > 0
      ? <span className="font-medium tabular-nums text-destructive">{formatCount(failedCount(item.counts))}</span>
      : <span className="tabular-nums">0</span>,
  },
  { id: "started", header: "Started", hideBelow: "md", className: "whitespace-nowrap", cell: item => formatDateTime(item.createdAt) },
];

/** How long after an outreach starts its delivered and read receipts are still worth waiting for. */
const RECEIPT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Keep reading while anything on the page can still change: messages going
 * out, or recent messages still waiting for their delivered receipt. Read
 * receipts often never come, so they alone don't keep the page refreshing.
 */
const stillChanging = (list: OutreachBatchList) => list.items.some(item =>
  activeOutreachProgress.includes(outreachProgress(item.counts, item.admission))
  || (item.receiptSupport !== "none" && Date.now() - Date.parse(item.createdAt) < RECEIPT_WINDOW_MS
    && reachedCount(item.counts) > deliveredCount(item.counts)));

const startedOptions = [
  { id: "any", label: "Any time" },
  { id: "today", label: "Started today" },
  { id: "last7", label: "Last 7 days" },
  { id: "last30", label: "Last 30 days" },
  { id: "thisMonth", label: "This month" },
] as const;
type Started = typeof startedOptions[number]["id"];

export function TrackingHome() {
  // Remount on a business switch so one business's outreach never shows under another.
  const scope = useSyncExternalStore(subscribeBusinessProfile, creatorSessionScope, () => "anonymous");
  return <TrackingHomePanel key={scope} />;
}

const views = [
  { id: "outreaches", label: "Outreaches" },
  { id: "templates", label: "By template" },
  { id: "days", label: "By day" },
  { id: "upcoming", label: "Coming up" },
] as const;
type View = typeof views[number]["id"];
const isView = (value: string | null): value is View => views.some(view => view.id === value);

function TrackingHomePanel() {
  // The open tab lives in the address, so a link or the back button returns to the same view.
  const [view, setView] = useState<View>("outreaches");
  const [template, setTemplate] = useState("");
  useEffect(() => {
    const query = new URLSearchParams(window.location.search), requested = query.get("view");
    if (isView(requested)) setView(requested);
    setTemplate(query.get("template") || "");
  }, []);
  const show = (next: View, templateName = "") => {
    setView(next);
    setTemplate(templateName);
    const url = new URL(window.location.href);
    if (next === "outreaches") url.searchParams.delete("view"); else url.searchParams.set("view", next);
    if (templateName) url.searchParams.set("template", templateName); else url.searchParams.delete("template");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };
  const changeView = (next: string) => { if (isView(next)) show(next, next === "outreaches" ? template : ""); };

  return (
    <PageShell>
      <PageHeader
        icon={Send}
        title="Message tracking"
        subtitle="See how each outreach is doing: sent, delivered, read and failed."
        actions={<Button asChild><Link href="/dashboard/outreach/create"><Plus aria-hidden="true" />New outreach</Link></Button>}
      />
      <Tabs value={view} onValueChange={changeView} className="space-y-6">
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList aria-label="Message tracking views">
            {views.map(item => <TabsTrigger key={item.id} value={item.id}>{item.label}</TabsTrigger>)}
          </TabsList>
        </div>
        <TabsContent value="outreaches" className="mt-0 space-y-5">
          <OutreachListView key={template} templateName={template} onClearTemplate={() => show("outreaches")} />
        </TabsContent>
        <TabsContent value="templates" className="mt-0"><TemplatesView onShowOutreaches={name => show("outreaches", name)} /></TabsContent>
        <TabsContent value="days" className="mt-0"><ActivityByDayView /></TabsContent>
        <TabsContent value="upcoming" className="mt-0">
          <UpcomingScheduleCard endpoint="/api/outreach/upcoming" showOutreaches
            description="Everything waiting to go out across your outreaches, and what your daily limit should let through each day." />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}

function OutreachListView({ templateName, onClearTemplate }: { templateName: string; onClearTemplate: () => void }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [state, setState] = useState("all");
  const [started, setStarted] = useState<Started>("any");
  const [timezone] = useState(viewerTimezone);
  const [page, setPage] = useState(1);
  const narrowed = channel !== "all" || state !== "all" || started !== "any" || Boolean(templateName);
  const filtered = Boolean(search) || narrowed;

  const params = useMemo(() => {
    const range = started === "any" ? undefined : presetDateRange(started);
    return {
      q: search || undefined, channel: channel === "all" ? undefined : channel, templateName: templateName || undefined, state,
      from: range?.from, to: range?.to, tz: range ? timezone : undefined, page, pageSize: PAGE_SIZE,
    };
  }, [search, channel, templateName, state, started, timezone, page]);
  // While messages are going out or receipts are still arriving, read the page again every 15 seconds.
  const list = useTrackingQuery<OutreachBatchList>("/api/outreach/batches", params, 15_000, stillChanging);
  const live = Boolean(list.data && stillChanging(list.data));
  const totals = list.data?.totals;
  // Channels without receipts would make delivered and read look like zero; say "Not reported" when none of the page reports them.
  const receiptsReported = !list.data || list.data.items.length === 0 || list.data.items.some(item => item.receiptSupport !== "none");

  const change = (apply: () => void) => { apply(); setPage(1); };
  const clearFilters = () => {
    change(() => { setChannel("all"); setState("all"); setStarted("any"); });
    if (templateName) onClearTemplate();
  };

  return (
    <>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <SearchInput
            aria-label="Search outreach names"
            placeholder="Search outreach names"
            onSearch={query => change(() => setSearch(query))}
            loading={list.loading && Boolean(search)}
            wrapperClassName="sm:w-64"
          />
          <Select value={started} onValueChange={value => change(() => setStarted(value as Started))}>
            <SelectTrigger className="sm:w-40" aria-label="Started"><SelectValue /></SelectTrigger>
            <SelectContent>
              {startedOptions.map(option => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={channel} onValueChange={value => change(() => setChannel(value))}>
            <SelectTrigger className="sm:w-40" aria-label="Channel"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {outreachReportChannels.map(option => <SelectItem key={option} value={option}>{trackingChannelLabel(option)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={state} onValueChange={value => change(() => setState(value))}>
            <SelectTrigger className="sm:w-40" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Still sending</SelectItem>
              <SelectItem value="finished">Finished</SelectItem>
            </SelectContent>
          </Select>
          {narrowed ? <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button> : null}
        </div>
        <RefreshStatus updatedAt={list.updatedAt} loading={list.loading} live={live} onRefresh={list.refetch} />
      </div>

      {templateName ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Showing outreaches that used the template</span>
          <span className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/60 py-0.5 pl-2.5 pr-1 font-medium">
            <span className="break-all">{templateName}</span>
            <button type="button" onClick={onClearTemplate} aria-label="Show all outreaches"
              className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </span>
        </p>
      ) : null}

      {list.error && !list.data ? null : (
        <TrackingTotalsGrid loading={list.loading} receiptsReported={receiptsReported}
          totals={totals ? {
            total: totals.total, sent: reachedCount(totals), delivered: deliveredCount(totals), read: totals.read, failed: failedCount(totals),
          } : undefined} />
      )}

      <DataTable
        caption="Your outreaches, newest first"
        columns={columns}
        data={list.data?.items}
        getRowId={item => item.id}
        loading={list.loading}
        skeletonRows={5}
        error={list.error ? "We couldn't load your outreaches." : undefined}
        onRetry={list.refetch}
        emptyState={filtered
          ? <PageEmptyState compact title="No outreach matches these filters" description="Try a different name, date, channel or status." />
          : <PageEmptyState icon={Send} title="No outreach yet"
              description="Outreach you send from New outreach shows up here. Messages sent before tracking started, or from chat and campaigns, are in Campaign reports."
              action={{ label: "Start an outreach", onClick: () => router.push("/dashboard/outreach/create") }}
              secondaryAction={{ label: "Open campaign reports", onClick: () => router.push("/dashboard/outreach/reports") }} />}
      />

      {list.data && list.data.total > PAGE_SIZE ? (
        <Pagination page={page} pageSize={PAGE_SIZE} totalItems={list.data.total} onPageChange={setPage}
          itemLabel="outreaches" disabled={list.loading} aria-label="Outreach pages" />
      ) : null}
    </>
  );
}
