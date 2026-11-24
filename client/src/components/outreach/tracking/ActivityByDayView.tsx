"use client";

import { useMemo, useState } from "react";
import { presetDateRange } from "@/components/ui/date-range-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { outreachReportChannels } from "../../../../../shared/campaignReporting";
import { trackingChannelLabel } from "../../../../../shared/outreachTracking";
import { DayByDayCard } from "./DayByDayCard";

type MessageKind = "outreach" | "follow_up" | "all";
/** The same choices and wording as the Reports page. */
const messageKinds: ReadonlyArray<{ value: MessageKind; label: string; noun: string }> = [
  { value: "outreach", label: "Initial outreach", noun: "outreach" },
  { value: "follow_up", label: "Follow-ups", noun: "follow-ups" },
  { value: "all", label: "Outreach and follow-ups", noun: "outreach and follow-ups" },
];

/** Every outreach message in the business, per day, for any date range. */
export function ActivityByDayView() {
  const [channel, setChannel] = useState("all");
  const [kind, setKind] = useState<MessageKind>("outreach");
  const defaultRange = useMemo(() => presetDateRange("last7"), []);
  // Initial outreach is the API's default, so it is not sent.
  const params = useMemo(() => ({
    channel: channel === "all" ? undefined : channel,
    kind: kind === "outreach" ? undefined : kind,
  }), [channel, kind]);
  const noun = messageKinds.find(option => option.value === kind)?.noun ?? "outreach";
  return (
    <DayByDayCard
      title="Messages by day"
      description="Every outreach message sent on each day, including ones sent before Message tracking, with what was delivered, read and failed. Replies and messages sent from the Inbox are not counted."
      endpoint="/api/outreach/daily"
      subject={channel === "all" ? `all ${noun}` : `${trackingChannelLabel(channel)} ${noun}`}
      defaultRange={defaultRange}
      params={params}
      standalone
      filters={
        <>
          <Select value={kind} onValueChange={value => setKind(value as MessageKind)}>
            <SelectTrigger className="sm:w-52" aria-label="Outbound messages"><SelectValue /></SelectTrigger>
            <SelectContent>
              {messageKinds.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={channel} onValueChange={setChannel}>
            <SelectTrigger className="sm:w-44" aria-label="Channel"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {outreachReportChannels.map(option => <SelectItem key={option} value={option}>{trackingChannelLabel(option)}</SelectItem>)}
            </SelectContent>
          </Select>
        </>
      }
    />
  );
}
