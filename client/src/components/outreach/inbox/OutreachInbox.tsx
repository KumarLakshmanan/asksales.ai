"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  Clock,
  Facebook,
  FileText,
  Inbox,
  Instagram,
  LockKeyhole,
  Mail,
  MessageCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useWebSocket } from "@/contexts/WebSocketContext";
import api from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  INBOX_CHANNELS,
  INBOX_LABELS,
  INBOX_ORIGIN_LABELS,
  type InboxChannel,
  type InboxItem,
  type InboxOriginFilter,
  type InboxPage,
  type InboxSort,
} from "@/lib/outreach-inbox";
import { OutreachMessageTimeline } from "../OutreachMessageTimeline";
import { whatsAppPreviewText } from "../WhatsAppText";
import { ConversationEventTimeline } from "@/components/support/ConversationEventTimeline";
import { OutreachComposeArea } from "../OutreachComposeArea";
import { readLibraryDraft } from "@/lib/libraryDraft";
import { EmailSenderPicker } from "../EmailSenderPicker";
import { TemplateSelector } from "../TemplateSelector";
import { getChannelCapabilities } from "../channel-capabilities";
import { useInboxConversation, type InboxDraft } from "./useInboxConversation";
import {
  InboxWhatsAppTemplate,
  type InboxTemplatePayload,
} from "./InboxWhatsAppTemplate";

const ICONS = {
  email: Mail,
  whatsapp: MessageCircle,
  instagram: Instagram,
  facebook: Facebook,
  sms: MessageSquare,
};
const ORIGIN_CHIPS = ["outreach", "customer", "ai", "manual", "native_app"] satisfies InboxOriginFilter[];
const emptyCounts = () =>
  Object.fromEntries(
    [...INBOX_CHANNELS, "all"].map((channel) => [channel, 0]),
  ) as InboxPage["unreadThreads"];
const order = (a: InboxItem, b: InboxItem) =>
  b.activityAt.localeCompare(a.activityAt) ||
  b.kind.localeCompare(a.kind) ||
  b.id - a.id;

/** The sending account in words. A bare provider ID (WhatsApp phone number ID)
 * means the connected account has no saved name, so show only its last digits. */
function sendingAccountText(item: InboxItem): string | null {
  const label = item.reply.accountLabel?.trim();
  if (!label) return null;
  if (item.channel !== "email" && /^\d{9,}$/.test(label))
    return `${INBOX_LABELS[item.channel]} account ending ${label.slice(-4)}`;
  return label;
}

const FAILED_SEND = new Set(["failed", "bounced", "rejected", "undelivered"]);

function ChannelIcon({
  channel,
  className,
}: {
  channel: InboxChannel;
  className?: string;
}) {
  const Icon = ICONS[channel];
  return (
    <Icon aria-hidden="true" className={cn("h-4 w-4 shrink-0", className)} />
  );
}

function InboxThread({
  initial,
  refreshToken,
  drafts,
  onRead,
  onChanged,
  onBack,
}: {
  initial: InboxItem;
  refreshToken: number;
  drafts: Map<string, InboxDraft>;
  onRead: (item: InboxItem) => void;
  onChanged: () => void;
  onBack: () => void;
}) {
  const thread = useInboxConversation(
    initial,
    refreshToken,
    drafts,
    onRead,
    onChanged,
  );
  const { item } = thread;
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // WhatsApp templates open in a side panel, so the reply bar stays one line
  // and the messages keep the space.
  const [templatePanelOpen, setTemplatePanelOpen] = useState(false);
  const [templatePayload, setTemplatePayload] =
    useState<InboxTemplatePayload | null>(null);
  const templateButton = useRef<HTMLButtonElement>(null);
  const isWhatsApp = item.channel === "whatsapp";
  // Outside the 24-hour window only an approved template can be sent.
  const windowClosed = isWhatsApp && Boolean(item.reply.requiresTemplate);
  const timeline = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const previousLastId = useRef<number | undefined>(undefined);
  const capability = getChannelCapabilities(item.channel);
  const onTemplateChange = useCallback(
    (value: InboxTemplatePayload | null) => setTemplatePayload(value),
    [],
  );
  useEffect(() => {
    const lastId = thread.messages.at(-1)?.id;
    if (
      lastId !== previousLastId.current &&
      atBottom.current &&
      timeline.current
    )
      timeline.current.scrollTop = timeline.current.scrollHeight;
    previousLastId.current = lastId;
  }, [thread.messages]);
  const sendTemplate = async () => {
    if (!templatePayload) return;
    const { content, ...template } = templatePayload;
    if (await thread.send(template, { content })) {
      setTemplatePayload(null);
      setTemplatePanelOpen(false);
    }
  };
  return (
    <section
      className="workspace-conversation flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card"
      aria-label="Selected conversation"
    >
      <header className="shrink-0 border-b bg-card px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0 md:hidden"
            onClick={onBack}
            aria-label="Back to inbox"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-muted/40 font-medium">
            {item.leadName.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">
              {item.leadName}
            </h2>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ChannelIcon channel={item.channel} className="h-3.5 w-3.5" />
              <span>{INBOX_LABELS[item.channel]}</span>
              <span aria-hidden="true">·</span>
              <span className="truncate">
                {item.recipient ||
                  item.leadCompany ||
                  "Contact details unavailable"}
              </span>
            </div>
          </div>
          <Link
            href={`/dashboard/leads/view/${item.leadId}`}
            className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="View contact"
          >
            <span className="hidden lg:inline">View contact</span>
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
          <LockKeyhole aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {item.channel === "email" &&
          item.reply.accountLabel &&
          ["gmail", "resend"].includes(item.integrationProvider || "") ? (
            <EmailSenderPicker
              lockedSender={{
                email: item.reply.accountLabel,
                type: item.integrationProvider as "gmail" | "resend",
              }}
              value={item.reply.senderId}
              onChange={() => {}}
              compact
            />
          ) : item.channel === "email" && !item.reply.accountLabel ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
              Sender account unavailable
            </span>
          ) : (
            <span>
              From{" "}
              <span className="font-medium text-foreground">
                {sendingAccountText(item) || "Original account unavailable"}
              </span>
            </span>
          )}
          <span className="sr-only">Original sending account</span>
          {item.subject && (
            <span className="min-w-0 truncate">Subject: {item.subject}</span>
          )}
        </div>
      </header>
      {/* The history keeps at least 40% of the panel. On a short laptop screen the header,
          assistant line and composer used to squeeze it to an unreadable strip. */}
      <div
        ref={timeline}
        onScroll={() => {
          const el = timeline.current;
          if (el)
            atBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
        className="min-h-[40%] flex-1 overflow-y-auto overscroll-contain bg-muted/15 px-4 py-5 sm:px-6"
      >
        {item.kind === "conversation" && ["email", "whatsapp", "instagram", "facebook"].includes(item.channel) && (
          <ConversationEventTimeline conversationId={item.id} refreshToken={refreshToken} className="mx-auto mb-5 max-w-3xl" />
        )}
        {thread.loading ? (
          <div className="mx-auto max-w-3xl space-y-5">
            {[0, 1, 2].map((i) => (
              <Skeleton
                key={i}
                className={cn("h-20 w-3/4 rounded-xl", i === 1 && "ml-auto")}
              />
            ))}
          </div>
        ) : thread.error && thread.messages.length === 0 ? (
          <div role="alert" className="mx-auto max-w-md py-12 text-center">
            <p className="text-sm text-destructive">{thread.error}</p>
            <Button
              className="mt-3"
              variant="outline"
              onClick={() => void thread.refresh()}
            >
              Try again
            </Button>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl">
            {thread.error && <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <p>{thread.error} Your loaded messages and draft are still available.</p>
              <Button className="mt-2" variant="outline" size="sm" onClick={() => void thread.refresh()}>Retry conversation</Button>
            </div>}
            {thread.hasOlder && (
              <div className="mb-5 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={thread.loadingOlder}
                  onClick={() => void thread.loadOlder()}
                >
                  {thread.loadingOlder ? "Loading…" : "Load older messages"}
                </Button>
              </div>
            )}
            {thread.messages.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No messages in this conversation yet.
              </p>
            ) : (
              <OutreachMessageTimeline
                channel={item.channel}
                messages={thread.messages}
                conversation={thread.conversation}
                onEditDraft={
                  item.reply.canReply
                    ? (message) =>
                        thread.setDraft({
                          content: message.content,
                          htmlContent: message.htmlContent || "",
                          subject: message.subject || thread.draft.subject,
                          existingDraftMessageId: message.id,
                        })
                    : undefined
                }
                onSendDraft={
                  item.reply.canReply && !windowClosed
                    ? (message) => void thread.send({}, message)
                    : undefined
                }
                onDiscardDraft={
                  item.reply.canReply
                    ? (message) => void thread.discard(message)
                    : undefined
                }
              />
            )}
          </div>
        )}
      </div>
      {thread.actionError && !templatePanelOpen && (
        <div
          role="alert"
          className="shrink-0 border-t bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {thread.actionError}
        </div>
      )}
      {!thread.loading && (!item.reply.canReply || item.reply.assistant?.ready === false) ? (
        <div className="flex min-h-0 max-h-[50%] shrink items-start gap-2 overflow-y-auto border-t bg-card px-4 py-3 text-xs leading-5 text-muted-foreground sm:px-6">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
          <p role={item.reply.assistant?.ready === false ? "alert" : undefined}>
            {item.reply.reason || (item.reply.assistant?.ready === false ? item.reply.assistant.error : null)}
            {item.kind === "conversation" && (
              <Link
                href={item.reply.assistant?.setupUrl || (item.channel === "sms" ? "/dashboard/integrations/msg91" : "/dashboard/integrations")}
                className="ml-1 inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
              >
                {item.reply.assistant && !item.reply.assistant.ready ? 'Fix in settings' : 'Manage connections'}
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            )}
          </p>
          {item.reply.assistant?.ready === false && <div className="mt-3 space-y-2"><Textarea aria-label="Reply draft" value={thread.draft.content} onChange={event => thread.setDraft({ content: event.target.value })} rows={3} maxLength={50000} /><p>Draft kept in this tab. Fixing the settings will not send it automatically.</p></div>}
          </div>
        </div>
      ) : (
        !thread.loading && (
          <div className="min-h-0 max-h-[50%] shrink overflow-y-auto border-t bg-card">
            {windowClosed && (
              <div role="status" className="flex items-center justify-center gap-2 border-b bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>24-hour window closed · reply with a template</span>
              </div>
            )}
            <OutreachComposeArea
              channel={item.channel}
              appearance="neutral"
              message={thread.draft.content}
              onMessageChange={(content) => thread.setDraft({ content })}
              emailDesignId={thread.draft.emailDesignId}
              onEmailDesignChange={emailDesignId => thread.setDraft({ emailDesignId })}
              htmlContent={thread.draft.htmlContent}
              onHtmlContentChange={item.channel === "email" ? (htmlContent) => thread.setDraft({ htmlContent }) : undefined}
              onSend={() => void thread.send()}
              sending={thread.sending}
              disabled={Boolean(thread.error) || thread.uploading || windowClosed}
              placeholder={windowClosed ? "Free-form replies open again when the customer writes" : undefined}
              showSubject={item.channel === "email"}
              subject={thread.draft.subject}
              onSubjectChange={(subject) => thread.setDraft({ subject })}
              attachments={thread.draft.attachments}
              uploadingAttachments={thread.uploading}
              fileAccept={
                item.channel === "instagram"
                  ? ".png,.jpg,.jpeg,.mp3,.ogg,.m4a"
                  : item.channel === "facebook"
                    ? ".png,.jpg,.jpeg,.gif,.mp3,.ogg,.m4a"
                    : ".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.mp3,.ogg,.m4a,.aac"
              }
              onFilesSelected={capability.supportsAttachments ? (files) => void thread.upload(files) : undefined}
              onRemoveAttachment={(id) =>
                thread.setDraft({
                  attachments: thread.draft.attachments.filter(
                    (a) => a.id !== id,
                  ),
                })
              }
              // WhatsApp's Template button stays usable when the window is closed.
              inlineReply={isWhatsApp}
              showTemplate={!isWhatsApp}
              onTemplateClick={() => setTemplatesOpen(true)}
              extraLeftActions={isWhatsApp ? (
                <Button
                  ref={templateButton}
                  type="button"
                  variant={windowClosed ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setTemplatePanelOpen(true)}
                  disabled={thread.sending || Boolean(thread.error)}
                  className={cn("h-8 gap-1.5 rounded-lg px-2.5 text-xs", !windowClosed && "text-muted-foreground hover:text-foreground")}
                >
                  <FileText className="hidden size-3.5 sm:block" aria-hidden="true" />
                  Template
                </Button>
              ) : undefined}
              showAIGenerate={!windowClosed}
              onAIGenerateClick={() => void thread.generate()}
              aiGenerating={thread.generating}
            />
          </div>
        )
      )}
      {isWhatsApp && (
        <Sheet
          open={templatePanelOpen}
          onOpenChange={(open) => {
            if (thread.sending) return;
            setTemplatePanelOpen(open);
            if (!open) setTemplatePayload(null);
          }}
        >
          <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-md" onCloseAutoFocus={(event) => {
            if (templateButton.current) {
              event.preventDefault();
              templateButton.current.focus();
            }
          }}>
            <SheetHeader className="border-b py-4 pl-5 pr-12 text-left">
              <SheetTitle>Send a WhatsApp template</SheetTitle>
              <SheetDescription>
                {windowClosed
                  ? "The 24-hour window is closed, so only an approved template can restart this conversation."
                  : "Pick an approved template, fill in its fields and check the preview."}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <InboxWhatsAppTemplate onChange={onTemplateChange} providerAccountId={item.reply.providerAccountId} />
            </div>
            <SheetFooter className="flex-col gap-2 border-t px-5 py-4 sm:flex-col">
              {thread.actionError && <p role="alert" className="text-xs text-destructive">{thread.actionError}</p>}
              <Button
                loading={thread.sending}
                disabled={!templatePayload || Boolean(thread.error)}
                onClick={() => void sendTemplate()}
                className="w-full"
              >
                <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                Send template
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      )}
      <TemplateSelector
        open={templatesOpen}
        onOpenChange={setTemplatesOpen}
        channel={item.channel}
        leadId={item.leadId}
        onSelect={(template) => {
          const message = readLibraryDraft(template.content);
          thread.setDraft({
            content: message.body,
            htmlContent: template.htmlContent || message.html || "",
            subject: template.subject || message.subject || thread.draft.subject,
            existingDraftMessageId: undefined,
            sourceTemplateId: template.sourceTemplateId,
            sourceTemplateVersion: template.sourceTemplateVersion,
            templateRenderContext: template.templateRenderContext,
          });
          setTemplatesOpen(false);
        }}
      />
    </section>
  );
}

export default function OutreachInbox() {
  const router = useRouter();
  const params = useSearchParams();
  const { subscribe } = useWebSocket();
  const requestedChannel = params.get("channel");
  const initialChannel = INBOX_CHANNELS.includes(requestedChannel as InboxChannel) ? requestedChannel as InboxChannel : "all";
  const [channel, setChannel] = useState<InboxChannel | "all">(initialChannel);
  const leadId = params.get("leadId");
  useEffect(() => { setChannel(initialChannel); }, [initialChannel]);
  const [unread, setUnread] = useState(false);
  const [origin, setOrigin] = useState<InboxOriginFilter | null>(null);
  const [sort, setSort] = useState<InboxSort>("newest");
  const [totals, setTotals] = useState(emptyCounts);
  const [originFacets, setOriginFacets] = useState<{
    channel: typeof channel;
    leadId: typeof leadId;
    counts: NonNullable<InboxPage["originCounts"]>;
  }>();
  const originCounts = originFacets?.channel === channel && originFacets.leadId === leadId
    ? originFacets.counts
    : undefined;
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<InboxItem[]>([]);
  const [counts, setCounts] = useState(emptyCounts);
  // Counts are unknown until the first page arrives; never show a false "0".
  const [countsLoaded, setCountsLoaded] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<InboxItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [drafts] = useState(() => new Map<string, InboxDraft>());
  const generation = useRef(0);
  const listRequest = useRef<AbortController | null>(null);
  const loadingPage = useRef(false);
  const cursorRef = useRef<string | null>(null);
  const loadedKeys = useRef(new Set<string>());
  const selectedRef = useRef(selected);
  const conversationList = useRef<HTMLDivElement>(null);
  const viewportAnchor = useRef<{ key: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const list = conversationList.current;
    const anchor = viewportAnchor.current;
    viewportAnchor.current = null;
    if (!list || !anchor) return;
    const row = Array.from(list.querySelectorAll<HTMLElement>("[data-inbox-key]")).find(element => element.dataset.inboxKey === anchor.key);
    if (row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.top;
  }, [items]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const threadKey = params.get("thread");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (mode: "reset" | "refresh" | "more") => {
      if (mode === 'refresh' && loadingPage.current) return;
      if (mode === "more" && (loadingPage.current || !cursorRef.current))
        return;
      listRequest.current?.abort();
      const controller = new AbortController();
      listRequest.current = controller;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
      if (mode !== "more") generation.current++;
      const requestGeneration = generation.current;
      loadingPage.current = true;
      setError(null);
      if (mode === "more") setLoadingMore(true);
      else if (mode === "reset") setLoading(true);
      else setRefreshing(true);
      const queryParams = new URLSearchParams({
        channel,
        unread: String(unread),
        search: query,
        limit: "50",
        sort,
      });
      if (leadId) queryParams.set("leadId", leadId);
      if (origin) queryParams.set("origin", origin);
      if (mode === "more" && cursorRef.current)
        queryParams.set("cursor", cursorRef.current);
      try {
        const page = await api.get<InboxPage>(
          `/api/outreach-conversations/inbox?${queryParams}`,
          { signal: controller.signal },
        );
        if (requestGeneration !== generation.current) return;
        // A burst of activity can replace the entire first page. Start a new
        // contiguous window so the old cursor cannot skip the unseen gap.
        const restartWindow =
          mode === "refresh" &&
          loadedKeys.current.size > 0 &&
          page.items.length > 0 &&
          !page.items.some((item) => loadedKeys.current.has(item.key));
        if (
          mode === "reset" ||
          restartWindow ||
          (mode === "refresh" && !page.nextCursor)
        ) {
          loadedKeys.current.clear();
        }
        page.items.forEach((item) => loadedKeys.current.add(item.key));
        // Preserve the visible thread when incoming activity reorders the list.
        // Appended pages retain their natural scroll position.
        const list = conversationList.current;
        if (mode === "refresh" && list?.clientHeight) {
          const top = list.getBoundingClientRect().top;
          const firstVisible = Array.from(list.querySelectorAll<HTMLElement>("[data-inbox-key]")).find(row => row.getBoundingClientRect().bottom > top);
          viewportAnchor.current = firstVisible ? { key: firstVisible.dataset.inboxKey!, top: firstVisible.getBoundingClientRect().top - top } : null;
        }
        const compare = sort === "oldest" ? (a: InboxItem, b: InboxItem) => order(b, a) : order;
        setItems((previous) => {
          if (mode === "reset" || restartWindow) return page.items;
          const boundary = page.items.at(-1);
          const retained =
            mode === "more"
              ? previous
              : page.nextCursor && boundary
                ? previous.filter((item) => compare(item, boundary) > 0)
                : [];
          return [
            ...new Map(
              [...retained, ...page.items].map((item) => [item.key, item]),
            ).values(),
          ].sort(compare);
        });
        if (
          mode !== "refresh" ||
          restartWindow ||
          !page.nextCursor ||
          !cursorRef.current
        ) {
          cursorRef.current = page.nextCursor;
          setCursor(page.nextCursor);
        }
        setCounts(page.unreadThreads);
        if (page.totalThreads) setTotals(page.totalThreads);
        if (page.originCounts) setOriginFacets({ channel, leadId, counts: page.originCounts });
        setCountsLoaded(true);
        setError(null);
      } catch (e) {
        if (requestGeneration === generation.current)
          setError(
            timedOut
              ? query
                ? 'The search did not finish within 20 seconds, so results may be incomplete. Try again, or clear the search to see all conversations.'
                : 'Your conversations did not load within 20 seconds. Try again.'
              : e instanceof Error ? e.message : "The inbox could not be loaded.",
          );
      } finally {
        clearTimeout(timeout);
        if (requestGeneration === generation.current) {
          loadingPage.current = false;
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [channel, unread, origin, query, leadId, sort],
  );
  useEffect(() => {
    viewportAnchor.current = null;
    if (conversationList.current) conversationList.current.scrollTop = 0;
    cursorRef.current = null;
    setCursor(null);
    setItems([]);
    void load("reset");
    const requestVersion = generation;
    const activeRequest = listRequest;
    return () => { requestVersion.current++; activeRequest.current?.abort(); };
  }, [load]);
  const refresh = useCallback(() => {
    void load("refresh");
    setRefreshToken((value) => value + 1);
  }, [load]);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible") refreshRef.current();
    };
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    const onEvent = () => {
      clearTimeout(eventTimer);
      eventTimer = setTimeout(update, 200);
    };
    const unsubscribe = [
      "new_inbound_message",
      "outreach_message_updated",
      "outreach_sent",
      "message_status_updated",
      "websocket_connected",
    ].map((event) => subscribe(event, onEvent));
    const interval = setInterval(update, 30_000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(interval);
      clearTimeout(eventTimer);
      unsubscribe.forEach((fn) => fn());
      document.removeEventListener("visibilitychange", update);
    };
  }, [subscribe]);
  useEffect(() => {
    if (!threadKey) {
      setSelected(null);
      setSelectionError(null);
      return;
    }
    if (selectedRef.current?.key === threadKey) return;
    setSelected(null);
    setSelectionError(null);
    if (!/^(conversation|legacy):[1-9]\d*$/.test(threadKey)) {
      setSelectionError("This conversation link is invalid.");
      return;
    }
    let active = true;
    const [kind, id] = threadKey.split(":");
    api
      .get<{ item: InboxItem }>(
        `/api/outreach-conversations/inbox/${kind}/${id}`,
      )
      .then((response) => {
        if (active) {
          setSelected(response.item);
          setSelectionError(null);
        }
      })
      .catch((e) => {
        if (active)
          setSelectionError(
            e instanceof Error
              ? e.message
              : "This conversation is unavailable.",
          );
      });
    return () => {
      active = false;
    };
  }, [threadKey]);
  const inboxUrl = (thread?: string, nextChannel = channel) => {
    const next = new URLSearchParams(params.toString());
    if (nextChannel !== 'all') next.set('channel', nextChannel);
    else next.delete('channel');
    if (leadId) next.set('leadId', leadId);
    if (thread) next.set('thread', thread);
    else next.delete('thread');
    const hash = typeof window === 'undefined' ? '' : window.location.hash;
    return `/dashboard/outreach/inbox${next.size ? `?${next}` : ''}${hash}`;
  };
  const changeChannel = (value: InboxChannel | 'all') => {
    const keepSelection = selected && (value === 'all' || selected.channel === value);
    setChannel(value);
    if (!keepSelection) setSelected(null);
    setSelectionError(null);
    router.replace(inboxUrl(keepSelection ? selected.key : undefined, value), { scroll: false });
  };
  const clearDrawerFilters = () => {
    setSearch("");
    setQuery("");
    setUnread(false);
    setOrigin(null);
    setSort("newest");
  };
  const select = (item: InboxItem) => {
    setSelected(item);
    setSelectionError(null);
    router.replace(inboxUrl(item.key), { scroll: false });
  };
  const close = () => {
    setSelected(null);
    router.replace(inboxUrl(), { scroll: false });
  };
  const onRead = useCallback((item: InboxItem) => {
    setItems((previous) =>
      previous.map((row) =>
        row.key === item.key ? { ...item, unreadCount: 0 } : row,
      ),
    );
    setSelected((previous) =>
      previous?.key === item.key ? { ...item, unreadCount: 0 } : previous,
    );
    if (item.unreadCount > 0) void refreshRef.current();
  }, []);
  const onChanged = useCallback(() => refreshRef.current(), []);
  const activeFilters = Number(unread) + Number(Boolean(origin)) + Number(Boolean(search.trim()));
  const visibleItems = items.filter(
    (item) => !unread || item.unreadCount > 0 || item.key === selected?.key,
  );
  if (
    unread &&
    selected &&
    selected.kind === "conversation" &&
    (channel === "all" || selected.channel === channel) &&
    (!leadId || selected.leadId === Number(leadId)) &&
    (!origin || (origin === "ai" ? selected.aiHandled : selected.origin === origin)) &&
    !visibleItems.some((item) => item.key === selected.key)
  )
    visibleItems.unshift(selected);
  return (
    <div
      className="outreach-workspace flex h-full min-h-0 w-full flex-col overflow-hidden bg-background"
      data-testid="outreach-inbox"
    >
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-2 px-3 py-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">Inbox</h1><p className="mt-1 text-sm text-muted-foreground">Customer conversations across channels</p></div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" aria-label={activeFilters ? `Filters, ${activeFilters} active` : "Filters"}>
                <SlidersHorizontal className="size-4" aria-hidden="true" />
                Filters
                {activeFilters > 0 && <span aria-hidden="true" className="rounded bg-primary/10 px-1.5 tabular-nums text-primary">{activeFilters}</span>}
              </Button>
            </SheetTrigger>
            <SheetContent className="outreach-workspace flex w-full flex-col gap-0 p-0 sm:max-w-md">
              <SheetHeader className="border-b py-4 pl-5 pr-12 text-left">
                <SheetTitle>Inbox filters</SheetTitle>
                <SheetDescription>{channel === "all" ? "All channels" : INBOX_LABELS[channel]}</SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
                <div className="space-y-2">
                  <label htmlFor="inbox-search" className="block text-sm font-medium">Search inbox</label>
                  <div className="relative">
                    <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
                    <Input id="inbox-search" placeholder="Search contacts or messages" value={search} maxLength={200}
                      onChange={(event) => setSearch(event.target.value)} className="h-10 pl-9" />
                  </div>
                </div>
                <div className="space-y-2">
                  <label htmlFor="inbox-sort" className="block text-sm font-medium">Sort by</label>
                  <div className="relative">
                    <select id="inbox-sort" value={sort} onChange={(event) => setSort(event.target.value === "oldest" ? "oldest" : "newest")}
                      className="h-10 w-full appearance-none rounded-lg border border-input bg-background px-3 pr-9 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                      <option value="newest">Newest activity first</option>
                      <option value="oldest">Oldest activity first</option>
                    </select>
                    <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-3 size-4 text-muted-foreground" />
                  </div>
                </div>
                <div className="space-y-2">
                  <h3 id="inbox-show-label" className="text-sm font-medium">Show conversations</h3>
                  <div role="group" aria-labelledby="inbox-show-label" className="inline-flex rounded-lg border bg-muted/40 p-0.5">
                    {([false, true] as const).map(value => (
                      <button key={String(value)} type="button" aria-pressed={unread === value} onClick={() => setUnread(value)}
                        className={cn("flex min-h-10 items-center gap-1.5 rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring", unread === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                        {value ? "Unread" : "All"}
                        {countsLoaded && <span className="tabular-nums text-muted-foreground">{((value ? counts[channel] : totals[channel]) ?? 0).toLocaleString()}</span>}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <h3 id="inbox-origin-label" className="text-sm font-medium">Conversation origin</h3>
                  <div role="group" aria-labelledby="inbox-origin-label" className="flex flex-wrap gap-2">
                    {ORIGIN_CHIPS.map(value => (
                      <Button key={value} type="button" size="sm" variant="outline" aria-pressed={origin === value}
                        onClick={() => setOrigin(origin === value ? null : value)} className={cn("min-h-10 rounded-full text-xs", origin === value && "border-primary bg-primary/10 text-primary")}>
                        {INBOX_ORIGIN_LABELS[value]}
                        {originCounts && <span className="tabular-nums">{originCounts[value].toLocaleString()}</span>}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
              <SheetFooter className="flex-row justify-between border-t px-5 py-4 sm:justify-between">
                <Button type="button" variant="ghost" onClick={clearDrawerFilters} disabled={!activeFilters && sort === "newest"}>Clear filters</Button>
                <SheetClose asChild><Button type="button">Done</Button></SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>
          <Button variant="outline" size="sm" asChild><Link href="/dashboard/outreach/follow-ups">Follow-ups</Link></Button>
          <Button variant="outline" size="sm" asChild><Link href="/dashboard/outreach/activity">Activity</Link></Button>
          <Button variant="outline" size="icon" aria-label="Refresh inbox" loading={refreshing} disabled={loading || loadingMore} onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
          <Button size="sm" asChild><Link href={`/dashboard/outreach/create${channel === 'all' ? '' : `?channel=${channel}`}`}><Plus className="mr-2 h-4 w-4" />New outreach</Link></Button>
        </div>
      </header>
      <div role="group" aria-label="Filter by channel" className="flex shrink-0 flex-wrap gap-1.5 px-3 pb-3">
        {(["all", ...INBOX_CHANNELS] as const).map(value => (
          <Button key={value} type="button" size="sm" variant={channel === value ? "default" : "outline"}
            aria-pressed={channel === value} onClick={() => changeChannel(value)}>
            {value === "all" ? <Inbox className="size-4" aria-hidden="true" /> : <ChannelIcon channel={value} />}
            {value === "all" ? "All channels" : INBOX_LABELS[value]}
          </Button>
        ))}
      </div>
      {leadId && <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
        <span>Conversations for the selected contact</span>
        <Button variant="ghost" size="sm" onClick={() => router.replace(`/dashboard/outreach/inbox${channel === 'all' ? '' : `?channel=${channel}`}`, { scroll: false })}>Show all contacts</Button>
      </div>}
      <div className="flex min-h-0 min-w-0 w-full flex-1 border-t">
      <aside
        className={cn(
          "flex h-full min-h-0 w-full shrink-0 flex-col overflow-hidden bg-card md:w-[310px] md:border-r xl:w-[350px]",
          selected && "hidden md:flex",
        )}
        aria-label="Inbox conversations"
      >
        <div ref={conversationList} className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          onScroll={event => {
            const list = event.currentTarget;
            if (!error && !loading && list.scrollHeight - list.scrollTop - list.clientHeight < 240) void load("more");
          }}>
          {selectionError && (
            <p
              role="alert"
              className="border-b p-4 text-sm text-destructive md:hidden"
            >
              {selectionError}
            </p>
          )}
          {error && (
            <div role="alert" className="border-b p-4 text-sm text-destructive">
              {error}
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void load(items.length ? "refresh" : "reset")}
              >
                Try again
              </Button>
            </div>
          )}
          {(loading || refreshing) && <p role="status" className="px-4 py-3 text-xs text-muted-foreground">{loading ? 'Loading conversations…' : 'Refreshing conversations…'}</p>}
          {loading ? (
            <div className="space-y-4 p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-20 rounded-lg" />
              ))}
            </div>
          ) : visibleItems.length === 0 && !error ? (
            <div className="px-6 py-16 text-center">
              <Inbox className="mx-auto mb-4 h-8 w-8 text-muted-foreground/60" />
              <p className="text-sm font-medium">
                {query
                  ? "No matching conversations"
                  : origin
                    ? `No ${unread ? "unread " : ""}conversations in ${INBOX_ORIGIN_LABELS[origin]}`
                  : unread
                    ? "No unread conversations"
                    : "No conversations yet"}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {query
                  ? "Try another name, company, or phrase."
                  : unread
                    ? "New replies will appear here."
                    : "Your sent outreach and incoming replies will appear here."}
              </p>
              {query || unread || origin || channel !== "all" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  onClick={() => { clearDrawerFilters(); changeChannel("all"); }}
                >
                  Clear filters
                </Button>
              ) : null}
            </div>
          ) : (
            <div>
              {visibleItems.map((item) => (
                <button
                  type="button"
                  key={item.key}
                  data-inbox-key={item.key}
                  style={{ contentVisibility: "auto", containIntrinsicSize: "auto 136px" }}
                  onClick={() => select(item)}
                  aria-current={selected?.key === item.key ? "true" : undefined}
                  aria-label={`Open ${item.leadName} on ${INBOX_LABELS[item.channel]}${item.kind === "legacy" ? " historical send" : ""}`}
                  className={cn(
                    "relative flex w-full items-start gap-3 border-b px-4 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
                    selected?.key === item.key &&
                      "bg-primary/5 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary",
                  )}
                >
                  <div className="relative mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-muted/30 text-sm font-medium">
                    {item.leadName.slice(0, 1).toUpperCase()}
                    <span className="absolute -bottom-1 -right-1 rounded-full border bg-card p-1">
                      <ChannelIcon channel={item.channel} className="h-3 w-3" />
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p
                        className={cn(
                          "truncate text-sm",
                          item.unreadCount ? "font-semibold" : "font-medium",
                        )}
                      >
                        {item.leadName}
                      </p>
                      <time
                        dateTime={item.activityAt}
                        className="shrink-0 font-mono text-[11px] text-muted-foreground"
                      >
                        {new Date(item.activityAt).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric" },
                        )}
                      </time>
                    </div>
                    {item.subject && item.channel === "email" && (
                      <p className="mt-0.5 truncate text-xs text-foreground/75">
                        {item.subject}
                      </p>
                    )}
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {(item.channel === "whatsapp" && item.preview ? whatsAppPreviewText(item.preview) : item.preview) || "Attachment or message"}
                    </p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className={cn("truncate text-[11px]", item.kind === "legacy" && FAILED_SEND.has(item.status) ? "text-destructive" : "text-muted-foreground")}>
                        {item.kind === "legacy"
                          ? FAILED_SEND.has(item.status)
                            ? "Not delivered · read only"
                            : "Historical send · read only"
                          : sendingAccountText(item) ||
                            INBOX_LABELS[item.channel]}
                      </span>
                      {item.origin && (
                        <span className="ml-auto shrink-0 rounded border px-1.5 text-[10px] text-muted-foreground">
                          {INBOX_ORIGIN_LABELS[item.origin]}{item.aiHandled ? " · AI" : ""}
                        </span>
                      )}
                      {item.unreadCount > 0 && (
                        <span className="min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center font-mono text-[11px] text-primary-foreground">
                          {item.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {cursor && !loading && (
            <div className="p-4 text-center">
              <Button
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={() => void load("more")}
              >
                {loadingMore ? "Loading…" : "Load more conversations"}
              </Button>
            </div>
          )}
        </div>
      </aside>
      {selected ? (
        <InboxThread
          key={selected.key}
          initial={selected}
          refreshToken={refreshToken}
          drafts={drafts}
          onRead={onRead}
          onChanged={onChanged}
          onBack={close}
        />
      ) : (
        <div className="hidden min-w-0 flex-1 items-center justify-center bg-muted/15 p-8 md:flex">
          <div className="max-w-sm text-center">
            <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl border bg-card">
              <Inbox className="h-9 w-9 text-primary" strokeWidth={1.5} />
            </div>
            <h2 className="text-xl font-semibold tracking-tight">
              Your outreach, together
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Choose a conversation to read the full history and reply from its
              original account.
            </p>
            <div
              className="mt-6 flex justify-center gap-4 text-muted-foreground/70"
              aria-hidden="true"
            >
              {INBOX_CHANNELS.map((value) => (
                <ChannelIcon channel={value} key={value} />
              ))}
            </div>
            {selectionError && (
              <p role="alert" className="mt-5 text-sm text-destructive">
                {selectionError}
              </p>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
