"use client";

import { type ReactNode } from "react";
import { Check, RotateCcw, Copy } from "lucide-react";
import type { Message } from "@/models/message";
import { AGENT_NAMES as AGENT_NAMES_MAP } from "@/lib/agent-personas";
import { ToolCallChip } from "@/components/conversation/ToolCallChip";
import { useCopyToClipboard } from "@/components/ui/copy-button";
import { toUserFacingError } from "../../../../shared/userFacingError";
import { readableToolName } from "@/lib/readableToolName";

/** Agent display names */
const AGENT_NAMES = AGENT_NAMES_MAP;

/** Friendly display names for tool names */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  generate_icp: "Generate ICP Profile",
  crawl_website: "Crawl Website",
  save_business_profile: "Save Business Profile",
  generate_lead_inputs: "Generate Lead Inputs",
  execute_lead_workflow: "Run Lead Workflow",
  select_brand_toolkit: "Load Brand Toolkit",
  generate_image: "Generate Image",
  generate_video: "Generate Video",
  generate_image_from_image: "Generate Image from Image",
  generate_video_from_image: "Generate Video from Image",
  generate_social_media_post: "Create Social Post",
  generate_social_chat_template: "Create Chat Template",
  generate_email_template: "Create Email Template",
  generate_sms_template: "Create SMS Template",
  send_outreach_messages: "Send Outreach Messages",
  list_proposal_templates: "List Proposal Templates",
  list_proposal_catalog: "List Approved Services",
  list_proposals: "List Proposals",
  create_proposal_draft: "Create Proposal Draft",
  refine_proposal_draft: "Refine Proposal Draft",
  add_proposal_catalog_items: "Add Approved Services",
  create_proposal_revision: "Create Proposal Revision",
  send_proposal: "Send Proposal",
  generate_ad: "Generate Ad",
  publish_ads: "Prepare Paid Campaign Review",
  publish_meta_ads: "Publish Meta Ads",
  publish_social_post: "Publish to Social Media",
  publish_to_multiple_platforms: "Publish to Multiple Platforms",
  analytics_query: "Query Analytics",
  switch_agent: "Switch Agent",
  tasks_completed: "Tasks Completed",
  list_content_assets: "List Content Assets",
  schedule_content: "Schedule Content",
  generate_blog_post: "Generate Blog Post",
};

interface ToolExecutionCardProps {
  message: Message;
  onRetry?: (toolName: string, toolArgs: Record<string, unknown>) => void;
  widgetStatus?: string;
  widgetError?: string | null;
  reviewSurface?: ReactNode;
}

export function ToolExecutionCard({
  message,
  onRetry,
  widgetStatus: widgetStatusProp,
  widgetError,
  reviewSurface,
}: ToolExecutionCardProps) {
  const meta = message.metadata || {};
  const toolName: string = meta.toolName || "unknown";
  const isResult = !!meta.isToolResult;
  const success = meta.success as boolean | undefined;
  const toolArgs = meta.toolArgs as Record<string, unknown> | undefined;
  const agentType = message.agentType || "orchestrator";

  const { status: copyStatus, copy } = useCopyToClipboard();
  const copied = copyStatus === "copied";

  const agentLabel = AGENT_NAMES[agentType] || agentType;
  const toolLabel = TOOL_DISPLAY_NAMES[toolName] || readableToolName(toolName);
  const toolOutput = meta.toolOutput as Record<string, unknown> | undefined;

  if (isResult) {
    const widgetStatus = widgetStatusProp || (typeof meta.widgetStatus === "string" ? meta.widgetStatus : undefined);
    const isCancelled = widgetStatus === "cancelled";
    const awaitingConfirmation = widgetStatus
      ? widgetStatus === "active" || widgetStatus === "draft"
      : toolOutput?.awaitingSubmission === true;
    // A video tool returns success with a saved, still-processing operation; that
    // is in progress, not "completed".
    const isVideoTool = toolName === "generate_video" || toolName === "generate_video_from_image";
    const videoProcessing = isVideoTool && success !== false && widgetStatus !== "failed" && widgetStatus !== "succeeded"
      && (toolOutput?.videoStatus === "pending" || toolOutput?.status === "pending");
    const isRunning = widgetStatus === "running" || widgetStatus === "queued" || widgetStatus === "provider_succeeded" || videoProcessing;
    const isGated = widgetStatus === "gated"
      || meta.gated === true
      || toolOutput?.status === "gated";
    const resolvedSuccess = widgetStatus === "succeeded" ? true : widgetStatus === "failed" ? false : success;
    const statusColor = isCancelled ? "text-muted-foreground" : awaitingConfirmation
      ? "text-amber-500"
      : isRunning ? "text-blue-500" : isGated ? "text-amber-500" : resolvedSuccess ? "text-green-500" : "text-red-500";
    const statusText = isCancelled ? "cancelled" : awaitingConfirmation
      ? "awaiting confirmation"
      : videoProcessing ? "video generating" : isRunning ? "running" : isGated ? "gated" : resolvedSuccess ? "completed" : "failed";
    const rawError = widgetError || meta.error as string | undefined;
    const errorMsg = rawError ? toUserFacingError(rawError) : undefined;
    const durationMs = meta.durationMs as number | undefined;
    const durationStr = durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : null;
    const activityStatus = isCancelled ? "cancelled" : awaitingConfirmation
      ? "awaiting_approval"
      : isRunning
        ? "running"
        : isGated
          ? "gated"
          : resolvedSuccess
            ? "completed"
            : "failed";

    return (
      <div className="min-w-0">
        <ToolCallChip
          label={toolLabel}
          status={activityStatus}
          agentName={agentLabel}
          detail={statusText}
          duration={durationStr || undefined}
        >
          <div className="p-3 text-xs">
            <div className="space-y-1">
              <div className="flex gap-2">
                <span className="font-medium text-muted-foreground">Agent:</span>
                <span>{agentLabel}</span>
              </div>
              <div className="flex gap-2">
                <span className="font-medium text-muted-foreground">Tool:</span>
                <span className="font-mono">{toolName}</span>
              </div>
              <div className="flex gap-2">
                <span className="font-medium text-muted-foreground">Status:</span>
                <span className={statusColor}>{statusText}</span>
              </div>
              {durationStr && (
                <div className="flex gap-2">
                  <span className="font-medium text-muted-foreground">Duration:</span>
                  <span>{durationStr}</span>
                </div>
              )}
              {!resolvedSuccess && !isRunning && errorMsg && (
                <div className="flex gap-2 pt-1 border-t border-border/50">
                  <span className="font-medium text-muted-foreground shrink-0">{isGated ? "Reason:" : "Error:"}</span>
                  <span className={isGated ? "text-amber-500 break-all" : "text-red-400 break-all"}>{errorMsg}</span>
                </div>
              )}
            </div>
{(() => {
              const argRows = toolArgs ? Object.entries(toolArgs).filter(([, v]) => v !== undefined && v !== null && v !== '') : [];
              if (argRows.length === 0) return null;
              return (
                <div className="mt-2 border-t border-border/50 pt-2">
                  <div className="font-medium text-muted-foreground mb-1">Parameters:</div>
                  <div className="rounded border border-border overflow-hidden">
                    <table className="w-full text-xs">
                      <tbody>
                        {argRows.map(([key, value]) => (
                          <tr key={key} className="border-b border-border/50 last:border-0">
                            <td className="px-2 py-1 font-mono text-muted-foreground bg-muted/50 whitespace-nowrap w-1/3">
                              {key}
                            </td>
                            <td className="px-2 py-1 text-foreground break-all">
                              {formatValue(value)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}
{(() => {
              const outRows = toolOutput ? Object.entries(toolOutput).filter(([, v]) => v !== undefined && v !== null && v !== '') : [];
              if (outRows.length === 0) return null;
              return (
                <div className="mt-2 border-t border-border/50 pt-2">
                  <div className="font-medium text-muted-foreground mb-1">Result:</div>
                  <div className="rounded border border-border overflow-hidden">
                    <table className="w-full text-xs">
                      <tbody>
                        {outRows.map(([key, value]) => (
                          <tr key={key} className="border-b border-border/50 last:border-0">
                            <td className="px-2 py-1 font-mono text-muted-foreground bg-muted/50 whitespace-nowrap w-1/3">
                              {key}
                            </td>
                            <td className="px-2 py-1 text-foreground break-all">
                              {formatValue(value)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}
          </div>
        </ToolCallChip>
        {videoProcessing && (
          <p role="status" className="mt-1.5 text-xs text-muted-foreground">
            Video is still generating (usually 1–3 minutes). It is saved and will appear in Content Library → Videos when ready; you can keep chatting.
          </p>
        )}
        {isVideoTool && !isRunning && !isCancelled && !awaitingConfirmation && resolvedSuccess === false && errorMsg && (
          <p role="alert" className="mt-1.5 text-xs text-destructive">Video generation failed: {errorMsg}</p>
        )}
        {reviewSurface}
      </div>
    );
  }

  return (
    <ToolCallChip label={toolLabel} status="running" agentName={agentLabel}>
      {toolArgs ? (
        <div className="overflow-hidden">
          {(() => {
            const rows = Object.entries(toolArgs).filter(([, v]) => v !== undefined && v !== null && v !== '');
            if (rows.length === 0) return null;
            return (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">
                      Parameter
                    </th>
                    <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">
                      Value
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([key, value]) => (
                    <tr key={key} className="border-b border-border/50 last:border-0">
                      <td className="px-3 py-1.5 font-mono text-muted-foreground whitespace-nowrap">
                        {key}
                      </td>
                      <td className="px-3 py-1.5 text-foreground break-all max-w-[300px]">
                        {formatValue(value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
          <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border bg-muted/50">
            {onRetry && (
              <button
                onClick={() => onRetry(toolName, toolArgs || {})}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                title="Retry this tool"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Retry</span>
              </button>
            )}
            <button
              onClick={() => void copy(JSON.stringify(toolArgs, null, 2))}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              title="Copy parameters"
            >
              {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
        </div>
      ) : null}
    </ToolCallChip>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value.length > 200 ? value.substring(0, 200) + "…" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value, null, 2);
  if (typeof value === "object" && value !== null) return JSON.stringify(value, null, 2);
  return String(value);
}
