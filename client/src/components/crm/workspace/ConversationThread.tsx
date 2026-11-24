"use client";
import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Globe, ChevronDown, Send, Brain, CheckCheck } from 'lucide-react';
import DOMPurify from 'dompurify';
import { withReadablePrivacyTokens } from '@/lib/supportQueuePresentation';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api';
import { customerDeliveryFailure } from '@/lib/customer-delivery-readiness';
import { AssistantDeliveryNotice } from '@/components/outreach/AssistantDeliveryNotice';
import { ConversationEventTimeline } from '@/components/support/ConversationEventTimeline';
import type { InboxItem } from '@/lib/outreach-inbox';
import { useToast } from '@/hooks/use-toast';
import { cn, formatNumericDateTimeIST } from '@/lib/utils';
import { CHANNEL_CONFIG, CONV_STATUS_COLORS, SENTIMENT_COLORS } from './presentation';
import type { CrmPagination, OutreachConversation, OutreachMessage, SentMessage } from '@/lib/crm-workspace';
export function ConversationThread({ conversation, contactId, scope, canReply, onReplySent, initiallyOpen = false }: {
  conversation: OutreachConversation; contactId:number; scope:string; canReply:boolean; onReplySent?: () => unknown; initiallyOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const [expandedMessageId, setExpandedMessageId] = useState<number | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const [actionError, setActionError] = useState('');
  const [deliveryFailure, setDeliveryFailure] = useState<ReturnType<typeof customerDeliveryFailure>>();
  const [held, setHeld] = useState(false);
  const [older, setOlder] = useState<OutreachMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(conversation.messagesHasMore ?? (conversation.totalMessages || 0) > (conversation.messages?.length || 0));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');
  const alive = useRef(true);
  const attempt = useRef<{payload:string;key:string}|null>(null);
  const draftKey = `crm-reply:${scope}:${conversation.channel}:${conversation.providerAccountId ?? 'bound'}:${conversation.id}`;
  useEffect(() => setDeliveryFailure(undefined), [draftKey]);
  useEffect(() => { alive.current = true; return () => {alive.current = false;}; }, []);
  useEffect(() => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      if (draft && Date.now()-draft.savedAt < 7*24*60*60*1000) {
        setReplyText(draft.content || '');attempt.current = draft.attempt || null;setHeld(draft.held === true);
        if (draft.held) setActionError('This earlier reply needs a delivery check. Review it in the inbox before sending again.');
      } else {sessionStorage.removeItem(draftKey);setReplyText('');attempt.current=null;setHeld(false);setActionError('');}
    } catch { /* A blocked storage area should not prevent replying. */ }
  }, [draftKey]);
  const saveDraft = (content:string,hold=held) => {
    setReplyText(content);
    try { if (content || hold) sessionStorage.setItem(draftKey,JSON.stringify({content,savedAt:Date.now(),attempt:attempt.current,held:hold})); else sessionStorage.removeItem(draftKey); } catch { /* Tab storage is optional. */ }
  };
  const replyContext = useQuery({queryKey:['crm-reply-context',scope,conversation.id,conversation.providerAccountId],
    queryFn:({signal}) => api.get<{item:InboxItem}>(`/api/outreach-conversations/inbox/conversation/${conversation.id}`,{signal}),
    enabled:isOpen && canReply,staleTime:15_000,retry:false});
  const available = replyContext.data?.item;
  const messages = [...new Map([...older,...(conversation.messages || [])].map(message => [message.id,message])).values()]
    .sort((a,b) => new Date(a.createdAt).getTime()-new Date(b.createdAt).getTime() || a.id-b.id);
  const loadOlder = async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);setOlderError('');
    try {
      const oldest = messages[0];
      const cursor = oldest ? `&beforeMessageId=${oldest.id}` : '';
      const response = await api.get<{data:OutreachMessage[];pagination:CrmPagination}>(`/api/crm/contacts/${contactId}/conversations/${conversation.id}/messages?limit=20${cursor}`);
      if (!alive.current) return;
      setOlder(current => [...new Map([...response.data,...current].map(message => [message.id,message])).values()]);
      setHasOlder(response.pagination.hasMore === true);
    } catch (cause) { if (alive.current) setOlderError(cause instanceof Error ? cause.message : 'Older messages could not be loaded.'); }
    finally {if (alive.current) setLoadingOlder(false);}
  };
  const { toast } = useToast();
  const cfg = CHANNEL_CONFIG[conversation.channel] || { icon: Globe, label: conversation.channel, color: "bg-muted text-muted-foreground" };
  const ChannelIcon = cfg.icon;
  const messageCount = conversation.totalMessages ?? conversation.messages?.length ?? 0;

  const handleSendReply = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!replyText.trim() || sendingReply || held || deliveryFailure || !available?.reply.canReply || available.reply.assistant?.ready === false) return;
    setSendingReply(true);
    setActionError('');
    const body = {content:replyText.trim(),subject:conversation.subject || undefined,senderId:available.reply.senderId,
      inboxContext:true,expectedProviderAccountId:available.reply.providerAccountId,expectedRecipient:available.recipient,
      confirmation:{confirmed:true,conversationId:conversation.id,recipientConfirmed:true,accountConfirmed:true,messageConfirmed:true}};
    const payload = JSON.stringify(body);
    if (attempt.current?.payload !== payload) attempt.current = {payload,key:crypto.randomUUID()};
    saveDraft(replyText);
    try {
      const result = await api.post<{success:boolean;inProgress?:boolean;manualReviewRequired?:boolean;error?:string}>(
        `/api/outreach-conversations/${conversation.channel}/${conversation.id}/messages`, {...body,idempotencyKey:attempt.current.key});
      if (!alive.current) return;
      if (result.manualReviewRequired || result.inProgress) {
        setHeld(true);saveDraft(replyText,true);
        setActionError(result.manualReviewRequired ? 'Delivery needs review. Check the message in the inbox before sending again.' : 'This reply is still being sent. Check its status in the inbox before sending again.');
        void onReplySent?.();return;
      }
      if (!result.success) throw new Error(result.error || 'The reply was not sent.');
      attempt.current = null;saveDraft('',false);
      toast({ title: "Reply sent successfully" });
      void onReplySent?.();
    } catch (cause) {
      if (alive.current) {
        setDeliveryFailure(customerDeliveryFailure(cause, { channel: conversation.channel, accountId: available.reply.providerAccountId || '' }));
        const details = cause instanceof ApiError ? cause.data as {manualReviewRequired?:boolean;code?:string}|undefined : undefined;
        const uncertain = details?.manualReviewRequired || !(cause instanceof ApiError) || !cause.status
          || (cause.status>=500 && details?.code!=='OUTREACH_IDEMPOTENCY_UNAVAILABLE');
        if (uncertain) {setHeld(true);saveDraft(replyText,true);}
        setActionError(uncertain ? 'The reply outcome needs checking. Review delivery in the inbox before sending again.' : cause instanceof Error ? cause.message : 'Reply could not be sent. Your draft is still here.');
      }
    } finally {
      if (alive.current) setSendingReply(false);
    }
  };

  return <Card className="overflow-hidden rounded-xl shadow-none">
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" aria-label={`${cfg.label} conversation: ${conversation.subject || 'View messages'}`} className="w-full p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-5">
          <div className="flex items-start gap-3">
            <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", cfg.color)}><ChannelIcon className="h-5 w-5" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-muted-foreground">{cfg.label}</span><Badge className={cn("border-none text-[11px] font-normal capitalize", CONV_STATUS_COLORS[conversation.status] || "bg-muted text-muted-foreground")}>{conversation.status}</Badge>{(conversation.unreadCount || 0) > 0 && <Badge variant="secondary" className="bg-primary/10 text-[11px] font-normal text-primary">{conversation.unreadCount} unread</Badge>}</div>
              <h3 className="mt-2 break-words text-sm font-semibold leading-6">{conversation.subject || `${cfg.label} conversation`}</h3>
              {conversation.lastMessagePreview && <p className="mt-1 line-clamp-1 break-words text-sm text-muted-foreground">{conversation.lastMessagePreview}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{messageCount} {messageCount === 1 ? "message" : "messages"}</span>{conversation.providerAccountName && <span>{conversation.providerAccountName}</span>}{conversation.lastMessageAt && <time dateTime={conversation.lastMessageAt}>{formatNumericDateTimeIST(conversation.lastMessageAt)}</time>}</div>
            </div>
            <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", isOpen && "rotate-180")} />
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border bg-muted/20 p-4 sm:p-5">
          {isOpen && canReply && ["email", "whatsapp", "instagram", "facebook"].includes(conversation.channel) && <ConversationEventTimeline conversationId={conversation.id} className="mb-4" />}
          {hasOlder && <div className="mb-4 flex justify-center"><Button variant="outline" size="sm" loading={loadingOlder} onClick={() => void loadOlder()}>Load older messages</Button></div>}
          {olderError && <p role="alert" className="mb-3 text-xs text-destructive">{olderError}</p>}
          {!messages.length ? <p className="py-6 text-center text-sm text-muted-foreground">No messages in this thread</p> : <div className="space-y-4">{messages.map(message => <MessageBubble key={message.id} message={message} isExpanded={expandedMessageId === message.id} onToggle={() => setExpandedMessageId(expandedMessageId === message.id ? null : message.id)} />)}</div>}
          {canReply && (conversation.unreadCount || 0) > 0 && <Button size="sm" variant="ghost" className="mt-3 gap-1.5 text-xs" onClick={async () => {try {await api.get(`/api/outreach-conversations/${conversation.channel}/${conversation.id}/messages?limit=1&offset=0`);void onReplySent?.();} catch(cause){setActionError(cause instanceof Error ? cause.message : 'Could not mark this conversation as read.');}}}><CheckCheck className="h-3.5 w-3.5" />Mark as read</Button>}
          {canReply ? <form onSubmit={handleSendReply} className="mt-5 space-y-2 border-t border-border pt-4">
            <Label htmlFor={`crm-reply-${conversation.id}`} className="text-xs text-muted-foreground">Reply via {cfg.label}</Label>
            {available && <p className="break-words text-xs text-muted-foreground">To {available.recipient || available.leadName} · From {available.reply.accountLabel || available.reply.providerAccountId || 'the account bound to this conversation'}</p>}
            {replyContext.error && <p role="alert" className="text-xs text-destructive">Sending details could not be loaded. <button type="button" onClick={() => void replyContext.refetch()} className="underline">Try again</button></p>}
            {available && !available.reply.canReply && <p className="text-xs text-amber-700 dark:text-amber-300">{available.reply.reason || 'Replies are unavailable for this conversation.'}</p>}
            <AssistantDeliveryNotice readiness={deliveryFailure || available?.reply.assistant} />
            {actionError && <p role="alert" className="text-xs text-destructive">{actionError}</p>}
            <div className="flex items-end gap-2">
              <Textarea id={`crm-reply-${conversation.id}`} placeholder="Write your reply…" value={replyText} onChange={event => saveDraft(event.target.value)} disabled={sendingReply || held} maxLength={50000} rows={2} className="min-h-[76px] resize-y bg-card text-sm" />
              <Button type="submit" loading={sendingReply} disabled={held || Boolean(deliveryFailure) || !replyText.trim() || !available?.reply.canReply || available.reply.assistant?.ready === false} className="shrink-0 gap-2"><Send className="h-4 w-4" /> Reply</Button>
            </div>
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{replyText ? 'Draft kept in this tab' : 'Review the recipient, sending account, and message before replying.'}</span><a href={`/dashboard/outreach/inbox?thread=conversation:${conversation.id}`} className="font-medium text-primary hover:underline">{held ? 'Review delivery in inbox' : 'Open in inbox'}</a></div>
          </form> : <p className="mt-4 text-xs text-muted-foreground">Outreach access is required to reply.</p>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  </Card>;
}

function MessageBubble({ message, isExpanded, onToggle }: { message: OutreachMessage; isExpanded: boolean; onToggle: () => void }) {
  const outbound = message.direction === "outbound";
  return <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
    <article aria-label={`${outbound ? 'Outbound' : 'Inbound'} message`} className={cn("min-w-0 max-w-[95%] rounded-xl border p-3 text-sm sm:max-w-[88%] sm:p-4", outbound ? "border-primary/15 bg-primary/5" : "border-border bg-card")}>
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-semibold">{outbound ? "You" : "Contact"}</span>
          {message.status && <Badge variant="outline" className="text-[10px] font-normal capitalize">{message.status}</Badge>}
          {message.messageKind === 'follow_up' && <Badge variant="outline" className="text-[10px] font-normal">Follow-up {message.followUpStep || ''}</Badge>}
          {message.isAiGenerated && <Badge variant="outline" className="gap-1 text-[10px] font-normal"><Brain className="h-3 w-3" /> AI</Badge>}
        </div>
        <time dateTime={message.sentAt || message.createdAt} className="text-[11px] text-muted-foreground">{formatNumericDateTimeIST(message.sentAt || message.createdAt)}</time>
      </div>
      {message.manualReviewRequired && <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300">Delivery needs review in the inbox.</p>}
      {message.deliveryError && <p className="mb-2 break-words text-xs text-destructive">{message.deliveryError}</p>}
      {message.subject && <h4 className="mb-2 break-words font-medium">{message.subject}</h4>}
      <div id={`crm-message-${message.id}`} className="min-w-0 break-words leading-6">
        {isExpanded && message.htmlContent ? <div className="prose prose-sm max-w-none overflow-x-auto break-words dark:prose-invert" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.htmlContent) }} /> : <p className={cn("whitespace-pre-wrap", !isExpanded && "line-clamp-3")}>{withReadablePrivacyTokens(message.content)}</p>}
      </div>
      {isExpanded && (message.deliveredAt || message.readAt) && <div className="mt-3 flex flex-col gap-1 text-[11px] text-muted-foreground">{message.deliveredAt && <span>Delivered · {formatNumericDateTimeIST(message.deliveredAt)}</span>}{message.readAt && <span>Read · {formatNumericDateTimeIST(message.readAt)}</span>}</div>}
      <button type="button" aria-expanded={isExpanded} aria-controls={`crm-message-${message.id}`} onClick={onToggle} className="mt-2 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{isExpanded ? "Collapse message" : "Show full message"}</button>
    </article>
  </div>;
}

export function SentMessageCard({ message }: { message: SentMessage }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = CHANNEL_CONFIG[message.channel] || { icon: Globe, label: message.channel, color: "bg-muted text-muted-foreground" };
  const ChannelIcon = cfg.icon;
  return <Card className="overflow-hidden rounded-xl shadow-none">
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger asChild>
        <button type="button" aria-label={`${cfg.label} outreach: ${message.subject || 'View message'}`} className="w-full p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-5">
          <div className="flex items-start gap-3">
            <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", cfg.color)}><ChannelIcon className="h-5 w-5" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-muted-foreground">{cfg.label}</span>{message.deliveryStatus && <Badge variant="outline" className="text-[11px] font-normal capitalize">{message.deliveryStatus}</Badge>}{Number(message.followUpStep) > 0 && <Badge variant="outline" className="text-[11px] font-normal">Follow-up {message.followUpStep}</Badge>}{message.sentiment && <Badge className={cn("border-none text-[11px] font-normal capitalize", SENTIMENT_COLORS[message.sentiment] || "bg-muted text-muted-foreground")}>{message.sentiment}</Badge>}</div>
              <h3 className="mt-2 break-words text-sm font-semibold leading-6">{message.subject || `${cfg.label} outreach`}</h3>
              <p className="mt-1 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">{message.message}</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><time dateTime={message.createdAt}>{formatNumericDateTimeIST(message.createdAt)}</time>{message.replyContent && <span className="font-medium text-primary">Reply received</span>}</div>
            </div>
            <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", expanded && "rotate-180")} />
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-4 border-t border-border p-4 sm:p-5"><div><p className="mb-2 text-xs font-medium text-muted-foreground">Sent message</p><p className="whitespace-pre-wrap break-words text-sm leading-6">{message.message}</p></div>{message.replyContent && <div className="rounded-lg border-l-2 border-primary bg-primary/5 p-4"><div className="mb-2 flex flex-wrap items-center gap-2"><span className="text-xs font-semibold text-primary">Contact’s reply</span>{message.replyReceivedAt && <time dateTime={message.replyReceivedAt} className="text-xs text-muted-foreground">{formatNumericDateTimeIST(message.replyReceivedAt)}</time>}</div><p className="whitespace-pre-wrap break-words text-sm leading-6">{message.replyContent}</p></div>}</div>
      </CollapsibleContent>
    </Collapsible>
  </Card>;
}
