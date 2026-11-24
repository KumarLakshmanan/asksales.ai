"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { UpcomingDay } from "../../../../../shared/outreachTracking";
import { chartAxisTick, chartColor, chartGridStroke, compactNumber } from "./chartPalette";
import { formatDay } from "./DailyActivityChart";
import { formatCount } from "./status";

const fullDayLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const asDate = (day: string) => { const [year, month, date] = day.split("-").map(Number); return new Date(year, month - 1, date); };

function ScheduleTooltip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: UpcomingDay }> }) {
  const day = payload?.[0]?.payload;
  if (!active || !day) return null;
  const rows: Array<[string, number, string | null]> = [
    ["Expected to send", day.expectedToSend, chartColor.sent],
    ["Will expire", day.willExpire, chartColor.failed],
    ["Due this day", day.due, null],
    ["Still waiting after", day.held, null],
  ];
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1.5 font-medium">{fullDayLabel.format(asDate(day.date))}</p>
      <ul className="space-y-1">
        {rows.map(([label, value, color]) => (
          <li key={label} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: color ?? "transparent" }} aria-hidden="true" />
            <span className="font-semibold tabular-nums text-foreground">{formatCount(value)}</span>
            <span className="text-muted-foreground">{label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A bar per day: what the daily limit should let through, with anything that will expire stacked on top. */
export function UpcomingChart({ days }: { days: readonly UpcomingDay[] }) {
  const sending = days.reduce((sum, day) => sum + day.expectedToSend, 0), expiring = days.reduce((sum, day) => sum + day.willExpire, 0);
  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Chart legend">
        {([["Expected to send", sending, chartColor.sent], ["Will expire", expiring, chartColor.failed]] as const).map(([label, value, color]) => (
          <li key={label} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px]" style={{ background: color }} aria-hidden="true" />
            <span className="text-muted-foreground">{label}</span>
            <span className="font-semibold tabular-nums">{formatCount(value)}</span>
          </li>
        ))}
      </ul>
      <div className="h-56 w-full" role="img"
        aria-label={`Bar chart of the coming days: about ${formatCount(sending)} messages expected to send and ${formatCount(expiring)} expected to expire. The table view has every number.`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={days as UpcomingDay[]} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={chartGridStroke} />
            <XAxis dataKey="date" tickFormatter={formatDay} tick={chartAxisTick} tickLine={false} axisLine={{ stroke: chartGridStroke }} minTickGap={28} />
            <YAxis allowDecimals={false} width={44} tickFormatter={value => compactNumber.format(Number(value))} tick={chartAxisTick} tickLine={false} axisLine={false} />
            <Tooltip content={<ScheduleTooltip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }} />
            {/* The card-coloured outline is the 2px gap between the stacked parts. */}
            <Bar dataKey="expectedToSend" name="Expected to send" stackId="day" fill={chartColor.sent} maxBarSize={24}
              stroke="hsl(var(--card))" strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="willExpire" name="Will expire" stackId="day" fill={chartColor.failed} maxBarSize={24} radius={[4, 4, 0, 0]}
              stroke="hsl(var(--card))" strokeWidth={1} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
