"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  BookOpen,
  CheckCheck,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  useSupportWorkspace,
  useSupportQueryState,
  useDebouncedSupportValue,
  supportQueryRetry,
} from "@/hooks/use-support-report";
import {
  sameSupportScope,
  supportDate,
  supportPageNumber,
  supportFilterParams,
  type SupportQualityData,
  type SupportQualityItem,
} from "@/lib/support-report";
import { SupportConversationTranscript } from "@/components/support/SupportConversationTranscript";
import { SupportAIPageShell } from "@/components/support/SupportAIPageShell";
import {
  SupportAIFilters,
  SupportPaginationControls,
} from "@/components/support/SupportAIFilters";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/ui/page-header";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function SupportAIQualityPage() {
  const workspace = useSupportWorkspace();
  const scope = workspace.ready
    ? `${workspace.userId}:${workspace.profileId}`
    : "";
  const state = useSupportQueryState(scope);
  return <QualityWorkspace key={scope} workspace={workspace} state={state} />;
}
function QualityWorkspace({
  workspace,
  state,
}: {
  workspace: ReturnType<typeof useSupportWorkspace>;
  state: ReturnType<typeof useSupportQueryState>;
}) {
  const { query, filters, update } = state;
  const search = useDebouncedSupportValue(
    (query.get("search") || "").slice(0, 200),
  );
  const statusValue = query.get("status");
  const status =
    statusValue === "reviewed" || statusValue === "all" ? statusValue : "open";
  const params = {
    ...supportFilterParams(filters),
    search,
    status,
    page: supportPageNumber(query.get("page")),
    limit: 25,
  };
  const key = [
    "support-ai-quality",
    workspace.userId,
    workspace.profileId,
    params,
  ] as const;
  const result = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api.get<SupportQualityData>("/api/support/ai/quality", {
        params,
        signal,
        headers: workspace.headers,
      }),
    enabled: workspace.ready && !state.validationError,
    retry: supportQueryRetry,
    staleTime: 30_000,
    placeholderData: (previous, previousQuery) =>
      previousQuery && sameSupportScope(previousQuery.queryKey, key)
        ? previous
        : undefined,
  });
  const data = result.data;
  if (
    !workspace.profiles.isLoading &&
    !workspace.profiles.isError &&
    !workspace.profileId
  )
    return (
      <ScrollArea className="h-full min-w-0" viewportClassName="[&>div]:!block">
        <SupportAIPageShell>
          <PageHeader
            icon={CheckCheck}
            title="Answer quality"
            subtitle="Review and improve the answers for your business."
          />
          <Alert>
            <AlertTitle>Choose a business profile</AlertTitle>
            <AlertDescription className="mt-2 space-y-3">
              <p>
                Create or select a business profile to review its assistant’s
                answers.
              </p>
              <Button asChild className="min-h-11">
                <Link href="/dashboard/business-profiles">
                  Manage business profiles
                </Link>
              </Button>
            </AlertDescription>
          </Alert>
        </SupportAIPageShell>
      </ScrollArea>
    );
  return (
    <ScrollArea className="h-full min-w-0" viewportClassName="[&>div]:!block">
      <SupportAIPageShell>
        <PageHeader
          icon={CheckCheck}
          title="Answer quality"
          subtitle="Turn flagged replies into better support knowledge. Review what was asked, what was answered, and what needs correcting."
          actions={
            <>
              <Button asChild variant="outline" className="min-h-11">
                <Link href="/dashboard/knowledge-base">
                  <BookOpen />
                  Knowledge base
                </Link>
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={result.isFetching || !workspace.ready || Boolean(state.validationError)}
                onClick={() => { if (!state.validationError) void result.refetch(); }}
              >
                <RefreshCw
                  className={cn(result.isFetching && "animate-spin")}
                />
                Refresh
              </Button>
            </>
          }
        />
        {state.validationError && <Alert variant="destructive"><AlertTitle>Check the date range</AlertTitle><AlertDescription>{state.validationError}</AlertDescription></Alert>}
        <SupportAIFilters
          value={filters}
          options={data?.filters}
          onChange={(changes) => update({ ...changes, page: null })}
        />
        {workspace.profiles.isError && (
          <Alert variant="destructive">
            <AlertTitle>Business profile could not be loaded</AlertTitle>
            <AlertDescription className="mt-2">
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => void workspace.profiles.refetch()}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <section
          aria-label="Answer review summary"
          className="grid grid-cols-3 overflow-hidden rounded-xl border border-border bg-card"
        >
          <Summary label="Needs review" value={data?.summary.open} />
          <Summary label="Reviewed" value={data?.summary.reviewed} />
          <Summary label="Helpful" value={data?.summary.helpful} />
        </section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="grid w-full gap-1.5 text-xs font-medium sm:w-48">
            Review status
            <select
              aria-label="Review status"
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={status}
              onChange={(e) => update({ status: e.target.value, page: null })}
            >
              <option value="open">Needs review</option>
              <option value="reviewed">Reviewed</option>
              <option value="all">All rated answers</option>
            </select>
          </label>
          <SearchInput
            aria-label="Search rated answers"
            maxLength={200}
            className="min-h-11"
            wrapperClassName="sm:max-w-sm"
            placeholder="Search question, answer or review notes…"
            value={query.get("search") || ""}
            onValueChange={(value) => update({ search: value, page: null })}
          />
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          This queue contains explicit staff feedback. “Reviewed” means a person
          checked the issue; it does not automatically change the knowledge base
          or prove that the conversation was resolved.
        </p>
        {result.isError && (
          <Alert variant="destructive">
            <AlertTitle>
              {data
                ? "Refresh failed — showing the last loaded reviews"
                : "Answer reviews could not be loaded"}
            </AlertTitle>
            <AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <span>{result.error.message}</span>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => { if (!state.validationError) void result.refetch(); }}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {!data &&
        (workspace.profiles.isLoading ||
          (workspace.ready && !state.validationError && result.isPending)) ? (
          <div
            role="status"
            aria-label="Loading answer reviews"
            className="space-y-4"
          >
            <Skeleton className="h-72 w-full rounded-xl" />
            <Skeleton className="h-72 w-full rounded-xl" />
          </div>
        ) : (
          data && (
            <section
              aria-label="Rated answers"
              aria-busy={
                result.isFetching || search !== (query.get("search") || "")
              }
              className="space-y-4"
            >
              <p role="status" className="text-xs text-muted-foreground">
                {result.isFetching
                  ? "Updating reviews…"
                  : `${data.pagination.total.toLocaleString()} matching answers`}
              </p>
              {data.items.length ? (
                data.items.map((item) => (
                  <ReviewCard
                    key={`${item.messageId}:${item.feedback.updatedAt}`}
                    item={item}
                    workspace={workspace}
                  />
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-border bg-card px-5 py-12 text-center">
                  <CheckCheck
                    className="mx-auto mb-3 h-7 w-7 text-primary"
                    aria-hidden="true"
                  />
                  <h2 className="text-base font-semibold">
                    {status === "open"
                      ? "No answers need review"
                      : "No matching rated answers"}
                  </h2>
                  <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
                    Open a conversation in Chat or Reports and mark an assistant
                    reply as helpful or needing review. Add a reason and notes
                    so your team knows what to improve.
                  </p>
                  <Button asChild variant="outline" className="mt-5 min-h-11">
                    <Link href="/dashboard/support-ai/reports?tab=conversations">
                      Review conversations
                      <ArrowUpRight />
                    </Link>
                  </Button>
                </div>
              )}
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                <SupportPaginationControls
                  label="Answers"
                  value={data.pagination}
                  busy={
                    result.isFetching || search !== (query.get("search") || "")
                  }
                  onPage={(page) => update({ page })}
                />
              </div>
            </section>
          )
        )}
      </SupportAIPageShell>
    </ScrollArea>
  );
}
function Summary({ label, value }: { label: string; value?: number }) {
  return (
    <div className="min-w-0 p-4 sm:p-5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 font-mono text-xl font-semibold tabular-nums sm:text-2xl">
        {value === undefined ? "—" : value.toLocaleString()}
      </p>
    </div>
  );
}
function ReviewCard({
  item,
  workspace,
}: {
  item: SupportQualityItem;
  workspace: ReturnType<typeof useSupportWorkspace>;
}) {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState(item.feedback.notes || "");
  const [reason, setReason] = useState(item.feedback.reason || "other");
  const [notice, setNotice] = useState("");
  const mutation = useMutation({
    mutationFn: (status: "open" | "reviewed") =>
      api.put(
        `/api/support/ai/messages/${item.messageId}/feedback`,
        {
          rating: item.feedback.rating,
          ...(item.feedback.rating === "needs_review" ? { reason } : {}),
          notes: notes.trim(),
          status,
        },
        { headers: workspace.headers },
      ),
    onSuccess: (_data, status) => {
      setNotice(status === "reviewed" ? "Marked reviewed" : "Review reopened");
      void queryClient.invalidateQueries({
        queryKey: ["support-ai-quality", workspace.userId, workspace.profileId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["support-ai-report", workspace.userId, workspace.profileId],
      });
      void queryClient.invalidateQueries({
        queryKey: [
          "support-ai-session",
          workspace.userId,
          workspace.profileId,
          item.sessionId,
        ],
      });
    },
  });
  const isFlagged = item.feedback.rating === "needs_review";
  return (
    <article
      className="overflow-hidden rounded-xl border border-border bg-card"
      aria-labelledby={`answer-${item.messageId}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4 sm:p-5">
        <div className="min-w-0">
          <h2
            id={`answer-${item.messageId}`}
            className="break-words text-base font-semibold"
          >
            {item.sessionTitle || "Support conversation"}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.teamName || "Support team"} ·{" "}
            <time dateTime={item.createdAt}>{supportDate(item.createdAt)}</time>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={isFlagged ? "outline" : "secondary"}>
            {isFlagged ? "Needs correction" : "Helpful"}
          </Badge>
          <Badge variant="secondary">
            {item.feedback.status === "reviewed" ? "Reviewed" : "Open"}
          </Badge>
        </div>
      </div>
      <div className="min-w-0 space-y-4 p-4 sm:p-5">
        {item.question && (
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">
              Question
            </h3>
            <p className="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">
              {item.question}
            </p>
          </div>
        )}
        <SupportConversationTranscript
          feedbackEnabled={false}
          messages={[
            {
              id: item.messageId,
              role: "assistant",
              content: item.answer,
              sources: item.sources,
              confidence: item.confidence,
              createdAt: item.createdAt,
            },
          ]}
        />
      </div>
      <div className="space-y-4 border-t border-border bg-muted/20 p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-[220px_minmax(0,1fr)]">
          {isFlagged && (
            <label className="grid gap-1.5 text-xs font-medium">
              Reason for correction
              <select
                aria-label={`Correction reason for answer ${item.messageId}`}
                value={reason}
                onChange={(e) => setReason(e.target.value as typeof reason)}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="incorrect">Incorrect answer</option>
                <option value="missing_information">Missing information</option>
                <option value="outdated">Outdated information</option>
                <option value="other">Other issue</option>
              </select>
            </label>
          )}
          <label className="grid gap-1.5 text-xs font-medium">
            Review notes
            <Textarea
              aria-label={`Review notes for answer ${item.messageId}`}
              value={notes}
              maxLength={2000}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What should change? Record the knowledge entry or the correction you made."
              className="min-h-24 resize-y"
            />
          </label>
        </div>
        {isFlagged && (
          <p className="text-xs leading-5 text-muted-foreground">
            Open the knowledge base to correct or add the relevant information.
            Then test the question again in Chat before marking this answer
            reviewed.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={
              item.feedback.status === "reviewed" ? "outline" : "default"
            }
            className="min-h-11"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(
                item.feedback.status === "reviewed" ? "open" : "reviewed",
              )
            }
          >
            {mutation.isPending
              ? "Saving…"
              : item.feedback.status === "reviewed"
                ? "Reopen review"
                : "Mark reviewed"}
          </Button>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={
              mutation.isPending ||
              (notes === (item.feedback.notes || "") &&
                reason === (item.feedback.reason || "other"))
            }
            onClick={() => mutation.mutate(item.feedback.status)}
          >
            Save notes
          </Button>
          <Button asChild variant="ghost" className="min-h-11">
            <Link href="/dashboard/knowledge-base">
              <BookOpen />
              Improve knowledge
            </Link>
          </Button>
          <Button asChild variant="ghost" className="min-h-11">
            <Link
              href={`/dashboard/support-ai/reports?tab=conversations&sessionId=${item.sessionId}`}
            >
              Full conversation
              <ArrowUpRight />
            </Link>
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {notice}
          </span>
        </div>
        {mutation.isError && (
          <Alert variant="destructive">
            <AlertTitle>Review could not be saved</AlertTitle>
            <AlertDescription>{mutation.error.message}</AlertDescription>
          </Alert>
        )}
      </div>
    </article>
  );
}
