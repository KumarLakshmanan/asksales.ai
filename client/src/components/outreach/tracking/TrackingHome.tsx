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
import { Pagination } from "@/components/ui/pagination";
import { Progress } from "@/components/ui/progress";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageEmptyState } from "@/components/EmptyState";
import { outreachReportChannels } from "../../../../../shared/campaignReporting";
import {
  deliveredCount, failedCount, outreachProgress, outreachTrackingUrl, reachedCount, trackingChannelLabel,
  type OutreachBatchList, type OutreachBatchListItem, type ReceiptSupport,
} from "../../../../../shared/outreachTracking";
import { ActivityByDayView } from "./ActivityByDayView";
import { TemplatesView } from "./TemplatesView";
import { UpcomingScheduleCard } from "./UpcomingScheduleCard";
import { NOT_REPORTED, formatCount, formatDateTime, outreachProgressDisplay, receiptValue } from "./status";

const PAGE_SIZE = 20;

/** "312,000 of 400,000 sent", the one line that says how far an outreach has got. */
const progressText = (item: OutreachBatchListItem) =>
  `${formatCount(reachedCount(item.counts))} of ${formatCount(item.counts.total)} sent`;

/** Delivered and read for channels without receipts are unknown, not zero. */
const receiptCell = (support: ReceiptSupport, value: number) => support === "none"
  ? <span className="text-muted-foreground" title="This channel doesn't report deliveries or reads">{NOT_REPORTED}</span>
  : receiptValue(support, value);

const columns: DataTableColumn<OutreachBatchListItem>[] = [
  {
    id: "outreach", header: "Outreach",
    cell: item => (
      <div className="min-w-0">
        <Link href={outreachTrackingUrl(item.id)} className="font-medium text-foreground underline-offset-2 hover:underline">{item.name}</Link>
        <p className="mt-0.5 break-words text-xs text-muted-foreground">
          {trackingChannelLabel(item.channel)}{item.templateName ? ` · ${item.templateName}` : ""}
        </p>
        {/* Phones drop the progress column, so the same line appears here. */}
        <p className="mt-0.5 text-xs tabular-nums text-muted-foreground sm:hidden">{progressText(item)}</p>
      </div>
    ),
  },
  { id: "started", header: "Started", hideBelow: "md", className: "whitespace-nowrap", cell: item => formatDateTime(item.createdAt) },
  {
    id: "progress", header: "Progress", hideBelow: "sm", className: "min-w-[11rem]",
    cell: item => {
      const share = item.counts.total ? Math.round((reachedCount(item.counts) / item.counts.total) * 100) : 0;
      return (
        <div>
          <Progress value={share} className="h-2" aria-label={`${share}% sent`} />
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">{progressText(item)}</p>
        </div>
      );
    },
  },
  { id: "delivered", header: "Delivered", align: "right", hideBelow: "md", cell: item => receiptCell(item.receiptSupport, deliveredCount(item.counts)) },
  { id: "read", header: "Read", align: "right", hideBelow: "lg", cell: item => receiptCell(item.receiptSupport, item.counts.read) },
  { id: "failed", header: "Failed", align: "right", hideBelow: "md", cell: item => formatCount(failedCount(item.counts)) },
  {
    id: "status", header: "Status",
    cell: item => {
      const display = outreachProgressDisplay[outreachProgress(item.counts, item.admission)];
      return <StatusBadge tone={display.tone} label={display.label} />;
    },
  },
];

const stillChanging = (list: OutreachBatchList) =>
  list.items.some(item => ["preparing", "scheduled", "sending"].includes(outreachProgress(item.counts, item.admission)));

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
        <TabsContent value="outreaches" className="mt-0 space-y-6">
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
  const [page, setPage] = useState(1);
  const filtered = Boolean(search) || channel !== "all" || state !== "all" || Boolean(templateName);

  const params = useMemo(() => ({
    q: search || undefined, channel: channel === "all" ? undefined : channel, templateName: templateName || undefined, state, page, pageSize: PAGE_SIZE,
  }), [search, channel, templateName, state, page]);
  // An outreach that is still sending changes by the minute; refresh the visible page quietly.
  const list = useTrackingQuery<OutreachBatchList>("/api/outreach/batches", params, 30_000, stillChanging);

  const change = (apply: () => void) => { apply(); setPage(1); };

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          aria-label="Search outreach names"
          placeholder="Search outreach names"
          onSearch={query => change(() => setSearch(query))}
          loading={list.loading && Boolean(search)}
          wrapperClassName="sm:max-w-sm"
        />
        <Select value={channel} onValueChange={value => change(() => setChannel(value))}>
          <SelectTrigger className="sm:w-44" aria-label="Channel"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            {outreachReportChannels.map(option => <SelectItem key={option} value={option}>{trackingChannelLabel(option)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={value => change(() => setState(value))}>
          <SelectTrigger className="sm:w-44" aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All outreaches</SelectItem>
            <SelectItem value="active">Still sending</SelectItem>
            <SelectItem value="finished">Finished</SelectItem>
          </SelectContent>
        </Select>
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

      <DataTable
        caption="Your outreaches, newest first"
        columns={columns}
        data={list.data?.items}
        getRowId={item => item.id}
        loading={list.loading}
        error={list.error ? "We couldn't load your outreaches." : undefined}
        onRetry={list.refetch}
        emptyState={filtered
          ? <PageEmptyState compact title="No outreach matches these filters" description="Try a different name, channel or status." />
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
