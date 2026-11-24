"use client";
import type { EmailDesignId } from '../../../../../shared/emailDesigns';
import type { TemplateRenderContext } from '../../../../../shared/templateRenderContext';

import { useCallback, useEffect, useRef, useState } from "react";
import api from "@/lib/api";
import { customerDeliveryFailure } from '@/lib/customer-delivery-readiness';
import type { InboxItem } from "@/lib/outreach-inbox";
import type { OutreachConversation, OutreachMessage } from "../types";
import type { EmailAttachment } from "../EmailComposeBuilder";

export interface InboxDraft {
  emailDesignId?: EmailDesignId;
  content: string;
  htmlContent?: string;
  subject: string;
  attachments: EmailAttachment[];
  existingDraftMessageId?: number;
  sourceTemplateId?: number;
  sourceTemplateVersion?: number;
  templateRenderContext?: TemplateRenderContext;
}

const messageOrder = (a: OutreachMessage, b: OutreachMessage) =>
  new Date(a.sentAt || a.createdAt).getTime() - new Date(b.sentAt || b.createdAt).getTime() ||
  a.id - b.id;

export function useInboxConversation(
  initial: InboxItem,
  refreshToken: number,
  drafts: Map<string, InboxDraft>,
  onRead: (item: InboxItem) => void,
  onChanged: () => void,
) {
  const [item, setItem] = useState(initial);
  const [messages, setMessages] = useState<OutreachMessage[]>([]);
  const [conversation, setConversation] = useState<OutreachConversation | null>(
    null,
  );
  const [draft, setDraftState] = useState<InboxDraft>(
    () =>
      drafts.get(initial.key) || {
        content: "",
        subject: initial.subject || "",
        attachments: [],
      },
  );
  const draftRef = useRef(draft);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deliveryFailure, setDeliveryFailure] = useState<ReturnType<typeof customerDeliveryFailure>>();
  useEffect(() => setDeliveryFailure(undefined), [initial.key]);
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const alive = useRef(true);
  const loadInFlight = useRef(false);
  const sendInFlight = useRef(false);
  const olderInFlight = useRef(false);
  const oldestMessageId = useRef<number | undefined>(undefined);
  const knownIds = useRef(new Set<number>());
  const sendAttempt = useRef<{ payload: string; key: string } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const setDraft = useCallback(
    (patch: Partial<InboxDraft>) => {
      const contentChanged = ['content', 'htmlContent', 'subject'].some(key => key in patch && patch[key as keyof InboxDraft] !== draftRef.current[key as keyof InboxDraft]);
      const next = { ...draftRef.current, ...(contentChanged && !patch.sourceTemplateId ? { sourceTemplateId: undefined, sourceTemplateVersion: undefined, templateRenderContext: undefined } : {}), ...patch };
      draftRef.current = next;
      drafts.set(initial.key, next);
      setDraftState(next);
    },
    [drafts, initial.key],
  );

  const refresh = useCallback(async () => {
    if (loadInFlight.current || olderInFlight.current) return;
    loadInFlight.current = true;
    try {
      const detail = await api.get<{
        item: InboxItem;
        message?: OutreachMessage;
      }>(`/api/outreach-conversations/inbox/${initial.kind}/${initial.id}`);
      const response =
        initial.kind === "conversation"
          ? await api.get<{
              conversation: OutreachConversation;
              messages: OutreachMessage[];
            }>(
              `/api/outreach-conversations/${detail.item.channel}/${initial.id}/messages?limit=50&offset=0`,
            )
          : {
              conversation: null,
              messages: detail.message ? [detail.message] : [],
            };
      if (!alive.current) return;
      setItem({ ...detail.item, unreadCount: 0 });
      setConversation(response.conversation);
      setError(null);
      // If more than a page arrived while away, restart from a contiguous
      // window. Older pages remain reachable through the stable message ID.
      const resetWindow =
        knownIds.current.size === 0 ||
        (response.messages.length === 50 &&
          response.messages.every((m) => !knownIds.current.has(m.id)));
      if (resetWindow) {
        knownIds.current.clear();
        oldestMessageId.current = response.messages[0]?.id;
        setHasOlder(
          initial.kind === "conversation" && response.messages.length === 50,
        );
      }
      response.messages.forEach((m) => knownIds.current.add(m.id));
      setMessages((previous) => {
        const merged = new Map(
          (resetWindow ? previous.filter(message => message.status === "draft") : previous).map((m) => [m.id, m]),
        );
        response.messages.forEach((m) => merged.set(m.id, m));
        // Drafts discarded in another tab should not remain actionable here.
        previous
          .filter(
            (m) =>
              m.status === "draft" &&
              (response.messages.length < 50 || (response.messages[0] && messageOrder(m, response.messages[0]) >= 0)) &&
              !response.messages.some((current) => current.id === m.id),
          )
          .forEach((m) => merged.delete(m.id));
        return [...merged.values()].sort(messageOrder);
      });
      if (initial.kind === "conversation") onRead(detail.item);
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : "Messages could not be loaded.",
        );
    } finally {
      loadInFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, [initial.kind, initial.id, onRead]);
  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const loadOlder = async () => {
    if (
      olderInFlight.current ||
      loadInFlight.current ||
      !hasOlder ||
      !oldestMessageId.current
    )
      return;
    olderInFlight.current = true;
    setLoadingOlder(true);
    try {
      const response = await api.get<{ messages: OutreachMessage[] }>(
        `/api/outreach-conversations/${item.channel}/${item.id}/messages?limit=50&beforeMessageId=${oldestMessageId.current}`,
      );
      if (!alive.current) return;
      if (response.messages.length)
        oldestMessageId.current = response.messages[0].id;
      response.messages.forEach((m) => knownIds.current.add(m.id));
      setMessages((previous) =>
        [
          ...new Map(
            [...response.messages, ...previous].map((m) => [m.id, m]),
          ).values(),
        ].sort(messageOrder),
      );
      setHasOlder(response.messages.length === 50);
      setActionError(null);
    } catch (e) {
      if (alive.current)
        setActionError(
          e instanceof Error
            ? e.message
            : "Older messages could not be loaded.",
        );
    } finally {
      olderInFlight.current = false;
      if (alive.current) setLoadingOlder(false);
    }
  };

  const send = async (
    extra: Record<string, unknown> = {},
    override?: OutreachMessage,
  ) => {
    if (sendInFlight.current || deliveryFailure || !item.reply.canReply || item.reply.assistant?.ready === false || error || uploading)
      return false;
    const snapshot = override
      ? {
          ...draftRef.current,
          content: override.content,
          htmlContent: override.htmlContent || "",
          subject: override.subject || draftRef.current.subject,
          attachments: [],
          existingDraftMessageId: override.id,
          sourceTemplateId: undefined, sourceTemplateVersion: undefined, templateRenderContext: undefined,
        }
      : draftRef.current;
    if (!snapshot.content.trim() && !snapshot.attachments.length) return false;
    const body = {
      emailDesignId: item.channel === "email" ? snapshot.emailDesignId : undefined,
      content: snapshot.content,
      htmlContent: item.channel === "email" ? snapshot.htmlContent || undefined : undefined,
      subject: snapshot.subject || undefined,
      attachments: snapshot.attachments,
      existingDraftMessageId: snapshot.existingDraftMessageId,
      ...(snapshot.sourceTemplateId ? { sourceTemplateId: snapshot.sourceTemplateId, sourceTemplateVersion: snapshot.sourceTemplateVersion, templateRenderContext: snapshot.templateRenderContext } : {}),
      senderId: item.reply.senderId,
      ...extra,
      inboxContext: true,
      expectedProviderAccountId: item.reply.providerAccountId,
      expectedRecipient: item.recipient,
      confirmation: {
        confirmed: true,
        conversationId: item.id,
        recipientConfirmed: true,
        accountConfirmed: true,
        messageConfirmed: true,
      },
    };
    const fingerprint = JSON.stringify(body);
    if (sendAttempt.current?.payload !== fingerprint)
      sendAttempt.current = { payload: fingerprint, key: crypto.randomUUID() };
    sendInFlight.current = true;
    setSending(true);
    setActionError(null);
    try {
      const result = await api.post<{
        success: boolean;
        inProgress?: boolean;
        error?: string;
        manualReviewRequired?: boolean;
      }>(`/api/outreach-conversations/${item.channel}/${item.id}/messages`, {
        ...body,
        idempotencyKey: sendAttempt.current.key,
      });
      if (result.inProgress)
        throw new Error(
          "This message is still being sent. Its status will update here.",
        );
      if (!result.success)
        throw new Error(
          result.error ||
            (result.manualReviewRequired
              ? "Delivery needs review. Check the message status before retrying."
              : "The message was not sent."),
        );
      if (alive.current) {
        if (!override && draftRef.current === snapshot)
          setDraft({
            content: "",
            htmlContent: "",
            attachments: [],
            existingDraftMessageId: undefined,
          });
        sendAttempt.current = null;
        await refresh();
      }
      onChanged();
      return true;
    } catch (e) {
      if (alive.current) {
        const failure = customerDeliveryFailure(e, { channel: item.channel, accountId: item.reply.providerAccountId || '' });
        if (failure) setDeliveryFailure(failure);
        setActionError(
          e instanceof Error ? e.message : "The message could not be sent.",
        );
        await refresh();
        if (failure && alive.current) setItem(current => ({ ...current, reply: { ...current.reply, canReply: false, reason: failure.error || null, assistant: failure } }));
      }
      return false;
    } finally {
      sendInFlight.current = false;
      if (alive.current) setSending(false);
    }
  };

  const generate = async () => {
    if (generating || deliveryFailure || !item.reply.canReply || item.reply.assistant?.ready === false) return;
    const snapshot = draftRef.current;
    setGenerating(true);
    setActionError(null);
    try {
      const result = await api.post<{ content: string }>(
        `/api/outreach-conversations/${item.channel}/${item.id}/draft-reply`,
        { composerOnly: true },
      );
      if (alive.current && draftRef.current === snapshot)
        setDraft({
          content: result.content,
          htmlContent: "",
          existingDraftMessageId: undefined,
        });
    } catch (e) {
      if (alive.current)
        setActionError(
          e instanceof Error ? e.message : "The reply could not be drafted.",
        );
    } finally {
      if (alive.current) setGenerating(false);
    }
  };
  const upload = async (files: FileList) => {
    if (uploading) return;
    setUploading(true);
    setActionError(null);
    try {
      const form = new FormData();
      Array.from(files).forEach((file) => form.append("files", file));
      const result = await api.postForm<{ attachments: EmailAttachment[] }>(
        "/api/outreach/attachments",
        form,
      );
      if (alive.current)
        setDraft({
          attachments: [...draftRef.current.attachments, ...result.attachments],
        });
    } catch (e) {
      if (alive.current)
        setActionError(
          e instanceof Error ? e.message : "Attachments could not be uploaded.",
        );
    } finally {
      if (alive.current) setUploading(false);
    }
  };
  const discard = async (message: OutreachMessage) => {
    try {
      await api.post(
        `/api/outreach-conversations/${item.channel}/${item.id}/discard-draft`,
        { messageId: message.id },
      );
      if (alive.current) {
        setActionError(null);
        setMessages((previous) => previous.filter((m) => m.id !== message.id));
        await refresh();
      }
    } catch (e) {
      if (alive.current)
        setActionError(
          e instanceof Error ? e.message : "The draft could not be discarded.",
        );
    }
  };
  return {
    item: deliveryFailure ? { ...item, reply: { ...item.reply, canReply: false, reason: deliveryFailure.error || null, assistant: deliveryFailure } } : item,
    conversation,
    messages,
    draft,
    setDraft,
    loading,
    error,
    actionError,
    sending,
    generating,
    uploading,
    refresh,
    send,
    generate,
    upload,
    discard,
    hasOlder,
    loadingOlder,
    loadOlder,
  };
}
