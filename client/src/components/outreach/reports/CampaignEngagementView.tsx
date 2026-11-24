"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { MessagesSquare } from "lucide-react";
import api from "@/lib/api";
import { creatorSessionScope } from "@/lib/creator-session";
import {
  selectedBusinessProfileId,
  subscribeBusinessProfile,
} from "@/lib/business-profile";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/ui/page-header";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  campaignReportUrl,
  type CampaignReportFilters,
} from "../../../../../shared/campaignReporting";
import type {
  CampaignCustomer,
  CampaignCustomerPage,
  CampaignHistoryPage,
  CampaignHistoryMessage,
} from "../../../../../shared/campaignEngagement";
import { trackingChannelLabel } from "../../../../../shared/outreachTracking";
/** Email rows show the address; other rows show the number. Internal keys such as "contact:33" are never shown. */
const customerContact = (customer: CampaignCustomer) => {
  const emailOnly =
    customer.channels.length > 0 &&
    customer.channels.every((channel) => ["email", "gmail", "resend"].includes(channel));
  return (emailOnly ? customer.email || customer.phone : customer.phone || customer.email) || "No saved contact details";
};
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "No recorded reply";
export function CampaignEngagementView() {
  const scope = useSyncExternalStore(
    subscribeBusinessProfile,
    creatorSessionScope,
    () => "anonymous",
  );
  return <EngagementWorkspace key={scope} scope={scope} />;
}
function EngagementWorkspace({ scope }: { scope: string }) {
  const params = useSearchParams();
  const [filters] = useState(
    () =>
      Object.fromEntries(
        [
          "workspaceId",
          "campaignId",
          "preparedOutreachId",
          "importId",
          "importSource",
          "channel",
          "accountId",
          "from",
          "to",
          "messageKind",
        ].flatMap((key) => (params.get(key) ? [[key, params.get(key)]] : [])),
      ) as unknown as CampaignReportFilters,
  );
  const [page, setPage] = useState<CampaignCustomerPage>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [responded, setResponded] = useState(false),
    [after, setAfter] = useState<string>();
  const [selected, setSelected] = useState<string | null>(
    params.get("customerKey"),
  );
  const query = campaignReportUrl(filters).split("?")[1] || "";
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setPage(undefined);
    const search = new URLSearchParams(query);
    search.set("respondedOnly", String(responded));
    if (after) search.set("after", after);
    api
      .get<CampaignCustomerPage>(`/api/outreach/reports/customers?${search}`, {
        signal: controller.signal,
      })
      .then((result) => {
        if (controller.signal.aborted || creatorSessionScope() !== scope)
          return;
        if (result.businessProfileId !== selectedBusinessProfileId())
          throw new Error("Customer scope changed. Reload this page.");
        setPage(result);
      })
      .catch((reason) => {
        if (!controller.signal.aborted && creatorSessionScope() === scope)
          setError(
            reason instanceof Error
              ? reason.message
              : "Customer engagement unavailable.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted && creatorSessionScope() === scope)
          setLoading(false);
      });
    return () => controller.abort();
  }, [query, scope, responded, after]);
  return (
    <main className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
      <PageHeader
        icon={MessagesSquare}
        title="Customer campaign engagement"
        subtitle="Replies, native selections and recorded actions for the selected audience."
      />
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="outline" asChild>
          <Link href={campaignReportUrl(filters)}>Change report filters</Link>
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={responded}
            onCheckedChange={(value) => {
              setResponded(value === true);
              setAfter(undefined);
            }}
          />
          Only customers who replied
        </label>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {loading && <p role="status">Loading saved customer records…</p>}
      {page && (
        <>
          <p className="text-sm text-muted-foreground">
            {page.total.toLocaleString()}{" "}
            {responded ? "responding customers" : "customers"} · checked{" "}
            {time(page.checkedAt)}. CRM merges and saved channel identities are
            reconciled.
          </p>
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Customer delivery and engagement
              </caption>
              <thead className="bg-muted">
                <tr>
                  {[
                    "Customer",
                    "Channel",
                    "Accepted / delivered",
                    "Queued / failed",
                    "Replies and selections",
                    "Recorded actions",
                    "History",
                  ].map((label) => (
                    <th
                      key={label}
                      className="whitespace-nowrap p-3 font-medium"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.items.map((customer) => (
                  <tr key={customer.key} className="border-t align-top">
                    <th
                      scope="row"
                      className="min-w-44 p-3 text-left font-medium"
                    >
                      <span className="block">{customer.name}</span>
                      <span className="mt-1 block break-all text-xs font-normal text-muted-foreground">
                        {customerContact(customer)}
                      </span>
                    </th>
                    <td className="p-3">{[...new Set(customer.channels.map(trackingChannelLabel))].join(", ")}</td>
                    <td className="whitespace-nowrap p-3">
                      {customer.accepted} / {customer.delivered}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {customer.awaitingConfirmation} awaiting receipt
                      </span>
                    </td>
                    <td className="p-3">
                      {customer.queued} / {customer.failed}
                    </td>
                    <td className="min-w-48 p-3">
                      {customer.typedReplies} typed · {customer.quickReplies}{" "}
                      {customer.quickReplies === 1 ? "quick reply" : "quick replies"} · {customer.menuSelections}{" "}
                      {customer.menuSelections === 1 ? "menu" : "menus"}
                      {customer.otherResponses > 0 && (
                        <p>
                          {customer.otherResponses}{" "}
                          {customer.otherResponses === 1 ? "other response" : "other responses"}
                        </p>
                      )}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {time(customer.lastReplyAt)}
                      </span>
                    </td>
                    <td className="min-w-40 p-3">
                      {customer.trackedLinkClicks} tracked link events
                      <br />
                      {customer.verifiedBookingActions} verified booking actions
                    </td>
                    <td className="p-3">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelected(customer.key)}
                        aria-label={`View history for ${customer.name}`}
                      >
                        View history
                      </Button>
                    </td>
                  </tr>
                ))}
                {!page.items.length && (
                  <tr>
                    <td colSpan={7} className="p-5 text-muted-foreground">
                      No customers match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!after}
              onClick={() => setAfter(undefined)}
            >
              First page
            </Button>
            <Button
              variant="outline"
              disabled={!page.nextCursor}
              onClick={() => setAfter(page.nextCursor || undefined)}
            >
              Next page
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {page.attribution} Tracked link events may include automated
            scanners. Verified booking actions are recorded confirmations or
            cancellations, with conversation attribution. WhatsApp URL clicks
            without tracking and phone-call button clicks are unavailable; they
            are not measured as zero.
          </p>
        </>
      )}
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Conversation history</SheetTitle>
            <SheetDescription>
              Protected values are masked. Open a conversation to use its
              existing private-data controls.
            </SheetDescription>
          </SheetHeader>
          {selected && (
            <CustomerHistory
              key={`${scope}:${selected}`}
              customerKey={selected}
              query={query}
              scope={scope}
            />
          )}
        </SheetContent>
      </Sheet>
    </main>
  );
}
function CustomerHistory({
  customerKey,
  query,
  scope,
}: {
  customerKey: string;
  query: string;
  scope: string;
}) {
  const [messages, setMessages] = useState<CampaignHistoryMessage[]>([]),
    [cursor, setCursor] = useState<string | null>(),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const load = useCallback(
    async (after?: string, signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      const search = new URLSearchParams(query);
      search.set("customerKey", customerKey);
      if (after) search.set("after", after);
      try {
        const result = await api.get<CampaignHistoryPage>(
          `/api/outreach/reports/history?${search}`,
          { signal },
        );
        if (signal?.aborted || creatorSessionScope() !== scope) return;
        if (result.businessProfileId !== selectedBusinessProfileId())
          throw new Error("Conversation scope changed.");
        setMessages((current) =>
          after
            ? [
                ...new Map(
                  [...current, ...result.items].map((message) => [
                    message.id,
                    message,
                  ]),
                ).values(),
              ]
            : result.items,
        );
        setCursor(result.nextCursor);
      } catch (reason) {
        if (!signal?.aborted && creatorSessionScope() === scope)
          setError(
            reason instanceof Error ? reason.message : "History unavailable.",
          );
      } finally {
        if (!signal?.aborted && creatorSessionScope() === scope)
          setLoading(false);
      }
    },
    [customerKey, query, scope],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [load]);
  return (
    <div className="mt-5 space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {messages.map((message) => (
        <article
          key={message.id}
          className={`rounded-lg border p-4 ${message.direction === "inbound" ? "bg-muted/50" : "bg-card"}`}
        >
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {message.direction === "inbound" ? "Customer" : "Business"} ·{" "}
              {trackingChannelLabel(message.channel)}
              {message.type && message.type !== "text" ? ` · ${message.type.replace(/_/g, " ")}` : ""}
            </span>
            <time dateTime={message.createdAt}>{time(message.createdAt)}</time>
          </div>
          {message.subject && (
            <h3 className="mt-2 text-sm font-medium">{message.subject}</h3>
          )}
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">
            {message.content || "No text content recorded."}
          </p>
          {message.selection && (
            <p className="mt-2 text-xs">Selection: {message.selection.title}</p>
          )}
          {message.conversationId && (
            <Link
              className="mt-3 inline-block text-xs text-primary hover:underline"
              href={`/dashboard/outreach/inbox?thread=conversation:${message.conversationId}`}
            >
              Open conversation
            </Link>
          )}
        </article>
      ))}
      {loading && (
        <p role="status" className="text-sm">
          Loading history…
        </p>
      )}
      {!loading && !messages.length && !error && (
        <p className="text-sm text-muted-foreground">
          No saved history matches this customer and report.
        </p>
      )}
      {cursor && (
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          Load more messages
        </Button>
      )}
    </div>
  );
}
