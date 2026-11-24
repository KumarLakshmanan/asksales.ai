"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTrackingQuery } from "@/hooks/use-outreach-tracking";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DateRangeField, type DateRange, type DateRangePreset } from "@/components/ui/date-range-field";
import { MAX_DAILY_RANGE_DAYS, type DailyActivity } from "../../../../../shared/outreachTracking";
import { DailyActivityChart } from "./DailyActivityChart";
import { deviceTimeZone } from "../../../../../shared/timeZones";

/** The timezone the person's device is set to; day boundaries follow it. */
export const viewerTimezone = () => {
  return deviceTimeZone("UTC");
};

interface DayByDayCardProps {
  title: string;
  description: string;
  /** `/api/outreach/daily` for everything, or one outreach's `/daily` endpoint. */
  endpoint: string;
  /** What the numbers are about, for screen readers. */
  subject: string;
  defaultRange: DateRange;
  presets?: readonly DateRangePreset[];
  /** Extra filters sent with the request, e.g. a channel. */
  params?: Record<string, string | undefined>;
  /** More filter controls, shown on the same row as the dates. */
  filters?: ReactNode;
  /** Changes when the page's Refresh button is pressed. */
  refreshVersion?: number;
}

/** Date range, chart and table of what was sent, delivered, read and failed on each day. */
export function DayByDayCard({ title, description, endpoint, subject, defaultRange, presets, params, filters, refreshVersion = 0 }: DayByDayCardProps) {
  const [range, setRange] = useState(defaultRange);
  const [timezone] = useState(viewerTimezone);
  const query = useMemo(() => ({ ...params, from: range.from, to: range.to, tz: timezone }), [params, range, timezone]);
  const activity = useTrackingQuery<DailyActivity>(endpoint, query);
  const { refetch } = activity;
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) refetch();
    mounted.current = true;
  }, [refreshVersion, refetch]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
          <DateRangeField value={range} onChange={setRange} presets={presets} maxDays={MAX_DAILY_RANGE_DAYS} aria-label={`Dates for ${title.toLowerCase()}`}
            hint={`Both dates are included. Days follow ${timezone.replace(/_/g, " ")} time.`} />
          {filters}
        </div>
        <DailyActivityChart activity={activity.data} loading={activity.loading} error={activity.error} onRetry={activity.refetch} subject={subject} />
        <p className="text-xs text-muted-foreground">
          Each number is counted on the day it happened. A message sent on Monday and delivered on Tuesday counts as sent on Monday and delivered on Tuesday.
        </p>
      </CardContent>
    </Card>
  );
}
