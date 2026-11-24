"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ShieldCheck } from "lucide-react";
import api from "@/lib/admin-api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  addCalendarMonths, formatCredits, formatRupees,
  type BillingTerm, type OrganizationEntitlements, type SubscriptionAccess,
  type SubscriptionCatalog, type SubscriptionSummary,
} from "../../../../shared/subscriptions";

type AdminTerm = {
  id: string; version: number; slug: string; term: BillingTerm;
  startsAt: string; endsAt: string; reason: string; status: "active" | "scheduled";
};
type Overview = {
  organization: { id: number; name: string; ownerUserId: number; ownerEmail: string };
  current: SubscriptionSummary | null;
  pending: SubscriptionSummary | null;
  access: SubscriptionAccess;
  nextDepositAt: string | null;
  entitlements: OrganizationEntitlements;
  adminTerms: AdminTerm[];
  catalog: SubscriptionCatalog;
  depositPending?: boolean;
};
type ReviewAction = "assign" | "end_active" | "end_scheduled" | null;

function date(value: string | Date | null | undefined) {
  if (!value) return "Not scheduled";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Not scheduled" : parsed.toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

export default function AdminPlanAssignment({
  organizationId, onChanged,
}: {
  organizationId: number | null;
  onChanged?: () => void | Promise<unknown>;
}) {
  const query = useQuery({
    queryKey: ["admin-organization-plan", organizationId],
    queryFn: () => api.get<Overview>(`/api/admin/subscriptions/organizations/${organizationId}/plan`),
    enabled: !!organizationId,
  });
  const [planSlug, setPlanSlug] = useState("");
  const [term, setTerm] = useState<BillingTerm>("monthly");
  const [timing, setTiming] = useState<"now" | "at_term_end">("now");
  const [reason, setReason] = useState("");
  const [review, setReview] = useState<ReviewAction>(null);
  const [reviewTarget, setReviewTarget] = useState<number | null>(null);
  const beginReview = (action: ReviewAction) => { setReviewTarget(organizationId); setReview(action); };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const overview = query.data;
  const now = Date.now();
  const current = overview?.current?.paidThrough && new Date(overview.current.paidThrough).getTime() > now
    ? overview.current : null;
  const paidCurrent = current?.source !== "admin" && overview?.access.reason === "paid";
  const activeAdmin = overview?.adminTerms.find(item => item.status === "active");
  const scheduledAdmin = overview?.adminTerms.find(item => item.status === "scheduled");
  const hasActiveTerm = !!current;
  const plans = overview?.catalog.plans ?? [];
  const chosen = plans.find(item => item.slug === planSlug) ?? plans[0];

  useEffect(() => {
    setReview(null); setReason(""); setError(""); setNotice("");
    setPlanSlug(""); setTerm("monthly");
  }, [organizationId]);

  useEffect(() => {
    if (!overview) return;
    setPlanSlug(previous => overview.catalog.plans.some(plan => plan.slug === previous)
      ? previous : overview.catalog.plans[0]?.slug ?? "");
  }, [overview]);
  useEffect(() => {
    setTiming(paidCurrent ? "at_term_end" : "now");
  }, [organizationId, paidCurrent]);

  const startDate = timing === "at_term_end" && current?.paidThrough
    ? new Date(current.paidThrough) : new Date();
  const endDate = addCalendarMonths(startDate, term === "yearly" ? 12 : 1);
  const valid = !!organizationId && !!chosen && reason.trim().length >= 3 && reason.trim().length <= 500
    && (timing === "now" ? !paidCurrent : hasActiveTerm);

  const apply = async () => {
    if (!organizationId || reviewTarget !== organizationId || !review || busy || reason.trim().length < 3 || !chosen) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (review === "assign") {
        if (!valid) return;
        const updated = await api.post<Overview>(
          `/api/admin/subscriptions/organizations/${organizationId}/plan`,
          { catalogVersion: overview!.catalog.version, plan: chosen.slug, term, timing, reason: reason.trim() },
        );
        setNotice(updated.depositPending
          ? "Plan assigned. Its credit deposit is queued for the next billing worker run."
          : `${chosen.name} assigned to ${updated.organization.name}. No payment or invoice was created.`);
      } else {
        await api.post<Overview>(`/api/admin/subscriptions/organizations/${organizationId}/plan/end`, {
          scope: review === "end_scheduled" ? "scheduled" : "active", reason: reason.trim(),
        });
        setNotice(review === "end_scheduled" ? "Scheduled plan change cancelled." : "Administrator plan ended. Deposited credits remain in the wallet.");
      }
      setReason(""); setReview(null);
      await query.refetch();
      await onChanged?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The plan change could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  if (!organizationId) return <section className="max-w-3xl rounded-[14px] border border-dashed border-border p-6 text-sm text-muted-foreground">
    Select a billing account above to assign or change its plan.
  </section>;

  return <section aria-labelledby="admin-plan-heading" className="max-w-3xl rounded-[14px] border border-border bg-card p-5 sm:p-7">
    <div className="flex items-start gap-3">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <ShieldCheck className="h-5 w-5" aria-hidden />
      </div>
      <div>
        <h2 id="admin-plan-heading" className="text-xl font-semibold">Assign or change a plan</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">Complimentary administrator assignments use the published catalog. They create no payment or invoice.</p>
      </div>
    </div>

    {query.isPending ? <p role="status" className="mt-6 text-sm text-muted-foreground">Loading this account’s plan…</p>
      : query.isError ? <Callout tone="danger" className="mt-6">
        Plan details could not be loaded. <button type="button" className="text-primary underline" onClick={() => void query.refetch()}>Try again</button>
      </Callout> : overview && <>
        <div className="mt-6 grid gap-3 rounded-xl border border-border bg-muted/30 p-4 text-sm sm:grid-cols-2">
          <div><p className="text-xs text-muted-foreground">Billing account</p><p className="mt-1 font-semibold">{overview.organization.name}</p>
            <p className="mt-1 break-all text-xs text-muted-foreground">{overview.organization.ownerEmail} · Owner #{overview.organization.ownerUserId}</p></div>
          <div><p className="text-xs text-muted-foreground">Current plan</p><p className="mt-1 font-semibold">{current?.name ?? "No active plan"}
            {current?.source === "admin" ? " · Admin assigned" : current ? " · Paid" : ""}</p>
            <p className="mt-1 text-xs text-muted-foreground">{current ? `Ends ${date(current.paidThrough)}` : "No active term"}
              {overview.nextDepositAt ? ` · Next deposit ${date(overview.nextDepositAt)}` : ""}</p></div>
        </div>
        {scheduledAdmin && <Callout tone="info" icon={CalendarDays} className="mt-4">
          {scheduledAdmin.slug} is scheduled for {date(scheduledAdmin.startsAt)} through {date(scheduledAdmin.endsAt)}.
        </Callout>}
        {error && <Callout tone="danger" className="mt-4">{error}</Callout>}
        {notice && <Callout tone="success" announce className="mt-4">{notice}</Callout>}

        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <div><Label htmlFor="admin-plan-choice">Published plan</Label>
            <select id="admin-plan-choice" value={chosen?.slug ?? ""} disabled={busy} onChange={event => { setPlanSlug(event.target.value); setReview(null); }}
              className="mt-2 min-h-11 w-full rounded-[10px] border border-border bg-background px-3 text-sm focus-visible:outline-primary">
              {plans.map(plan => <option key={plan.slug} value={plan.slug}>{plan.name} · {formatCredits(plan.monthlyCredits)} credits/month</option>)}
            </select></div>
          <div><Label htmlFor="admin-plan-term">Plan term</Label>
            <select id="admin-plan-term" value={term} disabled={busy} onChange={event => { setTerm(event.target.value as BillingTerm); setReview(null); }}
              className="mt-2 min-h-11 w-full rounded-[10px] border border-border bg-background px-3 text-sm focus-visible:outline-primary">
              <option value="monthly">Monthly · one month</option><option value="yearly">Yearly · twelve months</option>
            </select></div>
        </div>
        <div className="mt-5"><Label htmlFor="admin-plan-timing">When should this plan start?</Label>
          <select id="admin-plan-timing" value={timing} disabled={busy} onChange={event => { setTiming(event.target.value as "now" | "at_term_end"); setReview(null); }}
            className="mt-2 min-h-11 w-full rounded-[10px] border border-border bg-background px-3 text-sm focus-visible:outline-primary">
            <option value="now" disabled={!!paidCurrent}>Now{paidCurrent ? " · paid term still active" : ""}</option>
            <option value="at_term_end" disabled={!hasActiveTerm}>At current term end</option>
          </select>
        </div>
        {chosen && <div className="mt-5 rounded-xl border border-border bg-background p-4 text-sm">
          <p className="font-semibold">{chosen.name} · {term} · {formatCredits(chosen.monthlyCredits)} credits each month</p>
          <p className="mt-1 text-muted-foreground">Starts {date(startDate)} · Ends {date(endDate)}. List price {formatRupees(term === "yearly" ? chosen.yearlyRupees : chosen.monthlyRupees)}; this admin assignment charges ₹0.</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">The first credit deposit arrives when the assignment starts. Yearly assignments deposit monthly. Existing wallet credits remain. A change now ends future deposits from the previous admin term.</p>
          {paidCurrent && <p className="mt-2 text-xs font-medium text-foreground">The current paid mandate will stop renewing. Paid access continues through its verified term.</p>}
        </div>}
        <div className="mt-5"><Label htmlFor="admin-plan-reason">Reason for the plan change</Label>
          <Textarea id="admin-plan-reason" maxLength={500} disabled={busy} value={reason} onChange={event => { setReason(event.target.value); setReview(null); }}
            placeholder="Record why this account is receiving or changing the plan" className="mt-2" />
          <p className="mt-1 text-xs text-muted-foreground">Required for the billing audit log.</p>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button disabled={busy || !valid} onClick={() => beginReview("assign")}>Review assignment</Button>
          {scheduledAdmin && <Button variant="outline" disabled={busy || reason.trim().length < 3} onClick={() => beginReview("end_scheduled")}>Cancel scheduled change</Button>}
          {activeAdmin && <Button variant="outline" disabled={busy || reason.trim().length < 3} onClick={() => beginReview("end_active")}>End admin plan</Button>}
        </div>
        {review && reviewTarget === organizationId && <div role="alertdialog" aria-labelledby="admin-plan-review-heading" className="mt-5 rounded-xl border border-primary/30 bg-primary/5 p-5">
          <h3 id="admin-plan-review-heading" className="font-semibold">
            {review === "assign" ? `Assign ${chosen?.name} to ${overview.organization.name}?` :
              review === "end_scheduled" ? "Cancel the scheduled plan?" : "End this administrator plan?"}
          </h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {review === "assign" ? `${term} · ${timing === "now" ? "starts now" : `starts ${date(startDate)}`} · ends ${date(endDate)} · no charge. ${formatCredits(chosen?.monthlyCredits ?? 0)} credits are due at the start and monthly during a yearly term.`
              : "Future plan deposits will stop. Credits already deposited stay in the wallet. Any cancelled Razorpay renewal is not restored."}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">Reason: {reason.trim()}</p>
          <div className="mt-4 flex flex-wrap gap-3"><Button disabled={busy} onClick={() => void apply()}>{busy ? "Saving…" : "Confirm change"}</Button>
            <Button variant="outline" disabled={busy} onClick={() => setReview(null)}>Back</Button></div>
        </div>}
      </>}
  </section>;
}
