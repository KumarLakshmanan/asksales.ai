"use client";

import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Loader2,
  Lock,
  Save,
  Send,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cn } from "@/lib/utils";
import { useWidgets } from "./WidgetContext";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary";
import { widgetRegistry } from "./registry";
import type { WidgetState } from "./types";
import { useSocialPublishReceipt, type SocialPublishReceipt } from '@/hooks/useSocialPublishReceipt';
import { publishingStatusLabel } from '@/lib/socialPublishing';
import { widgetDestination } from '@/lib/widget-destination';
import { AGENT_NAMES } from '@/lib/agent-personas';
import { toUserFacingError } from '../../../../shared/userFacingError';
import { canDeleteWidgetReview, canEditWidgetReview, isRetrySafeExecutionResult } from '../../../../shared/toolExecutionReceipt';

interface InlineWidgetCardProps {
  widget: WidgetState;
  onSubmitted?: () => void;
}

/**
 * Beautiful UI-inspired human-in-the-loop review card.
 * Agent work stays in the conversation instead of opening a blocking,
 * full-width drawer on route load.
 */
export function InlineWidgetCard({ widget, onSubmitted }: InlineWidgetCardProps) {
  const { submitWidget, updateFormValues, closeWidget } = useWidgets();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [localFormValues, setLocalFormValues] = useState<Record<string, unknown>>(widget.formValues || {});
  const [isReady, setIsReady] = useState(false);
  const [isExpanded, setIsExpanded] = useState(
    widget.status === "active" || widget.status === "draft" || widget.status === "failed",
  );
  useEffect(() => {
    setLocalFormValues(widget.formValues || {});
    setSubmitError(null);
    setIsReady(false);
    setIsExpanded(widget.status === "active" || widget.status === "draft" || widget.status === "failed");
    const timer = setTimeout(() => setIsReady(true), 50);
    return () => clearTimeout(timer);
  // Server autosave acknowledgements update widget.formValues. They must not
  // unmount and recreate the controlled form while the user is still typing,
  // because an older acknowledgement can otherwise erase a newer edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.id, widget.status]);

  const widgetDef = widgetRegistry[widget.widgetType as keyof typeof widgetRegistry];
  const executionResult = widget.executionResult as Record<string, unknown> | null | undefined;
  const nestedOutput = executionResult?.output as Record<string, unknown> | undefined;
  const receipt = useSocialPublishReceipt(widget.widgetType === 'publish_post' ? (nestedOutput || executionResult || undefined) as SocialPublishReceipt | undefined : undefined);
  const partiallyPublished = receipt?.partialSuccess === true;
  const deliveryResults = Object.values(receipt?.results || {});
  const allPublished = deliveryResults.length > 0 && deliveryResults.every(entry => entry.status === 'succeeded');
  const deliveryWarning = allPublished && deliveryResults.some(entry => entry.error);
  const allCancelled = deliveryResults.length > 0 && deliveryResults.every(entry => entry.status === 'cancelled');
  const deliveryNeedsAttention = deliveryResults.length > 0 && deliveryResults.every(entry => ['failed', 'ambiguous', 'remote_deleted'].includes(entry.status || ''));
  if (!widgetDef) return null;

  const WidgetComponent = widgetDef.component;
  const isRunning = widget.status === "running";
  const isQueued = widget.status === "queued";
  const isProviderSucceeded = widget.status === "provider_succeeded";
  const isSucceeded = widget.status === "succeeded";
  const isCancelled = widget.status === "cancelled";
  const isFailed = widget.status === "failed";
  const retrySafe = isFailed && isRetrySafeExecutionResult(executionResult);
  const reviewValidationError = typeof localFormValues._review_validation_error === "string"
    ? localFormValues._review_validation_error
    : null;
  const isTerminal = isSucceeded || isFailed || isQueued || isProviderSucceeded || isCancelled;
  const isEditable = canEditWidgetReview(widget);
  const uncertainCancelledReceipt = isCancelled && !canDeleteWidgetReview(widget);

  const status = isCancelled || allCancelled
    ? { label: "Cancelled", icon: XCircle, className: "bg-muted text-muted-foreground" }
    : partiallyPublished
    ? { label: 'Partially published', icon: CircleAlert, className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' }
    : receipt?.scheduled
    ? { label: 'Scheduled', icon: Clock3, className: 'bg-blue-500/10 text-blue-700 dark:text-blue-300' }
    : receipt?.accepted
    ? { label: 'Publishing', icon: Loader2, className: 'bg-blue-500/10 text-blue-700 dark:text-blue-300' }
    : receipt?.status === 'failed' || deliveryNeedsAttention
    ? { label: 'Publishing needs attention', icon: CircleAlert, className: 'bg-destructive/10 text-destructive' }
    : allPublished
    ? { label: deliveryWarning ? 'Published with a warning' : 'Published', icon: deliveryWarning ? CircleAlert : CheckCircle2, className: deliveryWarning ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' }
    : isSucceeded
    ? { label: "Completed", icon: CheckCircle2, className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" }
    : isFailed
      ? { label: retrySafe ? "Retry available" : "Failed", icon: XCircle, className: "bg-destructive/10 text-destructive" }
      : isRunning
        ? { label: "Running", icon: Loader2, className: "bg-blue-500/10 text-blue-700 dark:text-blue-300" }
        : isQueued || isProviderSucceeded
          ? { label: isProviderSucceeded ? "Reconciling" : "Queued", icon: Clock3, className: "bg-amber-500/10 text-amber-700 dark:text-amber-300" }
          : widget.status === "draft"
            ? { label: "Draft", icon: Save, className: "bg-muted text-muted-foreground" }
            : { label: "Needs review", icon: CircleAlert, className: "bg-amber-500/10 text-amber-700 dark:text-amber-300" };
  const StatusIcon = status.icon;
  const destination = widgetDestination(widget.toolName, widget.submittedValues || widget.formValues || {});

  const handleSubmit = async () => {
    if (!isEditable) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await submitWidget(widget.id, localFormValues);
      setIsExpanded(false);
      onSubmitted?.();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to submit");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!isEditable) return;
    setIsSavingDraft(true);
    setSubmitError(null);
    try {
      await closeWidget(widget.id, localFormValues);
      setIsExpanded(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to save draft");
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleFormChange = (values: Record<string, unknown>) => {
    if (!isEditable) return;
    setLocalFormValues(values);
    updateFormValues(widget.id, values);
  };

  return (
    <section
      data-widget-review={widget.id}
      aria-label={`${widgetDef.title} agent task`}
      className={cn(
        "@container/review mt-5 w-full max-w-[42rem] overflow-hidden rounded-[14px] border bg-card shadow-sm",
        isEditable ? "border-l-2 border-l-primary" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        aria-expanded={isExpanded}
        className="flex min-h-16 w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5"
      >
        <span className="min-w-0 flex-1">
          <span className="mb-1 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            {widget.agentType ? AGENT_NAMES[widget.agentType] || widget.agentType.replaceAll('_', ' ') : 'Agent'} · review #{widget.id}
          </span>
          <span className="block text-sm font-semibold leading-5 text-foreground">{widgetDef.title}</span>
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{widgetDef.description}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 pt-0.5">
          <span aria-live="polite" className={cn("inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold", status.className)}>
            <StatusIcon className={cn("h-3 w-3", isRunning && "animate-spin")} aria-hidden="true" />
            {status.label}
          </span>
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          )}
        </span>
      </button>

      {receipt?.results && <div className="space-y-2 border-t p-4 text-xs" aria-label="Publishing results">{Object.entries(receipt.results).map(([platform, entry]) => <div key={platform} className="space-y-1"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium capitalize">{platform}</span><span>{publishingStatusLabel(entry.status, receipt.scheduled)}</span></div>{entry.error && <p className="break-words text-destructive">{entry.error}</p>}{entry.postUrl && <a href={entry.postUrl} target="_blank" rel="noreferrer" className="text-primary underline">View published post</a>}</div>)}<a className="inline-block pt-2 font-medium text-primary underline" href={`/dashboard/content-calendar${receipt.assetId ? `?assetId=${receipt.assetId}` : ''}`}>View delivery details and recovery options</a></div>}

      {destination && <div className="border-t px-4 py-2 text-xs"><a href={destination.href} className="font-medium text-primary underline">{destination.label}</a><span className="ml-2 text-muted-foreground">Review #{widget.id} · local status: {widget.status}</span></div>}

      {isExpanded ? (
        <div className="border-t border-border/60">
          <div className="bg-muted/25 p-4 sm:p-5">
            {isReady ? (
              <WidgetErrorBoundary title={`${widgetDef.title} needs attention`}>
                <fieldset disabled={!isEditable} className={!isEditable ? "min-w-0 pointer-events-none opacity-75" : "min-w-0"}>
                  <WidgetComponent
                    widget={widget}
                    onClose={() => setIsExpanded(false)}
                    onSubmit={handleSubmit}
                    onFormChange={handleFormChange}
                  />
                </fieldset>
              </WidgetErrorBoundary>
            ) : (
              <div className="space-y-2.5 py-1" aria-label="Loading task">
                <div className="h-4 w-2/3 animate-pulse rounded-md bg-muted" />
                <div className="h-20 animate-pulse rounded-xl bg-muted" />
              </div>
            )}
          </div>

          {submitError ? (
            <Callout tone="danger" size="sm" className="mx-4 mt-3 w-auto">
              {submitError}
            </Callout>
          ) : null}

          {reviewValidationError && isEditable ? (
            <Callout tone="warning" size="sm" role="alert" className="mx-4 mt-3 w-auto">
              {reviewValidationError}
            </Callout>
          ) : null}

          {isEditable ? (
            <div className="flex flex-col items-stretch gap-3 border-t border-border p-3 @md/review:flex-row @md/review:items-center @md/review:px-5">
              <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">Review the fields above before you authorize this action.</p>
              <div className="grid w-full min-w-0 grid-cols-1 gap-2 @xs/review:grid-cols-2 @md/review:ml-auto @md/review:w-auto">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleSaveDraft}
                  loading={isSavingDraft}
                  loadingText="Save draft"
                  disabled={isSubmitting}
                  className="h-9 min-w-0 whitespace-nowrap px-3 text-xs"
                >
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  Save draft
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSubmit}
                  loading={isSubmitting}
                  loadingText={retrySafe ? "Retry safely" : "Confirm and run"}
                  disabled={!isReady || isSavingDraft || Boolean(reviewValidationError)}
                  className="h-9 min-w-0 whitespace-nowrap px-3.5 text-xs"
                >
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  {retrySafe ? "Retry safely" : "Confirm and run"}
                </Button>
              </div>
            </div>
          ) : null}

          {(isRunning || isTerminal) ? (
            <div className={cn(
              "flex items-center gap-1.5 border-t px-4 py-2.5 text-[11px] leading-4",
              isCancelled
                ? "border-border bg-muted/40 text-muted-foreground"
                : isFailed
                ? "border-destructive/20 bg-destructive/5 text-destructive"
                : isRunning
                  ? "border-blue-200/40 bg-blue-50/40 text-blue-700 dark:bg-blue-950/20 dark:text-blue-300"
                  : isQueued || isProviderSucceeded
                    ? "border-amber-200/40 bg-amber-50/40 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300"
                    : "border-emerald-100/40 bg-emerald-50/40 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300",
            )}>
              <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {isCancelled
                ? uncertainCancelledReceipt
                  ? "This review has an unconfirmed execution receipt and requires reconciliation. Do not repeat the operation."
                  : "Cancelled before execution. This review is read-only and cannot run."
                : deliveryNeedsAttention
                ? "Publishing needs attention. Open delivery details to recover the affected destinations safely."
                : allPublished
                ? deliveryWarning ? "The post is published. Open the provider link to finish the optional settings; do not publish again." : "All destinations confirmed publication."
                : isRunning
                ? widget.progress?.message
                  ? <span role="status" aria-live="polite">{widget.progress.message}{widget.progress.total > 1 ? ` (${Math.min(widget.progress.completed, widget.progress.total)}/${widget.progress.total})` : ""}</span>
                  : "Execution is in progress and cannot be submitted twice."
                : isProviderSucceeded
                  ? "The provider accepted this operation; local reconciliation is pending."
                  : isQueued
                    ? "Queued for worker execution."
                    : isFailed
                      ? retrySafe
                        ? "This attempt failed before any side effect and may be retried safely."
                        : (widget.executionError ? toUserFacingError(widget.executionError) : "Execution failed. No success was recorded.")
                      : partiallyPublished ? 'Some destinations published. Open delivery details to recover the remaining destinations.' : receipt?.scheduled ? 'Reviewed posts are scheduled. The calendar tracks each destination.' : receipt?.accepted ? 'Publishing is in progress. Status updates appear above.' : receipt?.status === 'failed' ? 'Publishing needs attention. Open delivery details for recovery options.' : "The local action completed. Check the destination for provider delivery or activation."}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
