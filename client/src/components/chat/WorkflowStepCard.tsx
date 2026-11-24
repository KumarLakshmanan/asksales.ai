"use client";

import { Globe, Linkedin, Instagram, MapPin } from "lucide-react";
import type { Message } from "@/models/message";
import { ToolCallChip } from "@/components/conversation/ToolCallChip";
import type { ConversationActivityStatus } from "@/components/conversation/types";

interface WorkflowStepCardProps {
  message: Message;
}

function PlatformIcon({ platform }: { platform?: string }) {
  const value = platform?.toLowerCase() || "";
  if (value.includes("linkedin")) return <Linkedin className="h-3.5 w-3.5" aria-hidden="true" />;
  if (value.includes("instagram")) return <Instagram className="h-3.5 w-3.5" aria-hidden="true" />;
  if (value.includes("google") || value.includes("maps")) return <MapPin className="h-3.5 w-3.5" aria-hidden="true" />;
  return <Globe className="h-3.5 w-3.5" aria-hidden="true" />;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 border-b border-border/50 px-3 py-2 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground/85">{children}</dd>
    </div>
  );
}

export function WorkflowStepCard({ message }: WorkflowStepCardProps) {
  const meta = message.metadata || {};
  const platform = meta.platform as string | undefined;
  const step = meta.step as string | undefined;
  const progress = meta.progress as number | undefined;
  const leadsCount = meta.leadsCount as number | undefined;
  const error = meta.error as string | undefined;
  const lead = meta.lead as { name?: string; company?: string; email?: string; phone?: string } | undefined;

  let status: ConversationActivityStatus = "running";
  let label = step || message.content?.replace(/^📍\s*/, "") || "Processing workflow";
  let detail = platform;

  if (meta.isWorkflowStart) label = "Lead workflow started";
  if (meta.isWorkflowComplete) {
    status = "completed";
    label = "Lead workflow completed";
    detail = leadsCount ? `${leadsCount} lead${leadsCount === 1 ? "" : "s"}` : platform;
  }
  if (meta.isWorkflowError) {
    status = "failed";
    label = "Lead workflow failed";
  }
  if (meta.isLeadSaved) {
    status = "completed";
    label = lead?.name ? `Saved ${lead.name}` : `Saved ${(meta.count as number | undefined) || 1} lead(s)`;
    detail = lead?.company || platform;
  }
  if (meta.isWorkflowStep && progress === 100) status = "completed";

  const hasDetails = Boolean(platform || progress != null || error || leadsCount != null || lead);

  return (
    <ToolCallChip
      label={label}
      status={status}
      agentName="Marcus"
      detail={detail}
      defaultExpanded={status === "failed"}
    >
      {hasDetails ? (
        <dl>
          {platform ? <DetailRow label="Source"><span className="inline-flex items-center gap-1.5"><PlatformIcon platform={platform} />{platform}</span></DetailRow> : null}
          {progress != null ? <DetailRow label="Progress">{progress}%</DetailRow> : null}
          {leadsCount != null ? <DetailRow label="Leads">{leadsCount}</DetailRow> : null}
          {lead?.email ? <DetailRow label="Email">{lead.email}</DetailRow> : null}
          {lead?.phone ? <DetailRow label="Phone">{lead.phone}</DetailRow> : null}
          {error ? <DetailRow label="Error"><span className="text-destructive">{error}</span></DetailRow> : null}
        </dl>
      ) : null}
    </ToolCallChip>
  );
}
