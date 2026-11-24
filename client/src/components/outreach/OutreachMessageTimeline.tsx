import { Fragment } from "react";
import { OutreachMessageBubble } from "./OutreachMessageBubble";
import type { OutreachChannel, OutreachConversation, OutreachMessage } from "./types";

const dateKeyFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateLabelFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "long",
  year: "numeric",
});

export function getOutreachMessageDate(message: OutreachMessage): Date | null {
  const date = new Date(message.sentAt || message.createdAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface OutreachMessageTimelineProps {
  messages: OutreachMessage[];
  channel: OutreachChannel;
  conversation?: OutreachConversation | null;
  onEditDraft?: (message: OutreachMessage) => void;
  onSendDraft?: (message: OutreachMessage) => void;
  onDiscardDraft?: (message: OutreachMessage) => void;
}

export function OutreachMessageTimeline({
  messages,
  channel,
  conversation,
  onEditDraft,
  onSendDraft,
  onDiscardDraft,
}: OutreachMessageTimelineProps) {
  let previousDateKey: string | null = null;

  return (
    <div className={channel === "email" ? "space-y-3" : "space-y-2"} role="list" aria-label={`${channel} messages`}>
      {messages.map((message) => {
        const date = getOutreachMessageDate(message);
        const dateKey = date ? dateKeyFormatter.format(date).split("/").reverse().join("-") : null;
        const showDivider = dateKey !== null && dateKey !== previousDateKey;
        if (dateKey) previousDateKey = dateKey;

        return (
          <Fragment key={message.id}>
            {showDivider && date ? (
              <div className="flex items-center gap-3 py-3" role="separator" aria-label={dateLabelFormatter.format(date)}>
                <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
                <time dateTime={dateKey || undefined} className="shrink-0 rounded-full border border-border/70 bg-background/90 px-3 py-1 text-[11px] font-medium tabular-nums text-muted-foreground shadow-sm">
                  {dateLabelFormatter.format(date)} <span className="ml-1 text-[10px] opacity-70">IST</span>
                </time>
                <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
              </div>
            ) : null}
            <OutreachMessageBubble
              message={message}
              channel={channel}
              conversation={conversation}
              onEditDraft={onEditDraft}
              onSendDraft={onSendDraft}
              onDiscardDraft={onDiscardDraft}
            />
          </Fragment>
        );
      })}
    </div>
  );
}
