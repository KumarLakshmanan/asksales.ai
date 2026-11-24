import type { CSSProperties, ReactNode } from "react";
import Image from "next/image";
import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationSurface } from "./types";

interface ConversationMessageFrameProps {
  role: "user" | "assistant" | "system";
  surface?: ConversationSurface;
  name?: string;
  timestamp?: string;
  avatar?: string;
  initials?: string;
  accentColor?: string;
  statusLabel?: string;
  showAvatar?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  contentClassName?: string;
  ariaLabel?: string;
  testId?: string;
}

export function ConversationMessageFrame({
  role,
  surface = "campaign",
  name,
  timestamp,
  avatar,
  initials,
  accentColor = "hsl(var(--primary))",
  statusLabel,
  showAvatar = true,
  children,
  footer,
  className,
  contentClassName,
  ariaLabel,
  testId,
}: ConversationMessageFrameProps) {
  const isUser = role === "user";
  const isSystem = role === "system";
  const avatarLabel = initials || name?.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  if (isSystem) {
    return (
      <div
        role="status"
        aria-label={ariaLabel}
        data-testid={testId}
        className={cn("my-4 flex max-w-xl items-center gap-3", className)}
      >
        <span className="h-px w-8 bg-border" aria-hidden="true" />
        <div className="font-mono text-[11px] text-muted-foreground">
          {children}
        </div>
      </div>
    );
  }

  return (
    <article
      role="listitem"
      aria-label={ariaLabel}
      data-testid={testId}
      data-conversation-surface={surface}
      className={cn("group/message flex min-w-0 max-w-full gap-2.5", isUser ? "justify-end" : "justify-start", className)}
    >
      {!isUser && showAvatar ? (
        <div className="relative mt-0.5 h-7 w-7 shrink-0">
          <div
            className="relative flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/50"
            style={{ "--conversation-accent": accentColor } as CSSProperties}
          >
            {avatar ? (
              <Image src={avatar} alt={name || "Assistant"} width={28} height={28} className="h-full w-full object-contain p-0.5" />
            ) : avatarLabel ? (
              <span className="text-[11px] font-semibold" style={{ color: accentColor }}>{avatarLabel}</span>
            ) : (
              <Bot className="h-4 w-4" style={{ color: accentColor }} aria-hidden="true" />
            )}
          </div>
          {statusLabel ? (
            <span
              className="absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-full border-2 border-background bg-success"
              title={statusLabel}
              aria-label={statusLabel}
            />
          ) : null}
        </div>
      ) : null}

      <div className={cn("min-w-0", isUser ? "max-w-[88%] sm:max-w-[72%]" : "max-w-[min(100%,48rem)] flex-1")}>
        {!isUser && (name || timestamp) ? (
          <header className="mb-1.5 flex min-w-0 items-center gap-2 px-0.5">
            {name ? <span className="truncate text-xs font-semibold text-foreground">{name}</span> : null}
            {name && timestamp ? <span className="h-1 w-1 shrink-0 rounded-full bg-border" aria-hidden="true" /> : null}
            {timestamp ? <time className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{timestamp}</time> : null}
          </header>
        ) : null}

        <div
          className={cn(
            "min-w-0 text-sm leading-relaxed",
            isUser
              ? "rounded-[14px] rounded-tr-[4px] border border-primary bg-primary px-4 py-3 text-primary-foreground shadow-sm"
              : "border-0 bg-transparent px-0 py-0 text-foreground",
            contentClassName,
          )}
        >
          {isUser ? <User className="sr-only" aria-hidden="true" /> : null}
          {children}
        </div>
        {footer ? <div className={cn("mt-2", isUser ? "flex justify-end" : "pl-0.5")}>{footer}</div> : null}
      </div>
    </article>
  );
}
