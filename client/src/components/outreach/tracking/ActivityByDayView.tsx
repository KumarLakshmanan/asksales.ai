"use client";

import { useMemo, useState } from "react";
import { presetDateRange } from "@/components/ui/date-range-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { outreachReportChannels } from "../../../../../shared/campaignReporting";
import { trackingChannelLabel } from "../../../../../shared/outreachTracking";
import { DayByDayCard } from "./DayByDayCard";

/** Every outreach message in the business, per day, for any date range. */
export function ActivityByDayView() {
  const [channel, setChannel] = useState("all");
  const defaultRange = useMemo(() => presetDateRange("last7"), []);
  const params = useMemo(() => ({ channel: channel === "all" ? undefined : channel }), [channel]);
  return (
    <DayByDayCard
      title="Messages by day"
      description="Everything your tracked outreaches sent on each day, with what was delivered, read and failed. Replies and messages sent from the Inbox are not counted."
      endpoint="/api/outreach/daily"
      subject={channel === "all" ? "all outreach" : `${trackingChannelLabel(channel)} outreach`}
      defaultRange={defaultRange}
      params={params}
      filters={
        <Select value={channel} onValueChange={setChannel}>
          <SelectTrigger className="sm:w-44" aria-label="Channel"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            {outreachReportChannels.map(option => <SelectItem key={option} value={option}>{trackingChannelLabel(option)}</SelectItem>)}
          </SelectContent>
        </Select>
      }
    />
  );
}
