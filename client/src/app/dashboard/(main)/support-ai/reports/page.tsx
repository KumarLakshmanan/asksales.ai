"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Copy,
  Download,
  MessageSquare,
  RefreshCw,
  TrendingUp,
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
  type SupportReportData,
  type SupportReportSession,
} from "@/lib/support-report";
import {
  copySupportTranscript,
  exportSupportTranscript,
} from "@/lib/support-transcript";
import { SupportConversationTranscript } from "@/components/support/SupportConversationTranscript";
import { SupportAIPageShell } from "@/components/support/SupportAIPageShell";
import {
  SupportAIFilters,
  SupportPaginationControls,
} from "@/components/support/SupportAIFilters";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchInput } from "@/components/ui/search-input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type TranscriptMessage = Parameters<
  typeof SupportConversationTranscript
>[0]["messages"][number];
type SessionDetail = SupportReportSession & { messages: TranscriptMessage[] };

export default function SupportAIReportsPage() {
  const workspace = useSupportWorkspace();
  const scope = workspace.ready
    ? `${workspace.userId}:${workspace.profileId}`
    : "";
  const state = useSupportQueryState(scope);
  return (
    <ReportsWorkspace
      key={scope}
      workspace={workspace}
      state={state}
      scope={scope}
    />
  );
}
function ReportsWorkspace({
  workspace,
  state,
  scope,
}: {
  workspace: ReturnType<typeof useSupportWorkspace>;
  state: ReturnType<typeof useSupportQueryState>;
  scope: string;
}) {
  const { query, filters, update } = state;
  const activeTab = ["overview", "leads", "conversations"].includes(
    query.get("tab") || "",
  )
    ? query.get("tab")!
    : "overview";
  const sessionIdValue = Number(query.get("sessionId"));
  const selectedId =
    Number.isSafeInteger(sessionIdValue) && sessionIdValue > 0
      ? sessionIdValue
      : null;
  const sessionSearch = useDebouncedSupportValue(
    (query.get("sessionSearch") || "").slice(0, 200),
  );
  const leadSearch = useDebouncedSupportValue(
    (query.get("leadSearch") || "").slice(0, 200),
  );
  const sessionPage = supportPageNumber(query.get("sessionPage"));
  const leadPage = supportPageNumber(query.get("leadPage"));
  const params = {
    ...supportFilterParams(filters),
    sessionSearch,
    leadSearch,
    sessionPage,
    leadPage,
    limit: 25,
  };
  const key = [
    "support-ai-report",
    workspace.userId,
    workspace.profileId,
    params,
  ] as const;
  const report = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api.get<SupportReportData>("/api/support/ai/report", {
        params,
        headers: workspace.headers,
        signal,
      }),
    enabled: workspace.ready && !state.validationError,
    retry: supportQueryRetry,
    staleTime: 30_000,
    placeholderData: (previous, previousQuery) =>
      previousQuery && sameSupportScope(previousQuery.queryKey, key)
        ? previous
        : undefined,
  });
  const detail = useQuery({
    queryKey: [
      "support-ai-session",
      workspace.userId,
      workspace.profileId,
      selectedId,
    ],
    queryFn: ({ signal }) =>
      api.get<SessionDetail>(`/api/support/ai/sessions/${selectedId}`, {
        signal,
        headers: workspace.headers,
      }),
    enabled:
      workspace.ready && Boolean(selectedId) && activeTab === "conversations",
    retry: supportQueryRetry,
    staleTime: 30_000,
  });
  const selected = selectedId
    ? detail.data ||
      report.data?.sessions.find((item) => item.id === selectedId)
    : undefined;
  const heading = useRef<HTMLHeadingElement>(null);
  const [copyNotice, setCopyNotice] = useState("");
  useEffect(() => {
    if (
      selectedId &&
      activeTab === "conversations" &&
      window.matchMedia("(max-width: 1023px)").matches
    )
      heading.current?.focus({ preventScroll: true });
  }, [selectedId, activeTab, selected?.id]);
  useEffect(() => {
    setCopyNotice("");
  }, [selectedId, scope]);
  const select = (id: number) =>
    update({ sessionId: id, tab: "conversations" });
  const back = () => {
    update({ sessionId: null });
    requestAnimationFrame(() =>
      document.getElementById(`report-session-${selectedId}`)?.focus(),
    );
  };
  const stats = report.data?.stats;
  const metrics = report.data?.metrics;
  const refresh = () => {
    if (state.validationError) return;
    void report.refetch();
    if (selectedId) void detail.refetch();
  };

  if (
    !workspace.profiles.isLoading &&
    !workspace.profiles.isError &&
    !workspace.profileId
  )
    return (
      <ScrollArea className="h-full min-w-0" viewportClassName="[&>div]:!block">
        <SupportAIPageShell>
          <PageHeader
            icon={TrendingUp}
            title="Support reports"
            subtitle="Review support activity for your business."
          />
          <Alert>
            <AlertTitle>Choose a business profile</AlertTitle>
            <AlertDescription className="mt-2 space-y-3">
              <p>
                Create or select a business profile to see its conversations and
                captured leads.
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
    <ScrollArea
      className="h-full min-w-0 bg-background"
      viewportClassName="[&>div]:!block"
    >
      <SupportAIPageShell>
        <PageHeader
          icon={TrendingUp}
          title="Support reports"
          subtitle="Review customer conversations, captured leads, and the quality of your assistant’s replies."
          actions={
            <Button
              variant="outline"
              className="min-h-11"
              onClick={refresh}
              disabled={report.isFetching || !workspace.ready || Boolean(state.validationError)}
            >
              <RefreshCw className={cn(report.isFetching && "animate-spin")} />
              Refresh
            </Button>
          }
        />
        {state.validationError && <Alert variant="destructive"><AlertTitle>Check the date range</AlertTitle><AlertDescription>{state.validationError}</AlertDescription></Alert>}
        <SupportAIFilters
          value={filters}
          options={report.data?.filters}
          onChange={(changes) =>
            update({
              ...changes,
              sessionPage: null,
              leadPage: null,
              sessionId: null,
            })
          }
        />
        {workspace.profiles.isError && (
          <LoadError
            title="Business profile could not be loaded"
            error={workspace.profiles.error}
            onRetry={() => void workspace.profiles.refetch()}
          />
        )}
        {report.isError && (
          <LoadError
            title={
              report.data
                ? "Refresh failed — showing the last loaded results"
                : "Support reports could not be loaded"
            }
            error={report.error}
            onRetry={() => { if (!state.validationError) void report.refetch(); }}
          />
        )}
        <Tabs
          value={activeTab}
          onValueChange={(tab) => update({ tab })}
          className="min-w-0 space-y-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList
              aria-label="Support report views"
              className="grid min-h-12 w-full grid-cols-3 sm:w-fit"
            >
              <TabsTrigger
                value="overview"
                className="min-h-10 px-2 text-xs sm:px-5 sm:text-sm"
              >
                Overview
              </TabsTrigger>
              <TabsTrigger
                value="leads"
                className="min-h-10 px-2 text-xs sm:px-5 sm:text-sm"
              >
                Leads
                {report.data && (
                  <span className="ml-2 hidden font-mono text-xs sm:inline">
                    {report.data.pagination.leads.total}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="conversations"
                className="min-h-10 px-2 text-xs sm:px-5 sm:text-sm"
              >
                Conversations
                {report.data && (
                  <span className="ml-2 hidden font-mono text-xs sm:inline">
                    {report.data.pagination.sessions.total}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
            {report.data && (
              <p role="status" className="text-xs text-muted-foreground">
                {report.isFetching
                  ? "Updating results…"
                  : "All counts reflect the selected filters"}
              </p>
            )}
          </div>
          {!report.data &&
          (workspace.profiles.isLoading ||
            (workspace.ready && !state.validationError && report.isPending)) ? (
            <div
              role="status"
              aria-label="Loading support reports"
              className="space-y-5"
            >
              <Skeleton className="h-28 w-full rounded-xl" />
              <Skeleton className="h-72 w-full rounded-xl" />
            </div>
          ) : report.data && stats && metrics ? (
            <>
              <TabsContent value="overview" className="mt-0 space-y-5">
                <dl className="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-4">
                  <Metric
                    label="Conversations"
                    value={stats.totalSessions.toLocaleString()}
                    detail="Customer and internal chats in this range"
                  />
                  <Metric
                    label="Website customers"
                    value={stats.widgetSessions.toLocaleString()}
                    detail="Conversations started through the widget"
                  />
                  <Metric
                    label="Messages"
                    value={stats.totalMessages.toLocaleString()}
                    detail="Recorded user and assistant messages"
                  />
                  <Metric
                    label="Leads captured"
                    value={stats.leadsGenerated.toLocaleString()}
                    detail="Contacts collected by the support widget"
                  />
                </dl>
                <section
                  aria-labelledby="quality-metrics-heading"
                  className="overflow-hidden rounded-xl border border-border bg-card"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
                    <h2
                      id="quality-metrics-heading"
                      className="text-base font-semibold"
                    >
                      Reply quality and outcomes
                    </h2>
                    <Button asChild variant="link" className="min-h-11 px-0">
                      <Link
                        href={`/dashboard/support-ai/quality?${new URLSearchParams(Object.entries(filters).filter(([, value]) => value))}`}
                      >
                        Review answer quality
                        <ArrowUpRight />
                      </Link>
                    </Button>
                  </div>
                  <dl className="grid sm:grid-cols-2 lg:grid-cols-3">
                    <Metric
                      label="Average response time"
                      value={
                        metrics.averageResponseSeconds === null
                          ? "—"
                          : `${metrics.averageResponseSeconds.toFixed(1)}s`
                      }
                      detail={`Mean time from a user message to its recorded assistant reply. ${metrics.responseSampleCount ?? 0} paired replies; unpaired messages are excluded.`}
                    />
                    <Metric
                      label="Helpful answers"
                      value={percent(metrics.helpfulRate)}
                      detail={`Staff marked helpful ÷ staff-rated answers. ${metrics.feedbackCount} rated answers.`}
                    />
                    <Metric
                      label="Customer satisfaction"
                      value={percent(metrics.satisfactionRate)}
                      detail={`Positive customer ratings ÷ all customer ratings. ${metrics.csatCount} rated conversations.`}
                    />
                    <Metric
                      label="Human handoffs"
                      value={percent(metrics.handoffRate)}
                      detail={`${metrics.handoffCount} conversations with a recorded handoff ÷ matching conversations.`}
                    />
                    <Metric
                      label="Lead conversion"
                      value={percent(metrics.leadConversionRate)}
                      detail={`${metrics.convertedLeads} captured widget leads marked converted ÷ captured widget leads in this range.`}
                    />
                    <Metric
                      label="Internal team chats"
                      value={Math.max(
                        0,
                        stats.totalSessions - stats.widgetSessions,
                      ).toLocaleString()}
                      detail="Staff conversations are separate from website customers. No automatic resolution rate is inferred."
                    />
                  </dl>
                </section>
                <section
                  className="overflow-hidden rounded-xl border border-border bg-card"
                  aria-labelledby="recent-heading"
                >
                  <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-4">
                    <h2 id="recent-heading" className="text-base font-semibold">
                      Recent matching conversations
                    </h2>
                    <Button
                      variant="ghost"
                      className="min-h-11"
                      onClick={() => update({ tab: "conversations" })}
                    >
                      View all
                    </Button>
                  </div>
                  {report.data.sessions.length ? (
                    <ul className="divide-y divide-border">
                      {report.data.sessions.slice(0, 5).map((session) => (
                        <li key={session.id}>
                          <SessionButton session={session} onSelect={select} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty
                      title="No conversations in this range"
                      description="Adjust the filters, start an internal chat, or install the widget to begin collecting conversations."
                    />
                  )}
                </section>
              </TabsContent>
              <TabsContent value="leads" className="mt-0 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold">Captured leads</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Search all matching contacts, including those beyond the
                      first page.
                    </p>
                  </div>
                  <SearchInput
                    aria-label="Search captured leads"
                    maxLength={200}
                    className="min-h-11"
                    wrapperClassName="sm:max-w-sm"
                    value={query.get("leadSearch") || ""}
                    onValueChange={(value) =>
                      update({ leadSearch: value, leadPage: null })
                    }
                    placeholder="Name, email, phone or status…"
                  />
                </div>
                <div
                  className="overflow-hidden rounded-xl border border-border bg-card"
                  aria-busy={report.isFetching}
                >
                  {report.data.leads.length ? (
                    <>
                      <div className="hidden md:block">
                        <table className="w-full table-fixed text-left text-sm">
                          <caption className="sr-only">
                            Captured leads matching the selected filters
                          </caption>
                          <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                            <tr>
                              <th className="w-[22%] px-4 py-3" scope="col">
                                Name
                              </th>
                              <th className="w-[30%] px-4 py-3" scope="col">
                                Contact
                              </th>
                              <th className="w-[18%] px-4 py-3" scope="col">
                                Stage
                              </th>
                              <th className="w-[18%] px-4 py-3" scope="col">
                                Captured
                              </th>
                              <th scope="col">
                                <span className="sr-only">View lead</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {report.data.leads.map((lead) => (
                              <tr key={lead.id} className="hover:bg-muted/30">
                                <td className="break-words px-4 py-4 font-medium">
                                  {lead.name || "Unnamed lead"}
                                </td>
                                <td className="break-all px-4 py-4">
                                  <p>{lead.email || "—"}</p>
                                  {lead.phone && (
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      {lead.phone}
                                    </p>
                                  )}
                                </td>
                                <td className="px-4 py-4">
                                  <Badge
                                    variant="secondary"
                                    className="whitespace-normal break-words"
                                  >
                                    {lead.status || "new"}
                                  </Badge>
                                </td>
                                <td className="px-4 py-4 text-xs text-muted-foreground">
                                  <time dateTime={lead.createdAt}>
                                    {supportDate(lead.createdAt)}
                                  </time>
                                </td>
                                <td className="pr-3">
                                  <Button
                                    asChild
                                    variant="ghost"
                                    className="min-h-11 px-2 text-xs"
                                  >
                                    <Link
                                      href={`/dashboard/crm/contacts/-${lead.id}`}
                                      aria-label={`View contact ${lead.name || lead.email}`}
                                    >
                                      View
                                      <ArrowUpRight />
                                    </Link>
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <ul className="divide-y divide-border md:hidden">
                        {report.data.leads.map((lead) => (
                          <li key={lead.id} className="space-y-3 p-4">
                            <div className="flex items-start justify-between gap-3">
                              <p className="break-words text-sm font-semibold">
                                {lead.name || "Unnamed lead"}
                              </p>
                              <Badge
                                variant="secondary"
                                className="max-w-[45%] whitespace-normal break-words"
                              >
                                {lead.status || "new"}
                              </Badge>
                            </div>
                            <p className="break-all text-sm text-muted-foreground">
                              {lead.email || lead.phone || "No contact details"}
                            </p>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <time
                                dateTime={lead.createdAt}
                                className="text-xs text-muted-foreground"
                              >
                                {supportDate(lead.createdAt)}
                              </time>
                              <Button
                                asChild
                                variant="outline"
                                className="min-h-11 text-xs"
                              >
                                <Link
                                  href={`/dashboard/crm/contacts/-${lead.id}`}
                                >
                                  View contact
                                  <ArrowUpRight />
                                </Link>
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <Empty
                      title="No matching leads"
                      description="Try a different search or date range. Contacts appear when visitors share their details through the widget."
                    />
                  )}
                  <SupportPaginationControls
                    value={report.data.pagination.leads}
                    label="Leads"
                    busy={
                      report.isFetching ||
                      leadSearch !== (query.get("leadSearch") || "")
                    }
                    onPage={(page) => update({ leadPage: page })}
                  />
                </div>
              </TabsContent>
              <TabsContent value="conversations" className="mt-0 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-base font-semibold">Conversations</h2>
                  <SearchInput
                    aria-label="Search conversations"
                    maxLength={200}
                    className="min-h-11"
                    wrapperClassName="sm:max-w-sm"
                    value={query.get("sessionSearch") || ""}
                    onValueChange={(value) =>
                      update({
                        sessionSearch: value,
                        sessionPage: null,
                        sessionId: null,
                      })
                    }
                    placeholder="Title, visitor or contact…"
                  />
                </div>
                <div className="grid min-h-[28rem] min-w-0 overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[300px_minmax(0,1fr)]">
                  <section
                    aria-label="Conversation list"
                    className={cn(
                      "min-w-0 border-border lg:block lg:border-r",
                      selectedId && "hidden",
                    )}
                    aria-busy={report.isFetching}
                  >
                    <ul className="divide-y divide-border">
                      {report.data.sessions.map((session) => (
                        <li key={session.id}>
                          <SessionButton
                            session={session}
                            selected={selectedId === session.id}
                            onSelect={select}
                          />
                        </li>
                      ))}
                    </ul>
                    {!report.data.sessions.length && (
                      <Empty
                        title="No matching conversations"
                        description="Try another search or change the activity filters."
                      />
                    )}
                    <SupportPaginationControls
                      label="Conversations"
                      value={report.data.pagination.sessions}
                      busy={
                        report.isFetching ||
                        sessionSearch !== (query.get("sessionSearch") || "")
                      }
                      onPage={(page) => update({ sessionPage: page })}
                    />
                  </section>
                  <section
                    aria-label="Conversation details"
                    className={cn("min-w-0", !selectedId && "hidden lg:block")}
                  >
                    {!selectedId ? (
                      <Empty
                        title="Select a conversation"
                        description="Review the conversation, its sources, and any captured contact details."
                      />
                    ) : (
                      <>
                        <div className="border-b border-border p-4 sm:p-5">
                          <Button
                            variant="ghost"
                            className="mb-2 min-h-11 px-2 lg:hidden"
                            onClick={back}
                          >
                            <ArrowLeft />
                            Back to conversations
                          </Button>
                          <h2
                            ref={heading}
                            tabIndex={-1}
                            className="break-words text-base font-semibold focus:outline-none"
                          >
                            {selected?.title || "Conversation"}
                          </h2>
                          {selected && (
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                              <span className="inline-flex items-center gap-1">
                                <Bot className="h-3.5 w-3.5" />
                                {selected.teamName || selected.memberName}
                              </span>
                              <span>{selected.messageCount} messages</span>
                              <Badge variant="secondary">
                                {selected.metadata?.source === "widget"
                                  ? "Website customer"
                                  : "Internal chat"}
                              </Badge>
                              <time dateTime={selected.createdAt}>
                                {supportDate(selected.createdAt)}
                              </time>
                            </div>
                          )}
                          {selected &&
                            (selected.ticketId || selected.automationMode) && (
                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                <Badge variant="outline">
                                  {handoffLabel(
                                    selected.automationMode,
                                    selected.ticketId,
                                  )}
                                </Badge>
                                {selected.ticketId && (
                                  <Button
                                    asChild
                                    variant="outline"
                                    className="min-h-11 text-xs"
                                  >
                                    <Link
                                      href={`/dashboard/support/${selected.ticketId}`}
                                    >
                                      Open support ticket
                                      <ArrowUpRight />
                                    </Link>
                                  </Button>
                                )}
                              </div>
                            )}
                          {selected && (
                            <p className="mt-2 text-xs leading-5 text-muted-foreground">
                              Recorded handoff status does not verify AI reply readiness.
                              {" "}Replies require an enabled runtime and a ready, published assistant assigned to the account.
                            </p>
                          )}
                          {detail.data?.messages.length ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                variant="outline"
                                className="min-h-11 text-xs"
                                onClick={() => {
                                  exportSupportTranscript(
                                    detail.data!.messages,
                                    selected?.title || "Support conversation",
                                  );
                                }}
                              >
                                <Download />
                                Download transcript
                              </Button>
                              <Button
                                variant="ghost"
                                className="min-h-11 text-xs"
                                onClick={async () => {
                                  try {
                                    await copySupportTranscript(
                                      detail.data!.messages,
                                      selected?.title || "Support conversation",
                                    );
                                    setCopyNotice("Transcript copied");
                                  } catch {
                                    setCopyNotice(
                                      "Could not copy. Download the transcript instead.",
                                    );
                                  }
                                }}
                              >
                                <Copy />
                                Copy transcript
                              </Button>
                              <span
                                role="status"
                                className="self-center text-xs text-muted-foreground"
                              >
                                {copyNotice}
                              </span>
                            </div>
                          ) : null}
                        </div>
                        {selected?.leadInfo && (
                          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
                            <div className="min-w-0">
                              <p className="text-xs text-muted-foreground">
                                Linked contact
                              </p>
                              <p className="mt-1 break-words text-sm font-medium">
                                {selected.leadInfo.name ||
                                  selected.leadInfo.email}
                              </p>
                            </div>
                            <Button
                              asChild
                              variant="outline"
                              className="min-h-11 text-xs"
                            >
                              <Link
                                href={`/dashboard/crm/contacts/-${selected.leadInfo.id}`}
                              >
                                View contact
                                <ArrowUpRight />
                              </Link>
                            </Button>
                          </div>
                        )}
                        <div className="max-h-[42rem] min-w-0 overflow-y-auto p-4 sm:p-5">
                          {detail.isError ? (
                            <LoadError
                              title="Conversation could not be loaded"
                              error={detail.error}
                              onRetry={() => void detail.refetch()}
                            />
                          ) : !detail.data ? (
                            <div
                              role="status"
                              aria-label="Loading conversation"
                              className="space-y-4"
                            >
                              <Skeleton className="ml-auto h-20 w-3/4" />
                              <Skeleton className="h-28 w-5/6" />
                            </div>
                          ) : detail.data.messages.length ? (
                            <SupportConversationTranscript
                              messages={detail.data.messages}
                              userLabel={
                                selected?.metadata?.source === "widget"
                                  ? "Visitor"
                                  : "Team member"
                              }
                              onFeedbackSaved={() => {
                                void report.refetch();
                                void detail.refetch();
                              }}
                            />
                          ) : (
                            <Empty
                              title="No messages yet"
                              description="This conversation has no recorded messages."
                            />
                          )}
                        </div>
                      </>
                    )}
                  </section>
                </div>
              </TabsContent>
            </>
          ) : null}
        </Tabs>
      </SupportAIPageShell>
    </ScrollArea>
  );
}
function percent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}
function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0 border-border p-4 sm:p-5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-2 font-mono text-2xl font-semibold tabular-nums">
        {value}
      </dd>
      <p className="mt-2 max-w-[42ch] text-xs leading-5 text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}
function SessionButton({
  session,
  selected,
  onSelect,
}: {
  session: SupportReportSession;
  selected?: boolean;
  onSelect: (id: number) => void;
}) {
  return (
    <button
      id={`report-session-${session.id}`}
      type="button"
      aria-pressed={selected}
      aria-label={`Open conversation: ${session.title || "Untitled conversation"}`}
      onClick={() => onSelect(session.id)}
      className={cn(
        "flex min-h-20 w-full items-center gap-3 px-4 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-primary/10" : "hover:bg-muted/40",
      )}
    >
      <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {session.title || "Untitled conversation"}
        </p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {session.metadata?.visitorName || session.memberName} ·{" "}
          {session.messageCount} messages
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="text-[11px]">
            {session.metadata?.source === "widget" ? "Customer" : "Internal"}
          </Badge>
          <time dateTime={session.updatedAt || session.createdAt}>
            {supportDate(session.updatedAt || session.createdAt)}
          </time>
        </div>
      </div>
    </button>
  );
}
function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="px-5 py-12 text-center">
      <MessageSquare
        aria-hidden="true"
        className="mx-auto mb-3 h-6 w-6 text-muted-foreground"
      />
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
function LoadError({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <span className="break-words">
          {error instanceof Error ? error.message : "Please try again."}
        </span>
        <Button variant="outline" className="min-h-11" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function handoffLabel(mode?: string, ticketId?: number | null): string {
  if (mode === "human_owned") return "Human support active";
  if (mode === "human_paused") return "Assistant paused for human support";
  if (mode === "approval_pending") return "Awaiting staff approval";
  if (mode === "resolved" || mode === "closed") return "Conversation closed";
  if (mode === "opted_out") return "Customer opted out";
  if (ticketId) return "Support ticket linked";
  return mode === "ai_active" ? "No human takeover" : "Recorded support status";
}
