"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTrackingQuery } from "@/hooks/use-outreach-tracking";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageEmptyState } from "@/components/EmptyState";
import {
  recipientFilterCount, recipientFilters,
  type BatchCounts, type OutreachRecipient, type OutreachRecipientPage, type RecipientFilter,
} from "../../../../../shared/outreachTracking";
import { deliveryStateDisplay, formatCount, recipientFilterLabels, recipientLastUpdate, recipientNote } from "./status";

const PAGE_SIZE = 50;
const conversationHref = (recipient: OutreachRecipient) => `/dashboard/outreach/inbox?thread=conversation:${recipient.conversationId}`;

const columns: DataTableColumn<OutreachRecipient>[] = [
  {
    id: "name", header: "Name",
    cell: recipient => (
      <div className="min-w-0">
        {/* The name opens the conversation, so phones can drop the Open column. */}
        <Link href={conversationHref(recipient)} className="break-words font-medium underline-offset-2 hover:underline">{recipient.name}</Link>
        {/* Phones drop the address and time columns, so both appear under the name. */}
        {recipient.recipient ? <p className="break-all text-xs text-muted-foreground sm:hidden">{recipient.recipient}</p> : null}
        <p className="text-xs text-muted-foreground md:hidden">{recipientLastUpdate(recipient)}</p>
      </div>
    ),
  },
  { id: "recipient", header: "Sent to", hideBelow: "sm", className: "break-all", cell: recipient => recipient.recipient || "—" },
  {
    id: "status", header: "Status",
    cell: recipient => {
      const display = deliveryStateDisplay[recipient.state];
      const note = recipientNote(recipient);
      return (
        <div className="min-w-0">
          <StatusBadge tone={display.tone} label={display.label} />
          {note ? <p className="mt-1 max-w-[11rem] break-words text-xs text-muted-foreground sm:max-w-xs">{note}</p> : null}
        </div>
      );
    },
  },
  { id: "updated", header: "Last update", hideBelow: "md", className: "whitespace-nowrap", cell: recipientLastUpdate },
  {
    id: "open", header: <span className="sr-only">Conversation</span>, align: "right", hideBelow: "sm",
    cell: recipient => (
      <Link href={conversationHref(recipient)}
        className="whitespace-nowrap text-sm font-medium text-primary underline-offset-2 hover:underline"
        aria-label={`Open conversation with ${recipient.name}`}>
        Open<span className="hidden lg:inline"> conversation</span>
      </Link>
    ),
  },
];

/** What a person can search by, in the words of the channel. */
export function recipientSearchLabel(channel: string): string {
  if (channel === "email") return "Search by name or email address";
  if (channel === "instagram") return "Search by name or Instagram handle";
  if (channel === "whatsapp" || channel === "sms") return "Search by name or phone number";
  return "Search by name";
}

export type MessageKind = "outreach" | "follow_up";

interface RecipientsCardProps {
  batchId: string;
  channel: string;
  counts: BatchCounts;
  followUps: BatchCounts;
  filter: RecipientFilter;
  onFilterChange: (filter: RecipientFilter) => void;
  kind: MessageKind;
  onKindChange: (kind: MessageKind) => void;
  /** Changes when the page's Refresh button is pressed. */
  refreshVersion: number;
}

export function RecipientsCard({ batchId, channel, counts, followUps, filter, onFilterChange, kind, onKindChange, refreshVersion }: RecipientsCardProps) {
  const [search, setSearch] = useState("");
  const shown = kind === "follow_up" ? followUps : counts;
  // Cancelled only appears once something was cancelled, so the usual list of chips stays short.
  const options = recipientFilters.filter(option => option !== "cancelled" || shown.cancelled > 0 || filter === "cancelled");
  const searchLabel = recipientSearchLabel(channel);
  return (
    <Card id="recipients" className="scroll-mt-4">
      <CardHeader>
        <CardTitle>Recipients</CardTitle>
        <CardDescription>
          {kind === "follow_up" ? "Everyone who was due a follow-up, and what happened to it." : "Everyone in this outreach and what happened to their message."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {followUps.total > 0 ? (
          <Tabs value={kind} onValueChange={value => onKindChange(value as MessageKind)}>
            <TabsList aria-label="Choose which messages to list">
              <TabsTrigger value="outreach">First message<span className="ml-1.5 tabular-nums text-muted-foreground">{formatCount(counts.total)}</span></TabsTrigger>
              <TabsTrigger value="follow_up">Follow-ups<span className="ml-1.5 tabular-nums text-muted-foreground">{formatCount(followUps.total)}</span></TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
        <Tabs value={filter} onValueChange={value => onFilterChange(value as RecipientFilter)}>
          {/* The chips scroll sideways on a phone instead of wrapping into a tall block. */}
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <TabsList aria-label="Filter recipients by status" className="justify-start">
              {options.map(option => (
                <TabsTrigger key={option} value={option}>
                  {recipientFilterLabels[option]}
                  <span className="ml-1.5 tabular-nums text-muted-foreground">{formatCount(recipientFilterCount(shown, option))}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
        <SearchInput aria-label={searchLabel} placeholder={searchLabel} onSearch={setSearch} wrapperClassName="sm:max-w-sm" />
        {/* Paging restarts whenever the list, filter or search changes. */}
        <RecipientPages key={`${kind}:${filter}:${search}`} batchId={batchId} kind={kind} filter={filter} search={search}
          total={search ? null : recipientFilterCount(shown, filter)} refreshVersion={refreshVersion} />
      </CardContent>
    </Card>
  );
}

function RecipientPages({ batchId, kind, filter, search, total, refreshVersion }: {
  batchId: string; kind: MessageKind; filter: RecipientFilter; search: string; total: number | null; refreshVersion: number;
}) {
  // Each page starts after the last message of the page before it, which stays fast on a very large outreach.
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [page, setPage] = useState(1);
  const params = useMemo(() => ({ status: filter, kind, q: search || undefined, cursor: cursors[page - 1], limit: PAGE_SIZE }),
    [filter, kind, search, cursors, page]);
  const list = useTrackingQuery<OutreachRecipientPage>(`/api/outreach/batches/${batchId}/messages`, params);
  const { refetch } = list;
  useEffect(() => { if (refreshVersion > 0) refetch(); }, [refreshVersion, refetch]);

  const nextCursor = list.data?.nextCursor ?? null;
  const go = (target: number) => {
    if (target === page - 1 && page > 1) setPage(target);
    if (target === page + 1 && nextCursor !== null && !list.loading) {
      setCursors(current => { const next = current.slice(0, page); next[page] = nextCursor; return next; });
      setPage(target);
    }
  };

  return (
    <>
      <DataTable
        caption="Recipients of this outreach"
        columns={columns}
        data={list.data?.items}
        getRowId={recipient => String(recipient.messageId)}
        loading={list.loading}
        error={list.error ? "We couldn't load the recipients." : undefined}
        onRetry={list.refetch}
        skeletonRows={8}
        emptyState={<PageEmptyState compact
          title={search ? "No recipient matches this search" : filter === "all" ? "No recipients yet" : "No recipients with this status"}
          description={search ? "Check the spelling, or search by part of the name or address." : undefined} />}
      />
      {total !== null ? (
        // The counts can run a little ahead of the list while sending, so never page past what the server returned.
        total > PAGE_SIZE ? <Pagination page={page} pageSize={PAGE_SIZE} totalItems={Math.max(total, (page - 1) * PAGE_SIZE + (list.data?.items.length ?? 0) + (nextCursor !== null ? 1 : 0))}
          onPageChange={go} itemLabel="recipients" showEdgeButtons={false} disabled={list.loading} aria-label="Recipient pages" /> : null
      ) : (page > 1 || nextCursor !== null) ? (
        <nav aria-label="Recipient pages" className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">Page {formatCount(page)} of search results</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 1 || list.loading} onClick={() => go(page - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={nextCursor === null || list.loading} onClick={() => go(page + 1)}>Next</Button>
          </div>
        </nav>
      ) : null}
    </>
  );
}
