"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Send, Mail, MessageCircle,
  Instagram, Facebook, MessageSquare,
  AlertTriangle, Ban, CalendarClock, Inbox, Info, RotateCcw,
} from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { OutreachQueue } from "@/components/outreach/OutreachQueue";
import { findUnresolvedTemplateTokens } from "@/utils/templateVariables";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OutreachMessage {
  id: number;
  leadName?: string;
  leadId?: number;
  channel: string;
  content?: string;
  message?: string;
  status: string;
  followUpStep?: number | null;
  isReply?: boolean | null;
  createdAt?: string;
  sentAt?: string;
}

interface OutreachStats {
  totalSent: number;
  totalMessages?:number;
  byChannel: Record<string, number | { sent?: number; delivered?: number; queued?: number; failed?: number }>;
  byStatus: {
    sent: number;
    pending: number;
    failed: number;
  };
}

interface OutreachCampaign {
  id: number;
  campaign_name?: string;
  name?: string;
  campaign_type: string;
  status: string;
  start_date?: string;
  created_at?: string;
  job_count?: number;
  sent_count?: number;
  delivered_count?: number;
  pending_count?: number;
  failed_count?: number;
  delivery_failed_count?: number;
  failed_before_enqueue_count?: number;
  cancelled_count?: number;
  manual_review_count?: number;
  last_error?: string;
  queue_issue?: string;
  settings?: { accountReviewRequired?: boolean };
}

interface CampaignsResponse {
  campaigns: OutreachCampaign[];
}

// ─── Channel config ───────────────────────────────────────────────────────────

const CHANNELS = [
  { key: "email", label: "Email", icon: Mail, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/10" },
  { key: "instagram", label: "Instagram", icon: Instagram, color: "text-violet-500", bg: "bg-violet-500/10" },
  { key: "facebook", label: "Facebook", icon: Facebook, color: "text-blue-600", bg: "bg-blue-500/10" },
  { key: "whatsapp", label: "WhatsApp", icon: MessageCircle, color: "text-green-600", bg: "bg-green-600/10" },
] as const;

// Where this page's meaning differs from the shared status map: anything still
// waiting reads as "needs attention", and a cancelled campaign is quiet, not an error.
const ACTIVITY_STATUS_TONES: Record<string, StatusTone> = {
  queued: "warning",
  scheduled: "warning",
  queued_partial: "warning",
  partial_success: "warning",
  needs_attention: "danger",
  cancelled: "neutral",
};

const STATUS_LABELS: Record<string, string> = {
  queued_partial: "Partially queued",
  partial_success: "Partial success",
  needs_attention: "Needs review",
};

function messagePreview(message: OutreachMessage): string {
  const raw = message.content || message.message || "";
  if (!raw.trim()) return "No message preview";
  return raw
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&copy;|&#169;/gi, "©")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "No message preview";
}

function followUpLabel(message: OutreachMessage): string | null {
  // On seed messages this field is sequence progress, and 9999 stops future
  // scheduling after a reply. Neither value describes this message's ordinal.
  if (message.isReply === false && message.followUpStep === 9999) return 'Follow-ups stopped';
  if (message.isReply === true && Number.isInteger(message.followUpStep) && Number(message.followUpStep) > 0 && Number(message.followUpStep) < 9999) return `Follow-up ${message.followUpStep}`;
  return null;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OutreachPage() {
  const { toast } = useToast();

  const [stats, setStats] = useState<OutreachStats | null>(null);
  const [recentMessages, setRecentMessages] = useState<OutreachMessage[]>([]);
  const [loadingStats, setLoadingStats] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<OutreachCampaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);
  const [campaignAction, setCampaignAction] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setLoadingStats(true);
      setStatsError(null);
      const data = await api.get<OutreachStats>("/api/outreach/stats");
      setStats(data);
    } catch (error: unknown) {
      setStatsError(error instanceof Error ? error.message : "Delivery totals could not be loaded");
    } finally {
      setLoadingStats(false);
    }
  }, []);

  const loadRecentMessages = useCallback(async () => {
    try {
      setLoadingMessages(true);
      setMessagesError(null);
      const data = await api.get<OutreachMessage[]>("/api/outreach/messages");
      setRecentMessages(Array.isArray(data) ? data.slice(0, 10) : []);
    } catch (error: unknown) {
      setMessagesError(error instanceof Error ? error.message : "Recent activity could not be loaded");
      setRecentMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  const loadCampaigns = useCallback(async () => {
    try {
      setLoadingCampaigns(true);
      setCampaignsError(null);
      const data = await api.get<CampaignsResponse>("/api/outreach/campaigns");
      setCampaigns(Array.isArray(data.campaigns) ? data.campaigns.slice(0, 8) : []);
    } catch (error: unknown) {
      setCampaignsError(error instanceof Error ? error.message : "Campaign delivery could not be loaded");
      setCampaigns([]);
    } finally {
      setLoadingCampaigns(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
    loadRecentMessages();
    loadCampaigns();
  }, [loadCampaigns, loadStats, loadRecentMessages]);

  const runCampaignAction = async (campaign: OutreachCampaign, action: "cancel" | "retry-failed") => {
    const actionKey = `${campaign.id}:${action}`;
    try {
      setCampaignAction(actionKey);
      const result = await api.post<{ message?: string }>(`/api/outreach/campaigns/${campaign.id}/${action}`);
      toast({
        title: action === "cancel" ? "Campaign cancelled" : "Retry queued",
        description: result.message,
      });
      await Promise.all([loadCampaigns(), loadStats(), loadRecentMessages()]);
    } catch (error) {
      toast({
        title: action === "cancel" ? "Could not cancel campaign" : "Could not retry campaign",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setCampaignAction(null);
    }
  };

  const getChannelIcon = (channel: string) => {
    const ch = CHANNELS.find((c) => c.key === channel.toLowerCase());
    if (ch) { const Icon = ch.icon; return <Icon className={`w-3.5 h-3.5 ${ch.color}`} />; }
    return <Send className="w-3.5 h-3.5" />;
  };

  const getStatusBadge = (status: string) => (
    <StatusBadge
      status={status}
      label={STATUS_LABELS[status.toLowerCase()]}
      toneOverrides={ACTIVITY_STATUS_TONES}
    />
  );

  return (
    <PageShell maxWidth="2xl" padding="md" className="outreach-workspace outreach-activity !space-y-3">
      <PageHeader
        icon={Send}
        title="Campaign activity"
        subtitle="Delivery status and recent outreach"
        className="workspace-heading"
        actions={<><Button variant="outline" size="sm" asChild><Link href="/dashboard/outreach/inbox"><Inbox className="mr-2 h-4 w-4" />Inbox</Link></Button><Button variant="outline" size="sm" asChild><Link href="/dashboard/outreach/follow-ups">Follow-ups</Link></Button></>}
      />
      <p className="rounded-xl border bg-muted/40 px-4 py-3 text-sm">
        Looking for one outreach, a template or a date range? <Link href="/dashboard/outreach/tracking" className="font-medium underline underline-offset-2">Open Message tracking</Link> to see sent, delivered, read and failed messages for each.
      </p>
      <div className="workspace-scope-notice"><Info className="h-4 w-4 shrink-0 text-primary" /><p>All outreach and follow-ups · current business</p></div>

      {(statsError || campaignsError || messagesError) && (
        <Callout
          tone="warning"
          role="alert"
          title="Some outreach data is unavailable"
          actions={
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void Promise.all([loadStats(), loadCampaigns(), loadRecentMessages()])}>
              <RotateCcw className="h-3.5 w-3.5" /> Retry all
            </Button>
          }
        >
          Loaded sections remain usable. Retry to reconcile delivery totals, campaigns, and activity.
        </Callout>
      )}

      <section className="workspace-metrics grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Outreach delivery summary">
        {loadingStats ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="border-b border-border px-4 py-4 odd:border-r [&:nth-child(n+3)]:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0">
                <Skeleton className="h-3 w-20 mb-2 rounded" />
                <Skeleton className="h-7 w-14 rounded" />
            </div>
          ))
        ) : (
          <>
            {[
              ["Messages", stats?.totalMessages ?? stats?.totalSent, "Across all channels"],
              ["Provider accepted", stats?.byStatus.sent, "Accepted for delivery"],
              ["Queued", stats?.byStatus.pending, "Waiting to send"],
              ["Failed", stats?.byStatus.failed, "Needs attention"],
            ].map(([label, value, detail]) => (
              <div key={String(label)} className="border-b border-border px-4 py-4 odd:border-r [&:nth-child(n+3)]:border-b-0 sm:px-5 lg:border-b-0 lg:border-r lg:last:border-r-0">
                <p className="text-xs font-medium text-muted-foreground">{label}</p>
                <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{typeof value === "number" ? value.toLocaleString() : "—"}</div>
                <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>
              </div>
            ))}
          </>
        )}
      </section>

      <OutreachQueue />

      {/* Durable campaign lifecycle */}
      <section className="workspace-panel rounded-lg border bg-card p-4" aria-labelledby="campaigns-heading">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 id="campaigns-heading" className="text-base font-semibold">Campaign delivery</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Queued sequences, retries, and delivery issues</p>
          </div>
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={loadCampaigns} loading={loadingCampaigns}>
            Refresh
          </Button>
        </div>

        <Card className="overflow-hidden rounded-none border-0 border-t shadow-none">
          <CardContent className="p-0">
            {loadingCampaigns ? (
              <div className="space-y-3 p-4">
                {Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="flex items-center gap-3 rounded-lg border border-border/40 p-3">
                    <Skeleton className="h-9 w-9 rounded-lg" />
                    <div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-40" /><Skeleton className="h-3 w-56" /></div>
                  </div>
                ))}
              </div>
            ) : campaignsError ? (
              <div className="m-4 rounded-lg border border-dashed border-amber-500/40 p-5 text-center">
                <p className="text-sm font-medium">Campaign delivery is unavailable</p>
                <p className="mt-1 text-xs text-muted-foreground">{campaignsError}</p>
              </div>
            ) : campaigns.length === 0 ? (
              <div className="mx-4 my-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border/40 py-10 text-center">
                <CalendarClock className="mb-3 h-6 w-6 text-muted-foreground/50" />
                <p className="text-sm font-medium">No queued campaigns</p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">Create an email or SMS campaign to track every sequence step here.</p>
              </div>
            ) : (
              <div className="overflow-x-auto"><table className="workspace-table w-full min-w-[950px] text-left text-xs"><caption className="sr-only">Campaign delivery, progress and available actions</caption><thead><tr>{['Campaign name','Channel · Status','Progress','Actions'].map(label => <th key={label} scope="col" className="px-3 py-2 font-medium">{label}</th>)}</tr></thead><tbody>
                {campaigns.map((campaign) => {
                  const failedBeforeEnqueue = Number(campaign.failed_before_enqueue_count || 0);
                  const total = Number(campaign.job_count || 0) + failedBeforeEnqueue;
                  const sent = Number(campaign.sent_count || 0);
                  const delivered = Number(campaign.delivered_count || 0);
                  const pending = Number(campaign.pending_count || 0);
                  const failed = Number(campaign.failed_count || 0);
                  const deliveryFailed = Number(campaign.delivery_failed_count || 0);
                  const manualReview = Number(campaign.manual_review_count || 0);
                  const progress = total > 0 ? Math.min(100, Math.round(((sent + failed + failedBeforeEnqueue + Number(campaign.cancelled_count || 0)) / total) * 100)) : 0;
                  const canCancel = ["draft", "scheduled", "queued", "queued_partial", "running", "paused", "failed", "partial_success", "needs_attention"].includes(campaign.status);
                  const historicalPaused = campaign.settings?.accountReviewRequired === true;
                  const canRetry = !historicalPaused && failed > manualReview;
                  return (
                    <tr key={campaign.id} className="transition-colors hover:bg-muted/20">
                      <th scope="row" className="max-w-[200px] break-words px-3 py-3 align-top font-semibold">{campaign.campaign_name || campaign.name || `Campaign ${campaign.id}`}</th>
                      <td className="px-3 py-3 align-top">
                          <div className="flex flex-wrap items-center gap-2">
                            {campaign.campaign_type === "sms" ? <MessageSquare className="h-4 w-4 text-primary" /> : <Mail className="h-4 w-4 text-primary" />}
                            <span className="capitalize">{campaign.campaign_type}</span>
                              {getStatusBadge(campaign.status)}
                              {manualReview > 0 && (
                                <Badge variant="destructive" className="h-5 gap-1 px-1.5 text-[10px]" title="The provider didn't confirm these sends. They are not resent automatically, to avoid duplicates.">
                                  <AlertTriangle className="h-3 w-3" /> {manualReview} pending confirmation
                                </Badge>
                              )}
                            </div>
                      </td>
                      <td className="max-w-[450px] px-3 py-3 align-top">
                            <p className="text-xs text-muted-foreground">
                              {sent} sent · {delivered} delivered · {pending} queued · {Math.max(0, failed - manualReview) + failedBeforeEnqueue + deliveryFailed} failed · {total} total steps
                            </p>
                            {failedBeforeEnqueue > 0 && (
                              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                                {failedBeforeEnqueue} could not be queued. Review those recipients before approving a new send.
                              </p>
                            )}
                            {campaign.queue_issue && (
                              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                                Queue confirmation needs review. Saved jobs may still send; check this campaign before approving another send.
                              </p>
                            )}
                            {historicalPaused && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Historical deliveries remain paused. Create a new draft and review its recipients and sending accounts before sending.</p>}
                            {campaign.last_error && failed > 0 && (
                              <p className="mt-1.5 line-clamp-2 text-xs text-destructive" title={campaign.last_error}>{campaign.last_error}</p>
                            )}
                        <div className="mt-2 flex max-w-xs items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-label={`${progress}% processed`}>
                            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
                          </div>
                          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{progress}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top"><div className="flex flex-wrap gap-2">
                          {campaign.status === "draft" && !historicalPaused && <Button asChild variant="outline" size="sm" className="h-8 text-xs"><Link href={`/dashboard/outreach/campaigns/${campaign.id}/review`}>Review delivery</Link></Button>}
                          {canRetry && (
                            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => runCampaignAction(campaign, "retry-failed")} loading={campaignAction === `${campaign.id}:retry-failed`} disabled={campaignAction !== null && campaignAction !== `${campaign.id}:retry-failed`}>
                              <RotateCcw className="h-3.5 w-3.5" />
                              Retry failed
                            </Button>
                          )}
                          {canCancel && (
                            <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => runCampaignAction(campaign, "cancel")} loading={campaignAction === `${campaign.id}:cancel`} disabled={campaignAction !== null && campaignAction !== `${campaign.id}:cancel`}>
                              <Ban className="h-3.5 w-3.5" />
                              Cancel
                            </Button>
                          )}
                      </div></td>
                    </tr>
                  );
                })}
              </tbody></table></div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Recent Activity */}
      <div className="workspace-panel rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Recent Activity</h2>
          <Button variant="ghost" size="sm" className="h-7 text-xs rounded-lg text-muted-foreground" onClick={loadRecentMessages}>
            Refresh
          </Button>
        </div>
        <Card className="rounded-none border-0 border-t shadow-none">
          <CardContent className="p-0">
            {loadingMessages ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 p-3 border border-border/30 rounded-xl">
                    <Skeleton className="h-7 w-7 rounded-md shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-32" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                    <Skeleton className="h-4 w-10 rounded-md" />
                  </div>
                ))}
              </div>
            ) : messagesError ? (
              <div className="m-4 rounded-lg border border-dashed border-amber-500/40 p-5 text-center">
                <p className="text-sm font-medium">Recent activity is unavailable</p>
                <p className="mt-1 text-xs text-muted-foreground">{messagesError}</p>
              </div>
            ) : recentMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 mx-4 my-4 border-2 border-dashed border-border/40 rounded-xl">
                <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mb-3">
                  <Send className="w-5 h-5 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium">No messages yet</p>
                <p className="text-xs text-muted-foreground mt-1">Start an outreach campaign to see activity here.</p>
              </div>
            ) : (
              <div className="overflow-x-auto"><table className="workspace-table w-full min-w-[700px] text-left text-xs"><caption className="sr-only">Recent outreach activity for the current business</caption><thead><tr>{['Contact','Channel','Status','Activity','Date'].map(label => <th key={label} scope="col" className="px-3 py-2 font-medium">{label}</th>)}</tr></thead><tbody>
                {recentMessages.map((msg) => (
                  <tr key={msg.id} className="hover:bg-muted/30 transition-colors">
                    <th scope="row" className="max-w-[180px] break-words px-3 py-3 font-medium">{msg.leadName || "Unknown Lead"}</th>
                    <td className="px-3 py-3"><span className="inline-flex items-center gap-2">{getChannelIcon(msg.channel)}<span className="capitalize">{msg.channel}</span></span></td>
                    <td className="px-3 py-3">{getStatusBadge(msg.status)}</td>
                    <td className="max-w-[360px] px-3 py-3"><div className="flex flex-wrap gap-1.5">
                        {followUpLabel(msg) && (
                          <Badge variant="outline" className="h-4 px-1.5 text-[9px]">{followUpLabel(msg)}</Badge>
                        )}
                        {findUnresolvedTemplateTokens(msg.content || msg.message).length > 0 && (
                          <Badge variant="outline" className="h-4 px-1.5 text-[9px] text-amber-700 dark:text-amber-300" title="Recorded message contains unresolved template variables. Review the original sent email.">Unresolved variables</Badge>
                        )}
                      </div><p className="mt-1 truncate text-xs text-muted-foreground" title={messagePreview(msg)}>
                        {messagePreview(msg)}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-[11px] text-muted-foreground">
                      {msg.sentAt || msg.createdAt
                        ? new Date(msg.sentAt || msg.createdAt || "").toLocaleDateString(undefined, { month: "short", day: "numeric" })
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
