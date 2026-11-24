"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTrackingQuery } from "@/hooks/use-outreach-tracking";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { addDays, toDateValue } from "@/components/ui/date-range-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import { PageEmptyState } from "@/components/EmptyState";
import { outreachReportChannels } from "../../../../../shared/campaignReporting";
import {
  MAX_UPCOMING_DAYS, outreachTrackingUrl, trackingChannelLabel, type UpcomingDay, type UpcomingSchedule,
} from "../../../../../shared/outreachTracking";
import { prefersTable } from "./DailyActivityChart";
import { viewerTimezone } from "./DayByDayCard";
import { chartPaletteClass } from "./chartPalette";
import { UpcomingChart } from "./UpcomingChart";
import { RefreshStatus } from "./TrackingSummary";
import { formatCount } from "./status";

const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const timeLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const asDate = (day: string) => { const [year, month, date] = day.split("-").map(Number); return new Date(year, month - 1, date); };
const formatDay = (day: string) => dayLabel.format(asDate(day));

const columns = (showOutreaches: boolean): DataTableColumn<UpcomingDay>[] => [
  {
    id: "date", header: "Date",
    cell: day => (
      <div className="min-w-0">
        <p className="whitespace-nowrap font-medium">{formatDay(day.date)}</p>
        {showOutreaches && day.outreaches.length > 0 ? (
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {day.outreaches.map(outreach => (
              <li key={outreach.batchId} className="break-words">
                <Link href={outreachTrackingUrl(outreach.batchId)} className="underline-offset-2 hover:text-foreground hover:underline">{outreach.name}</Link>
                {" · "}{formatCount(outreach.due)} due
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    ),
  },
  { id: "due", header: "Due", align: "right", hideBelow: "sm", cell: day => formatCount(day.due) },
  { id: "expected", header: "Expected to send", align: "right", cell: day => <span className="font-medium">{formatCount(day.expectedToSend)}</span> },
  { id: "held", header: "Still waiting", align: "right", hideBelow: "sm", cell: day => formatCount(day.held) },
  {
    id: "expire", header: "Will expire", align: "right",
    cell: day => day.willExpire > 0 ? <span className="font-medium text-destructive">{formatCount(day.willExpire)}</span> : "0",
  },
];

interface UpcomingScheduleCardProps {
  /** `/api/outreach/upcoming` for everything, or one outreach's `/upcoming` endpoint. */
  endpoint: string;
  description: string;
  /** Lists the outreaches due on each day. Used on the page that covers every outreach. */
  showOutreaches?: boolean;
  /** Changes when the page's Refresh button is pressed. */
  refreshVersion?: number;
}

/** What is waiting to go out on each coming day, with an estimate of what the daily limit lets through. */
export function UpcomingScheduleCard({ endpoint, description, showOutreaches = false, refreshVersion = 0 }: UpcomingScheduleCardProps) {
  const id = useId();
  const [today] = useState(() => toDateValue(new Date()));
  const [timezone] = useState(viewerTimezone);
  const latest = addDays(today, MAX_UPCOMING_DAYS - 1);
  const [until, setUntil] = useState(() => addDays(today, 30));
  const [view, setView] = useState<"chart" | "table">(() => prefersTable() ? "table" : "chart");
  const [channel, setChannel] = useState("all");
  // The page covering every outreach has no Refresh of its own, so this card refreshes itself and offers a channel filter.
  const standalone = showOutreaches;
  const valid = until >= today && until <= latest;
  const params = useMemo(() => ({ until, tz: timezone, channel: channel === "all" ? undefined : channel }), [until, timezone, channel]);
  // Waiting messages go out and new ones arrive all day; read the schedule again every minute.
  const schedule = useTrackingQuery<UpcomingSchedule>(valid ? endpoint : null, params, standalone ? 60_000 : false);
  const { refetch } = schedule;
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) refetch();
    mounted.current = true;
  }, [refreshVersion, refetch]);

  const data = schedule.data;
  const tableColumns = useMemo(() => columns(showOutreaches), [showOutreaches]);
  // Only days where something happens; a month of empty rows hides the ones that matter.
  const busyDays = useMemo(() => data?.days.filter(day => day.due || day.expectedToSend || day.willExpire), [data]);
  const expected = data?.days.reduce((sum, day) => sum + day.expectedToSend, 0) ?? 0;
  const expiring = data?.days.reduce((sum, day) => sum + day.willExpire, 0) ?? 0;
  const first = !data && schedule.loading;

  return (
    <Card className={chartPaletteClass}>
      <CardHeader>
        <CardTitle>Coming up</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
            <div className="space-y-1 sm:w-52">
              <Label htmlFor={`${id}-until`} className="text-xs text-muted-foreground">Show until</Label>
              <Input id={`${id}-until`} type="date" value={until} min={today} max={latest} onChange={event => setUntil(event.target.value)}
                aria-invalid={!valid || undefined} aria-describedby={valid ? undefined : `${id}-problem`} />
              {!valid ? <p id={`${id}-problem`} role="alert" className="text-xs text-destructive">Choose a date from today up to {formatDay(latest)}.</p> : null}
            </div>
            {standalone ? (
              <div className="space-y-1">
                <Label htmlFor={`${id}-channel`} className="text-xs text-muted-foreground">Channel</Label>
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger id={`${id}-channel`} className="sm:w-44" aria-label="Channel"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All channels</SelectItem>
                    {outreachReportChannels.map(option => <SelectItem key={option} value={option}>{trackingChannelLabel(option)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          {standalone ? <RefreshStatus updatedAt={schedule.updatedAt} loading={schedule.loading} live={Boolean(data && data.waiting > 0)} onRefresh={schedule.refetch} /> : null}
        </div>

        {standalone && !schedule.error && (first || (data && data.waiting > 0)) ? (
          <StatGrid columns={4} aria-label="Totals for the coming days">
            <StatCard label="Waiting now" loading={first} value={data ? formatCount(data.waiting) : undefined} description="messages not sent yet" />
            <StatCard label="Expected to send" loading={first} value={data ? formatCount(expected) : undefined}
              description={data ? `by ${formatDay(data.until)}` : undefined} />
            <StatCard label="Still waiting after" loading={first} value={data ? formatCount(data.afterRange) : undefined}
              description={data ? `after ${formatDay(data.until)}` : undefined} />
            <StatCard label="Will expire" loading={first} value={data ? formatCount(expiring) : undefined}
              tone={expiring > 0 ? "destructive" : "neutral"} description="before they can be sent" />
          </StatGrid>
        ) : null}

        {schedule.error ? (
          <Callout tone="danger" actions={<Button variant="outline" size="sm" onClick={schedule.refetch}>Try again</Button>}>
            We couldn&apos;t load the schedule.
          </Callout>
        ) : data && data.waiting === 0 ? (
          <PageEmptyState compact title={channel === "all" ? "Nothing is waiting to be sent" : `No ${trackingChannelLabel(channel)} messages are waiting`}
            description="Scheduled and held messages appear here until they go out." />
        ) : (
          <>
            {data ? (
              <p className="text-sm">
                <span className="font-semibold tabular-nums">{formatCount(data.waiting)}</span> {data.waiting === 1 ? "message is" : "messages are"} waiting.
                {" "}About <span className="font-semibold tabular-nums">{formatCount(expected)}</span> should go out by {formatDay(data.until)}
                {data.afterRange > 0 ? <>, and about <span className="font-semibold tabular-nums">{formatCount(data.afterRange)}</span> will still be waiting after that</> : null}.
              </p>
            ) : null}
            {expiring > 0 ? (
              <Callout tone="danger" title={`About ${formatCount(expiring)} ${expiring === 1 ? "message" : "messages"} will expire before they can be sent`}>
                Your daily sending limit doesn&apos;t have room for them before their time runs out. Send to fewer people at a time to avoid this.
              </Callout>
            ) : null}
            {data && busyDays && busyDays.length > 0 ? (
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setView(view === "chart" ? "table" : "chart")}>
                  {view === "chart" ? "Show as table" : "Show as chart"}
                </Button>
              </div>
            ) : null}
            {view === "chart" && data && busyDays && busyDays.length > 0 ? (
              <div className={schedule.loading ? "opacity-70 transition-opacity" : "transition-opacity"}><UpcomingChart days={data.days} /></div>
            ) : (
              <DataTable caption="Messages due on each coming day" columns={tableColumns} data={busyDays} getRowId={day => day.date}
                loading={schedule.loading} skeletonRows={4} density="compact"
                emptyState={<PageEmptyState compact title="Nothing is due in these dates" description="Choose a later date to see more." />} />
            )}
            {data ? (
              <p className="text-xs text-muted-foreground">
                These are estimates.
                {data.limits.length > 0 ? ` Your daily limit is ${data.limits.map(limit => `${formatCount(limit.dailyLimit)} ${trackingChannelLabel(limit.channel)} messages`).join(", ")}, and it resets at ${timeLabel.format(new Date(data.limitResetsAt))} your time.` : ""}
                {!showOutreaches ? " The limit is shared by all your outreaches on the same channel, so this can take longer when others are also waiting." : ""}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
