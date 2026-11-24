/**
 * OutreachConversationHeader - Shared header for conversation view
 * Supports dark mode and channel-specific theming
 */

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ArrowLeft, MoreVertical, AtSign } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConversationHeader } from "@/components/conversation/ConversationHeader";
import type { OutreachConversation, OutreachChannel } from "./types";
import { getChannelTheme, type ChannelTheme } from "./outreach-theme";
import { getInitials } from "./useOutreachPage";

interface OutreachConversationHeaderProps {
  channel: OutreachChannel;
  conversation: OutreachConversation;
  onBack?: () => void;
  onMoreOptions?: () => void;
  /** Override theme (optional) */
  theme?: ChannelTheme;
  /** Extra actions (buttons) to show in the header */
  extraActions?: React.ReactNode;
  /** Custom status badge style */
  statusBadgeClass?: string;
}

export function OutreachConversationHeader({
  channel,
  conversation,
  onBack,
  onMoreOptions,
  theme: themeOverride,
  extraActions,
  statusBadgeClass,
}: OutreachConversationHeaderProps) {
  const theme = themeOverride || getChannelTheme(channel);
  const roundAvatar = channel === "whatsapp" || channel === "facebook" || channel === "instagram";

  // Convert system-generated placeholder names to friendly display names
  const getDisplayName = (name: string | null | undefined): string => {
    if (!name) return "";
    if (/^IG User \d+$/.test(name)) return conversation.leadInstagram || "Instagram User";
    if (/^FB User \d+$/.test(name)) return conversation.leadInstagram || "Facebook User";
    if (/^Instagram User \d+$/.test(name)) return conversation.leadInstagram || "Instagram User";
    if (/^Facebook User \d+$/.test(name)) return conversation.leadInstagram || "Facebook User";
    // Handle numeric-only names (Instagram IDs) - show as IG user with partial ID
    if (/^\d+$/.test(name) && name.length > 6) {
      return `IG User ...${name.slice(-4)}`;
    }
    // Handle names that start with @ but are actually Instagram IDs
    if (/^@\d+$/.test(name)) {
      return `IG User ...${name.slice(-4)}`;
    }
    return name;
  };
  const displayName = getDisplayName(conversation.leadName);

  // Determine subtitle based on channel
  const getSubtitle = () => {
    switch (channel) {
      case "instagram":
        if (!conversation.leadInstagram) return null;
        // If leadInstagram is a numeric ID, show it as "IG User" with partial ID
        if (/^\d+$/.test(conversation.leadInstagram)) {
          return (
            <span className="flex min-w-0 items-center gap-1 truncate text-sm text-muted-foreground">
              <AtSign className="w-3 h-3 shrink-0" />
              <span className="truncate">IG User ...{conversation.leadInstagram.slice(-4)}</span>
            </span>
          );
        }
        return (
          <span className="flex min-w-0 items-center gap-1 truncate text-sm text-muted-foreground">
            <AtSign className="w-3 h-3 shrink-0" />
            <span className="truncate">{conversation.leadInstagram}</span>
          </span>
        );
      case "sms":
      case "whatsapp":
        return (
          <span className="truncate text-sm text-muted-foreground">
            {conversation.leadPhone}
            {conversation.leadCompany && ` · ${conversation.leadCompany}`}
          </span>
        );
      default:
        return conversation.leadEmail ? (
          <span className="truncate text-sm text-muted-foreground">{conversation.leadEmail}</span>
        ) : null;
    }
  };

  const subtitle = getSubtitle();

  return (
    <ConversationHeader
      title={displayName || conversation.leadPhone || "Unknown lead"}
      eyebrow={["facebook", "instagram"].includes(channel) ? `${theme.channelName} · ${conversation.providerAccountName || conversation.providerAccountId || "Account not recorded"}` : `${theme.channelName} conversation`}
      subtitle={<span className="inline-flex min-w-0 items-center gap-2">{subtitle}{conversation.leadCompany && channel !== "sms" && channel !== "whatsapp" ? <><span className="h-1 w-1 shrink-0 rounded-full bg-border" /> <span className="truncate">{conversation.leadCompany}</span></> : null}</span>}
      className={cn("sticky top-0", theme.headerBg)}
      leading={<div className="flex items-center gap-2">
        {onBack ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-lg lg:hidden"
            onClick={onBack}
            aria-label="Back to conversations"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        ) : null}
        <div className="relative shrink-0">
          <Avatar className={cn("h-9 w-9 border border-border shadow-sm", roundAvatar ? "rounded-full" : "rounded-xl")}>
            {conversation.leadAvatar ? <AvatarImage src={conversation.leadAvatar} alt="" /> : null}
            <AvatarFallback className={cn(roundAvatar ? "rounded-full" : "rounded-xl", "text-xs font-semibold text-white", theme.avatarGradient)}>
              {getInitials(displayName || conversation.leadName)}
            </AvatarFallback>
          </Avatar>
        </div>
      </div>}
      status={<Badge variant="secondary" className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium capitalize", conversation.status === "replied" && "bg-success/10 text-success", statusBadgeClass)}>{conversation.status}</Badge>}
      actions={extraActions || onMoreOptions ? <>
        {extraActions}
        {onMoreOptions ? <Button
          variant="ghost"
          size="icon"
          onClick={onMoreOptions}
          className="h-9 w-9 rounded-lg text-muted-foreground"
          aria-label="More options"
        >
          <MoreVertical className="h-4 w-4" />
        </Button> : null}
      </> : undefined}
    />
  );
}
