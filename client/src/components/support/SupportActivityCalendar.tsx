"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export interface SupportActivityDay {
  date: string;
  activeMinutes: number;
  replies: number;
  intervals: Array<{
    id: number;
    startedAt: string;
    endedAt: string;
    lastSeenAt?: string;
    endReason?: string | null;
    clippedToDay?: boolean;
  }>;
}

export function activityDateKey(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function activityCalendarDates(today: string, days: number) {
  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const leading = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - leading);
  return Array.from({ length: days + leading }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return { date: date.toISOString().slice(0, 10), inRange: index >= leading };
  });
}

export function SupportActivityCalendar({ daily, days, timezone, now = new Date() }: {
  daily: SupportActivityDay[]; days: 90 | 365; timezone: string; now?: Date;
}) {
  const today = activityDateKey(now, timezone);
  const cells = useMemo(() => activityCalendarDates(today, days), [today, days]);
  const dayMap = useMemo(() => new Map(daily.map((day) => [day.date, day])), [daily]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedDate = selected && cells.some((cell) => cell.inRange && cell.date === selected) ? selected : today;
  const selectedDay = dayMap.get(selectedDate);
  const clock = (value: string) => new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(value));

  return <section aria-label="Member activity calendar" className="space-y-4 rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
    <div><h2 className="text-sm font-semibold">Activity calendar · last {days} days</h2><p className="mt-1 text-xs text-muted-foreground">Choose a day to see presence intervals in {timezone}.</p></div>
    <div className="overflow-x-auto pb-2"><div className="mx-auto flex w-fit min-w-max gap-2">
      <div aria-hidden="true" className="grid grid-rows-7 gap-1 text-[9px] leading-5 text-muted-foreground"><span>Mon</span><span /><span>Wed</span><span /><span>Fri</span><span /><span>Sun</span></div>
      <div className="grid grid-flow-col grid-rows-7 gap-1">{cells.map((cell) => {
        if (!cell.inRange) return <span key={cell.date} aria-hidden="true" className="h-5 w-5" />;
        const day = dayMap.get(cell.date);
        const minutes = day?.activeMinutes || 0;
        const intensity = minutes >= 240 ? "bg-success" : minutes >= 120 ? "bg-success/80" : minutes >= 30 ? "bg-success/60" : minutes > 0 ? "bg-success/35" : "bg-muted";
        const label = `${cell.date}: ${minutes} active minutes, ${day?.replies || 0} replies`;
        return <button key={cell.date} type="button" title={label} aria-label={label} aria-pressed={selectedDate === cell.date}
          aria-controls="support-activity-day-detail" onClick={() => setSelected(cell.date)}
          className={cn("h-5 w-5 rounded-[3px] border border-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background", intensity, selectedDate === cell.date && "ring-2 ring-primary ring-offset-1 ring-offset-background")} />;
      })}</div>
    </div></div>
    <div aria-hidden="true" className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground"><span>Less</span>{["bg-muted", "bg-success/35", "bg-success/60", "bg-success/80", "bg-success"].map((tone) => <span key={tone} className={cn("h-3 w-3 rounded-[3px]", tone)} />)}<span>More</span></div>
    <section id="support-activity-day-detail" aria-label={`Activity on ${selectedDate}`} aria-live="polite" className="space-y-3 border-t border-border/60 pt-4">
      <h3 className="text-sm font-medium">{selectedDate}</h3>
      <p className="text-xs text-muted-foreground">{selectedDay?.activeMinutes || 0} active minutes · {selectedDay?.replies || 0} customer replies · {selectedDay?.intervals.length || 0} presence intervals</p>
      {selectedDay?.intervals.length ? <>
        <p className="text-xs text-muted-foreground">First presence {clock(selectedDay.intervals[0].startedAt)} · Last tracked presence {clock(selectedDay.intervals.reduce((latest, interval) => interval.endedAt > latest ? interval.endedAt : latest, selectedDay.intervals[0].endedAt))}</p>
        <ol className="divide-y divide-border/50">{selectedDay.intervals.map((interval, index) => <li key={`${interval.id}:${index}`} className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs">
          <span className="font-mono tabular-nums"><time dateTime={interval.startedAt}>{clock(interval.startedAt)}</time> → <time dateTime={interval.endedAt}>{clock(interval.endedAt)}</time></span>
          <span className="text-muted-foreground">{interval.endReason === "logout" ? "Logged out" : interval.endReason === "inactivity" ? "Became inactive" : interval.endReason ? "Session ended" : "Tracked through last refresh"}{interval.clippedToDay ? " · clipped to this day" : ""}</span>
        </li>)}</ol>
        <p className="text-xs text-muted-foreground">Overlapping sessions count once toward active minutes. Refresh to see newer activity.</p>
      </> : <p className="text-xs text-muted-foreground">No presence intervals were recorded for this day.</p>}
    </section>
  </section>;
}
