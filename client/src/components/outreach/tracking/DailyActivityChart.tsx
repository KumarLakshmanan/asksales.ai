"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  dailyActivityLabels, dailyActivitySeries,
  type DailyActivity, type DailyActivityDay, type DailyActivitySeries,
} from "../../../../../shared/outreachTracking";
import { chartAxisTick, chartColor, chartGridStroke, chartPaletteClass, compactNumber } from "./chartPalette";
import { formatCount } from "./status";

const dayLabel = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const fullDayLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const tableDayLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
/** A `YYYY-MM-DD` day as a local date, so the label never slips a day across timezones. */
const asDate = (day: string) => { const [year, month, date] = day.split("-").map(Number); return new Date(year, month - 1, date); };
export const formatDay = (day: string) => dayLabel.format(asDate(day));
/** Whether to start on the table: four lines across a month are hard to read at phone width. */
export const prefersTable = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 639px)").matches);

type Row = DailyActivityDay & { total?: boolean };
const columns: DataTableColumn<Row>[] = [
  { id: "date", header: "Date", className: "whitespace-nowrap", cell: row => row.total ? <span className="font-semibold">Total</span> : tableDayLabel.format(asDate(row.date)) },
  ...dailyActivitySeries.map((series): DataTableColumn<Row> => ({
    id: series, header: dailyActivityLabels[series], align: "right",
    cell: row => <span className={row.total ? "font-semibold" : undefined}>{formatCount(row[series])}</span>,
  })),
];

function ActivityTooltip({ active, payload, label, shown }: {
  active?: boolean; label?: string | number; payload?: ReadonlyArray<{ payload?: DailyActivityDay }>; shown: readonly DailyActivitySeries[];
}) {
  const day = payload?.[0]?.payload;
  if (!active || !day) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1.5 font-medium">{fullDayLabel.format(asDate(String(label ?? day.date)))}</p>
      <ul className="space-y-1">
        {shown.map(series => (
          <li key={series} className="flex items-center gap-2">
            <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: chartColor[series] }} aria-hidden="true" />
            <span className="font-semibold tabular-nums text-foreground">{formatCount(day[series])}</span>
            <span className="text-muted-foreground">{dailyActivityLabels[series]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface DailyActivityChartProps {
  activity: DailyActivity | undefined;
  loading: boolean;
  error?: string;
  onRetry?: () => void;
  /** What the chart is about, for screen readers: "Diwali offer" or "all outreach". */
  subject: string;
}

/**
 * Sent, delivered, read and failed per day. Hover or tap a day for its
 * numbers, press a legend entry to hide or show that line, and switch to a
 * table of the same numbers at any time.
 */
export function DailyActivityChart({ activity, loading, error, onRetry, subject }: DailyActivityChartProps) {
  const [view, setView] = useState<"chart" | "table">(() => prefersTable() ? "table" : "chart");
  const [hidden, setHidden] = useState<ReadonlySet<DailyActivitySeries>>(new Set());
  const shown = dailyActivitySeries.filter(series => !hidden.has(series));
  const rows = useMemo<Row[] | undefined>(() => activity
    ? [...activity.days, { date: "total", ...activity.totals, total: true }] : undefined, [activity]);

  if (error) {
    return (
      <Callout tone="danger" actions={onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button> : undefined}>
        We couldn&apos;t load the day-by-day numbers.
      </Callout>
    );
  }
  if (!activity) return <Skeleton className="h-64 w-full" aria-label="Loading the day-by-day numbers" />;

  const toggle = (series: DailyActivitySeries) => setHidden(current => {
    const next = new Set(current);
    // The last visible line stays, so the chart is never empty by accident.
    if (next.has(series)) next.delete(series); else if (next.size < dailyActivitySeries.length - 1) next.add(series);
    return next;
  });
  const quiet = dailyActivitySeries.every(series => activity.totals[series] === 0);

  return (
    <div className={cn("space-y-3 transition-opacity", chartPaletteClass, loading && "opacity-70")} aria-busy={loading || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ul className="flex flex-wrap gap-1" aria-label="Chart legend. Press an entry to hide or show it.">
          {dailyActivitySeries.map(series => {
            const visible = !hidden.has(series);
            return (
              <li key={series}>
                <button type="button" onClick={() => toggle(series)} aria-pressed={visible} disabled={view === "table"}
                  aria-label={`${dailyActivityLabels[series]}: ${formatCount(activity.totals[series])}. ${visible ? "Shown" : "Hidden"} on the chart.`}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    view === "chart" && "hover:bg-muted", !visible && view === "chart" && "opacity-50",
                  )}>
                  <span className="h-0.5 w-4 rounded-full" style={{ background: chartColor[series] }} aria-hidden="true" />
                  <span className={cn("text-muted-foreground", !visible && view === "chart" && "line-through")}>{dailyActivityLabels[series]}</span>
                  <span className="font-semibold tabular-nums">{formatCount(activity.totals[series])}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <Button variant="outline" size="sm" onClick={() => setView(view === "chart" ? "table" : "chart")}>
          {view === "chart" ? "Show as table" : "Show as chart"}
        </Button>
      </div>

      {view === "table" ? (
        <DataTable caption={`Messages per day for ${subject}`} columns={columns} data={rows} getRowId={row => row.date} density="compact" />
      ) : quiet ? (
        <p className="rounded-xl border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
          Nothing was sent, delivered, read or failed in these dates.
        </p>
      ) : (
        <div className="h-64 w-full" role="img"
          aria-label={`Line chart of messages per day for ${subject}: ${dailyActivitySeries.map(series => `${formatCount(activity.totals[series])} ${dailyActivityLabels[series].toLowerCase()}`).join(", ")}. The table view has every number.`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={activity.days} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={chartGridStroke} />
              <XAxis dataKey="date" tickFormatter={formatDay} tick={chartAxisTick} tickLine={false} axisLine={{ stroke: chartGridStroke }} minTickGap={28} />
              <YAxis allowDecimals={false} width={44} tickFormatter={value => compactNumber.format(Number(value))} tick={chartAxisTick} tickLine={false} axisLine={false} />
              <Tooltip content={<ActivityTooltip shown={shown} />} cursor={{ stroke: "hsl(var(--muted-foreground))", strokeWidth: 1 }} />
              {shown.map(series => (
                <Line key={series} dataKey={series} name={dailyActivityLabels[series]} type="linear" stroke={chartColor[series]} strokeWidth={2}
                  // A range of one or two days has no line to draw, so the points themselves are shown.
                  dot={activity.days.length <= 2 ? { r: 4, strokeWidth: 0, fill: chartColor[series] } : false}
                  activeDot={{ r: 4, stroke: "hsl(var(--card))", strokeWidth: 2 }} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
