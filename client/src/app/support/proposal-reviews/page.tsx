"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, FileCheck2, Loader2, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { supportApi, ApiError } from "@/lib/support-api";
import { cn } from "@/lib/utils";

type ReviewDecision = "pending" | "approved" | "changes_requested";
type ReviewLineItem = {
  id?: number;
  name?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  included?: boolean;
};
type ReviewSnapshot = {
  title?: string;
  proposalNumber?: string;
  recipientName?: string;
  recipientEmail?: string;
  currency?: string;
  coverNote?: string;
  lineItems?: ReviewLineItem[];
  discountType?: "percentage" | "fixed" | null;
  discountValue?: number;
  taxRate?: number;
  validUntil?: string | null;
  termsAndConditions?: string;
  showTermsAndConditions?: boolean;
  metadata?: {
    generatedSections?: Record<string, string>;
    deliveryTarget?: { channel?: string; recipientLabel?: string; providerAccountName?: string };
  };
};
type ProposalReview = {
  id: number;
  proposalId: number;
  reviewerMemberId: number;
  reviewerName: string;
  fingerprint: string;
  decision: ReviewDecision;
  comment: string | null;
  snapshot: ReviewSnapshot;
  createdAt: string;
  reviewedAt: string | null;
  revision: number;
  proposalStatus: string;
};
type Filter = "pending" | "all" | "approved" | "changes_requested";

const money = (currency: string, value: number) => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
};

function reviewTotal(snapshot: ReviewSnapshot) {
  const subtotal = (snapshot.lineItems || [])
    .filter((item) => item.included !== false)
    .reduce((sum, item) => sum + Number(item.quantity || 1) * Number(item.unitPrice || 0), 0);
  const discount = snapshot.discountType === "percentage"
    ? subtotal * Number(snapshot.discountValue || 0) / 100
    : Number(snapshot.discountValue || 0);
  const discounted = Math.max(0, subtotal - discount);
  return discounted + discounted * Number(snapshot.taxRate || 0) / 100;
}

function decisionLabel(value: ReviewDecision) {
  if (value === "changes_requested") return "Changes requested";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default function ProposalReviewsPage() {
  const { toast } = useToast();
  const [reviews, setReviews] = useState<ProposalReview[]>([]);
  const [filter, setFilter] = useState<Filter>("pending");
  const [comments, setComments] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState<number | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setReviews(await supportApi.get<ProposalReview[]>("/api/support-portal/proposal-reviews"));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Proposal reviews could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(
    () => reviews.filter((review) => filter === "all" || review.decision === filter),
    [filter, reviews],
  );
  const pendingCount = reviews.filter((review) => review.decision === "pending").length;

  const decide = async (review: ProposalReview, decision: "approved" | "changes_requested") => {
    const comment = (comments[review.id] ?? review.comment ?? "").trim();
    if (decision === "changes_requested" && !comment) {
      setError("Explain the required changes before returning the proposal.");
      return;
    }
    setDeciding(review.id);
    setError("");
    try {
      await supportApi.post(`/api/support-portal/proposal-reviews/${review.id}/decision`, {
        decision,
        comment,
        fingerprint: review.fingerprint,
      });
      toast({
        title: decision === "approved" ? "Proposal approved" : "Changes requested",
        description: decision === "approved"
          ? "The seller can continue once all assigned reviewers approve this version."
          : "The seller can revise the proposal using your feedback.",
      });
      await load();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "The review decision could not be saved.");
      await load();
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 [&_button]:min-h-10 [&_button]:min-w-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <FileCheck2 className="h-5 w-5 text-primary" aria-hidden="true" />
            <h1 className="text-xl font-semibold tracking-tight">Proposal reviews</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Review the exact customer, pricing, terms, and delivery target before a proposal is sent.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void load()} loading={loading} loadingText="Refreshing…">
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          Refresh
        </Button>
      </header>

      <section aria-label="Review filters" className="flex flex-wrap gap-2">
        {(["pending", "all", "approved", "changes_requested"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            className="min-h-10"
            variant={filter === value ? "default" : "outline"}
            onClick={() => setFilter(value)}
          >
            {value === "all" ? "All reviews" : decisionLabel(value)}
            {value === "pending" && <span className="ml-2 rounded-full bg-background/20 px-1.5 text-[11px]">{pendingCount}</span>}
          </Button>
        ))}
      </section>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{error}
        </div>
      )}

      {loading ? (
        <LoadingState className="min-h-48" label="Loading assigned reviews…" showLabel />
      ) : visible.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex min-h-52 flex-col items-center justify-center text-center">
            <CheckCircle2 className="h-9 w-9 text-success" aria-hidden="true" />
            <h2 className="mt-3 font-semibold">No {filter === "all" ? "assigned" : decisionLabel(filter).toLowerCase()} reviews</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">New requests appear here when a seller prepares a proposal that matches the workspace review policy.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5">
          {visible.map((review) => {
            const snapshot = review.snapshot || {};
            const currentComment = comments[review.id] ?? review.comment ?? "";
            const isPending = review.decision === "pending";
            return (
              <Card key={review.id} className="overflow-hidden border-border/70">
                <CardHeader className="border-b bg-muted/20 pb-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-lg">{snapshot.title || `Proposal #${review.proposalId}`}</CardTitle>
                        <Badge variant={review.decision === "approved" ? "default" : "outline"}>{decisionLabel(review.decision)}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {snapshot.proposalNumber || `Proposal ${review.proposalId}`} · requested {new Date(review.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <p className="text-xl font-semibold tabular-nums">{money(snapshot.currency || "USD", reviewTotal(snapshot))}</p>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5 p-5">
                  <dl className="grid gap-3 rounded-xl border bg-background p-4 text-sm sm:grid-cols-3">
                    <div><dt className="text-xs text-muted-foreground">Customer</dt><dd className="mt-1 font-medium">{snapshot.recipientName || "Unnamed customer"}</dd><dd className="text-xs text-muted-foreground">{snapshot.recipientEmail || "No email"}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Delivery</dt><dd className="mt-1 font-medium capitalize">{snapshot.metadata?.deliveryTarget?.channel || "Not selected"}</dd><dd className="text-xs text-muted-foreground">{snapshot.metadata?.deliveryTarget?.recipientLabel || snapshot.metadata?.deliveryTarget?.providerAccountName || "Resolved at send time"}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Validity</dt><dd className="mt-1 font-medium">{snapshot.validUntil ? new Date(snapshot.validUntil).toLocaleDateString() : "No expiry"}</dd><dd className="text-xs text-muted-foreground">Proposal revision {review.revision}</dd></div>
                  </dl>

                  {snapshot.coverNote && <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{snapshot.coverNote}</p>}

                  <div>
                    <h2 className="text-sm font-semibold">Included items</h2>
                    <div className="mt-2 divide-y rounded-xl border">
                      {(snapshot.lineItems || []).filter((item) => item.included !== false).map((item, index) => (
                        <div key={item.id ?? index} className="flex items-start justify-between gap-4 p-3 text-sm">
                          <div><p className="font-medium">{item.name || "Line item"}</p>{item.description && <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>}</div>
                          <p className="shrink-0 tabular-nums">{Number(item.quantity || 1)} × {money(snapshot.currency || "USD", Number(item.unitPrice || 0))}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {snapshot.showTermsAndConditions && snapshot.termsAndConditions && (
                    <details className="rounded-xl border p-3 text-sm">
                      <summary className="cursor-pointer font-medium">Terms and conditions</summary>
                      <p className="mt-3 whitespace-pre-wrap text-muted-foreground">{snapshot.termsAndConditions}</p>
                    </details>
                  )}

                  <label className="block space-y-2 text-sm font-medium">
                    Review comment {isPending && <span className="font-normal text-muted-foreground">(required when requesting changes)</span>}
                    <textarea
                      value={currentComment}
                      disabled={!isPending || deciding === review.id}
                      onChange={(event) => setComments((current) => ({ ...current, [review.id]: event.target.value }))}
                      maxLength={5000}
                      rows={3}
                      placeholder="Explain approval context or the exact changes needed."
                      className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2 font-normal outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>

                  {isPending ? (
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                      <Button type="button" variant="outline" disabled={deciding === review.id} onClick={() => void decide(review, "changes_requested")}>
                        {deciding === review.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}Request changes
                      </Button>
                      <Button type="button" disabled={deciding === review.id} onClick={() => void decide(review, "approved")}>
                        {deciding === review.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}Approve this version
                      </Button>
                    </div>
                  ) : (
                    <div className={cn("flex items-start gap-2 rounded-xl p-3 text-sm", review.decision === "approved" ? "bg-success/10 text-success" : "bg-warning/10 text-warning")}>
                      {review.decision === "approved" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                      <div><strong>{decisionLabel(review.decision)}</strong>{review.reviewedAt && <span> on {new Date(review.reviewedAt).toLocaleString()}</span>}{review.comment && <p className="mt-1 whitespace-pre-wrap">{review.comment}</p>}</div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
