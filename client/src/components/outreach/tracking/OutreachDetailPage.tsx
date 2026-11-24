"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Inbox, RefreshCw, Send } from "lucide-react";
import { creatorSessionScope } from "@/lib/creator-session";
import { subscribeBusinessProfile } from "@/lib/business-profile";
import { useTrackingQuery } from "@/hooks/use-outreach-tracking";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { PageErrorState, PageLoadingState } from "@/components/ui/page-state";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import { PageEmptyState } from "@/components/EmptyState";
import {
  activeOutreachProgress, deliveredCount, failedCount, outreachProgress, outreachTrackingUrl, reachedCount, trackingChannelLabel, waitingCount,
  type OutreachBatchSummary, type RecipientFilter,
} from "../../../../../shared/outreachTracking";
import { addDays, toDateValue, type DateRange } from "@/components/ui/date-range-field";
import { DayByDayCard } from "./DayByDayCard";
import { DeliveryBreakdown } from "./DeliveryBreakdown";
import { FailuresCard } from "./FailuresCard";
import { RecipientDownload } from "./RecipientDownload";
import { RenameOutreach } from "./RenameOutreach";
import { FollowUpsCard } from "./FollowUpsCard";
import { RecipientsCard, type MessageKind } from "./RecipientsCard";
import { UpcomingScheduleCard } from "./UpcomingScheduleCard";
import { formatCount, formatDateTime, formatShare, receiptNote, receiptValue } from "./status";

/**
 * The days the outreach was active: from its start to its last activity (today
 * while it is still going), showing the most recent 30 days of that at most.
 */
function activityRange(createdAt: string, lastActivityAt: string | null, active: boolean): DateRange {
  const today = toDateValue(new Date()), started = toDateValue(new Date(createdAt));
  const last = !active && lastActivityAt ? toDateValue(new Date(lastActivityAt)) : today;
  const to = last > today ? today : last < started ? started : last, earliest = addDays(to, -29);
  return { from: started > to ? to : started < earliest ? earliest : started, to };
}

const stillChanging = (summary: OutreachBatchSummary) =>
  activeOutreachProgress.includes(outreachProgress(summary.counts, summary.batch.admission));

export function OutreachDetailPage({ id }: { id: string }) {
  // Remount on a business switch so one business's outreach never shows under another.
  const scope = useSyncExternalStore(subscribeBusinessProfile, creatorSessionScope, () => "anonymous");
  return <OutreachDetailPanel key={`${scope}:${id}`} id={id} />;
}

function OutreachDetailPanel({ id }: { id: string }) {
  const router = useRouter();
  // While messages are still going out the numbers refresh on their own; the recipient list only changes on request.
  const summary = useTrackingQuery<OutreachBatchSummary>(`/api/outreach/batches/${id}`, {}, 15_000, stillChanging);
  const [filter, setFilter] = useState<RecipientFilter>("all");
  const [kind, setKind] = useState<MessageKind>("outreach");
  const [refreshVersion, setRefreshVersion] = useState(0);

  const showRecipients = (next: RecipientFilter, nextKind: MessageKind = "outreach") => {
    setKind(nextKind);
    setFilter(next);
    document.getElementById("recipients")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  if (summary.notFound) {
    return (
      <PageShell>
        <PageEmptyState icon={Send} title="This outreach isn't available"
          description="It may belong to another business, or it may have been removed."
          action={{ label: "Back to Message tracking", onClick: () => router.push(outreachTrackingUrl()) }} />
      </PageShell>
    );
  }
  if (!summary.data) {
    return summary.error
      ? <PageErrorState reset={summary.refetch} title="We couldn't load this outreach" description="The request did not complete. Try again." />
      : <PageLoadingState label="Loading this outreach…" />;
  }

  const { batch, counts, followUps, skippedReasons, nextAttemptAt, lastActivityAt } = summary.data;
  const reached = reachedCount(counts), delivered = deliveredCount(counts), failed = failedCount(counts), waiting = waitingCount(counts);
  const noReceipts = batch.receiptSupport === "none";
  const scheduledAhead =batch.scheduledAt && new Date(batch.scheduledAt).getTime() > Date.now() && reached === 0;
  const subtitle = [
    trackingChannelLabel(batch.channel),
    batch.templateName ? `Template: ${batch.templateName}${batch.templateLanguage ? ` (${batch.templateLanguage})` : ""}` : null,
    `Started ${formatDateTime(batch.createdAt)}`,
  ].filter(Boolean).join(" · ");

  return (
    <PageShell>
      <Link href={outreachTrackingUrl()} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />All outreaches
      </Link>
      <PageHeader
        icon={Send}
        eyebrow="Message tracking"
        title={batch.name}
        subtitle={subtitle}
        actions={<>
          <Button variant="outline" loading={summary.loading} loadingText="Refreshing…"
            onClick={() => { summary.refetch(); setRefreshVersion(version => version + 1); }}>
            <RefreshCw aria-hidden="true" />Refresh
          </Button>
          <RenameOutreach batchId={id} name={batch.name} onRenamed={summary.refetch} />
          <RecipientDownload batchId={id} hasFollowUps={summary.data.followUps.total > 0} />
          <Button variant="outline" asChild><Link href="/dashboard/outreach/inbox"><Inbox aria-hidden="true" />Open Inbox</Link></Button>
        </>}
      />
      {summary.updatedAt ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Updated {new Date(summary.updatedAt).toLocaleTimeString()}{stillChanging(summary.data) ? " · refreshes automatically while messages are going out" : ""}
        </p>
      ) : null}

      {batch.source === "legacy_inferred" ? (
        <Callout tone="neutral" title="Grouped automatically">
          These messages were sent before Message tracking existed, so they were grouped by channel, template and send time. Rename this outreach to something you&apos;ll recognise.
        </Callout>
      ) : null}
      {batch.admission === "admitting" ? (
        <Callout tone="info" title="This outreach is still being prepared">Recipients appear here as they are added to the queue.</Callout>
      ) : null}
      {batch.admission === "interrupted" ? (
        <Callout tone="warning" title="Preparing this outreach was interrupted">
          Some recipients may not have been queued. The numbers below show the messages that were saved.
        </Callout>
      ) : null}
      {scheduledAhead ? <Callout tone="info" title={`Scheduled for ${formatDateTime(batch.scheduledAt)}`}>Sending starts on its own at that time.</Callout> : null}
      {counts.waitingLimit > 0 ? (
        <Callout tone="warning" title={`${formatCount(counts.waitingLimit)} ${counts.waitingLimit === 1 ? "message is" : "messages are"} waiting for a sending limit`}>
          {batch.channel === "whatsapp"
            // WhatsApp also holds marketing messages to people who got several recently (131049), retried hours later.
            ? "They go out on their own once the limit allows: your daily sending limit, or WhatsApp's limit on marketing messages to the same person, which is retried a few hours later."
            : "They go out on their own as the limit resets each day."}
          {nextAttemptAt ? ` Next send: ${formatDateTime(nextAttemptAt)}.` : ""}
          {batch.expiresAt ? ` Anything not sent by ${formatDateTime(batch.expiresAt)} will expire.` : ""}
        </Callout>
      ) : null}
      {counts.needsAttention > 0 ? (
        <Callout tone="danger" title={`${formatCount(counts.needsAttention)} ${counts.needsAttention === 1 ? "message needs" : "messages need"} your attention`}
          actions={<Button variant="outline" size="sm" onClick={() => showRecipients("needs_attention")}>Show these recipients</Button>}>
          These were not sent and will not be retried on their own.
        </Callout>
      ) : null}

      <StatGrid columns={3} className="grid-cols-2 xl:grid-cols-6" aria-label="Delivery summary" role="group">
        <StatCard label="Recipients" value={formatCount(counts.total)}
          description={batch.skipped > 0 ? `${formatCount(batch.skipped)} skipped before sending` : "In this outreach"} />
        <StatCard label="Sent" value={formatCount(reached)} description={`${formatShare(reached, counts.total)} of recipients`} />
        <StatCard label="Delivered" value={receiptValue(batch.receiptSupport, delivered)}
          description={noReceipts ? "The channel doesn't report this" : `${formatShare(delivered, reached)} of sent`} />
        <StatCard label="Read" value={receiptValue(batch.receiptSupport, counts.read)}
          description={noReceipts ? "The channel doesn't report this" : `${formatShare(counts.read, delivered)} of delivered`} />
        <StatCard label="Failed" value={formatCount(failed)} tone={failed > 0 ? "destructive" : "neutral"}
          description={counts.expired > 0 ? `Includes ${formatCount(counts.expired)} expired` : failed > 0 ? "See the reasons below" : "None so far"} />
        <StatCard label="Still waiting" value={formatCount(waiting)} tone={waiting > 0 ? "warning" : "neutral"}
          description={waiting === 0 ? "Nothing left to send" : nextAttemptAt ? `Next send ${formatDateTime(nextAttemptAt)}` : "Going out as capacity allows"} />
      </StatGrid>
      {batch.channel === "whatsapp" ? (
        <p className="text-xs text-muted-foreground">
          Read counts depend on each person&apos;s WhatsApp privacy settings, so the real number is usually higher.
        </p>
      ) : receiptNote(batch.receiptSupport, batch.channel) ? (
        <p className="text-xs text-muted-foreground">{receiptNote(batch.receiptSupport, batch.channel)}</p>
      ) : null}

      <DeliveryBreakdown counts={counts} selected={filter} onSelect={showRecipients} />

      {skippedReasons.length > 0 ? (
        <Callout tone="neutral" title={`${formatCount(batch.skipped)} ${batch.skipped === 1 ? "recipient was" : "recipients were"} skipped before sending`}>
          <ul className="mt-1 space-y-1">
            {skippedReasons.map(item => (
              <li key={item.reason} className="flex gap-3">
                <span className="w-14 shrink-0 text-right font-medium tabular-nums">{formatCount(item.count)}</span>
                <span className="min-w-0 break-words">{item.reason}</span>
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <DayByDayCard title="Day by day" description="What was sent, delivered, read and failed on each day of this outreach."
        endpoint={`/api/outreach/batches/${id}/daily`} subject={batch.name} defaultRange={activityRange(batch.createdAt, lastActivityAt, stillChanging(summary.data))} refreshVersion={refreshVersion} />

      {waiting > 0 ? (
        <UpcomingScheduleCard endpoint={`/api/outreach/batches/${id}/upcoming`} refreshVersion={refreshVersion}
          description="What is still waiting to go out for this outreach, and what your daily limit should let through each day." />
      ) : null}

      {followUps.total > 0 ? (
        <FollowUpsCard counts={followUps} receiptSupport={batch.receiptSupport} onShowRecipients={next => showRecipients(next, "follow_up")} />
      ) : null}

      <FailuresCard batchId={id} problemCount={failed + counts.needsAttention} refreshVersion={refreshVersion}
        onShowRecipients={() => showRecipients(failed > 0 ? "failed" : "needs_attention")} />
      <RecipientsCard batchId={id} channel={batch.channel} counts={counts} followUps={followUps} filter={filter} onFilterChange={setFilter}
        kind={kind} onKindChange={next => { setKind(next); setFilter("all"); }} refreshVersion={refreshVersion} />
    </PageShell>
  );
}
