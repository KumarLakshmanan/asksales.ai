/**
 * OutreachSidebar - Shared conversation list sidebar for outreach pages
 * Supports dark mode, channel-specific theming, and delete dropdown
 */

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SearchInput } from "@/components/ui/search-input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Building2,
  MoreVertical,
  Trash2,
  AtSign,
  Phone,
  AlertCircle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";
import type { OutreachConversation, OutreachChannel } from "./types";
import { getChannelTheme, type ChannelTheme } from "./outreach-theme";
import { parseMessageContent } from "./useOutreachPage";
import { ConversationLoadMore, type ConversationLoadMoreProps } from './ConversationLoadMore';
import { OutreachConversationFilters } from './OutreachConversationFilters';
import type { ConversationFilters } from './conversation-filters';

interface OutreachSidebarProps {
  channel: OutreachChannel;
  conversations: OutreachConversation[];
  selectedConversation: OutreachConversation | null;
  onSelectConversation: (conversation: OutreachConversation) => void;
  onDelete?: (conversation: OutreachConversation, e: React.MouseEvent) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  unreadCount?: number;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  conversationFilters?: ConversationFilters;
  onConversationFiltersChange?: (filters: ConversationFilters) => void;
  /** Override theme (optional) */
  theme?: ChannelTheme;
  /** Additional content in sidebar header (e.g., Gmail account info) */
  headerExtra?: React.ReactNode;
  /** Custom sidebar width class */
  widthClass?: string;
  /** Use skeleton loading instead of spinner */
  skeletonLoading?: boolean;
  pagination?: ConversationLoadMoreProps;
}

export function OutreachSidebar({
  channel,
  conversations,
  selectedConversation,
  onSelectConversation,
  onDelete,
  loading = false,
  error,
  onRetry,
  unreadCount = 0,
  searchQuery,
  onSearchChange,
  conversationFilters,
  onConversationFiltersChange,
  theme: themeOverride,
  headerExtra,
  widthClass = "w-80",
  skeletonLoading = false,
  pagination,
}: OutreachSidebarProps) {
  const theme = themeOverride || getChannelTheme(channel);
  const Icon = theme.icon;

  // Convert system-generated placeholder names to friendly display names
  const getDisplayName = (name: string | null | undefined, conv?: OutreachConversation): string => {
    if (!name) return "";
    // Check for system-generated placeholder names
    if (/^IG User \d+$/.test(name)) {
      return conv?.leadInstagram || "Instagram User";
    }
    if (/^FB User \d+$/.test(name)) {
      return conv?.leadInstagram || "Facebook User";
    }
    if (/^Instagram User \d+$/.test(name)) {
      return conv?.leadInstagram || "Instagram User";
    }
    if (/^Facebook User \d+$/.test(name)) {
      return conv?.leadInstagram || "Facebook User";
    }
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

  // Determine what subtitle info to show based on channel
  const getSubtitleInfo = (conv: OutreachConversation) => {
    switch (channel) {
      case "instagram":
        if (!conv.leadInstagram) return null;
        // If leadInstagram is a numeric ID, show it as "IG User" with partial ID
        if (/^\d+$/.test(conv.leadInstagram)) {
          return (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <AtSign className="w-3 h-3" />
              IG User ...{conv.leadInstagram.slice(-4)}
            </p>
          );
        }
        return (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <AtSign className="w-3 h-3" />
            {conv.leadInstagram}
          </p>
        );
      case "sms":
      case "whatsapp":
        return conv.leadPhone ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Phone className="w-3 h-3" />
            {conv.leadPhone}
          </p>
        ) : null;
      default:
        return conv.leadCompany ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Building2 className="w-3 h-3" />
            {conv.leadCompany}
          </p>
        ) : null;
    }
  };

  return (
    <div className={`${widthClass} border-r flex flex-col bg-card h-full overflow-hidden shrink-0`}>
      {/* Header */}
      <div className="p-4 border-b space-y-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className={`w-9 h-9 rounded-lg ${theme.iconBgLight} flex items-center justify-center shrink-0`}>
              <Icon className={`w-4 h-4 ${theme.iconColor}`} />
            </div>
            <div>
              <h2 className="text-sm font-semibold leading-tight">{theme.channelName}</h2>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-xs text-muted-foreground">{conversations.length} conversations</span>
                {unreadCount > 0 && (
                  <Badge variant="destructive" className="h-4 px-1.5 text-[9px] rounded-md">
                    {unreadCount}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </div>
        {headerExtra}
        <SearchInput
          aria-label="Search conversations"
          placeholder="Search conversations..."
          value={searchQuery}
          onValueChange={onSearchChange}
          size="sm"
          className="text-sm rounded-lg border-border/60"
        />
        {conversationFilters && onConversationFiltersChange && (
          <OutreachConversationFilters filters={conversationFilters} onChange={onConversationFiltersChange} />
        )}
      </div>

      {/* Conversation List */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <ScrollArea className="h-full flex-1 min-h-0" viewportClassName="[&>div]:!block">
        {loading ? (
          skeletonLoading ? (
            <div className="p-4 space-y-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3 p-3 rounded-2xl bg-white/5 border border-transparent">
                  <Skeleton className="h-12 w-12 rounded-2xl" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center p-12">
              <Spinner size="xl" label="Loading conversations" className={`${theme.loaderColor} opacity-50`} />
            </div>
          )
        ) : error ? (
            <div className="mx-3 mt-3 flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-10 text-center text-destructive" role="alert">
              <AlertCircle className="h-5 w-5" />
              <div>
                <p className="text-sm font-medium">Conversations could not be loaded</p>
                <p className="mt-1 text-xs opacity-80">{error}</p>
              </div>
              {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>}
            </div>
        ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 mx-3 mt-3 border-2 border-dashed border-border/40 rounded-xl">
              <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mb-3">
                <Icon className="w-5 h-5 text-muted-foreground/40" />
              </div>
              <p className="text-sm font-medium">No conversations found</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[200px] mx-auto text-center">
                {conversationFilters && (conversationFilters.status !== 'all' || conversationFilters.date !== 'all')
                  ? 'Try another status or date range.'
                  : 'Start an outreach campaign to see conversations here.'}
              </p>
            </div>
        ) : (
          <div className="p-3 space-y-1 pb-4">
            {conversations.map((conversation) => {
              const isSelected = selectedConversation?.id === conversation.id;
              return (
                <div
                  key={conversation.id}
                  className={`flex w-full items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-left transition-all group ${
                    isSelected
                      ? "border-primary/30 bg-primary/5 shadow-sm ring-1 ring-primary/10"
                      : "border-border/40 hover:border-border hover:shadow-sm"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectConversation(conversation)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    aria-label={`Open conversation with ${getDisplayName(conversation.leadName, conversation) || conversation.leadPhone || "Unknown Lead"}`}
                  >
                    <div className="relative shrink-0">
                      <div className={`w-7 h-7 rounded-md ${theme.iconBgLight} flex items-center justify-center`}>
                        <span className={`text-[11px] font-semibold ${theme.iconColor}`}>
                          {(getDisplayName(conversation.leadName, conversation) || conversation.leadPhone || "?").charAt(0).toUpperCase()}
                        </span>
                      </div>
                      {conversation.unreadCount > 0 && !isSelected && (
                        <span className="absolute -top-1 -right-1 w-4 h-4 bg-destructive text-destructive-foreground text-[9px] font-bold rounded-full border border-background flex items-center justify-center" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <div className="flex items-center justify-between gap-1.5 min-w-0 w-full">
                        <p className="text-sm font-medium truncate flex-1 min-w-0">
                          {getDisplayName(conversation.leadName, conversation) || conversation.leadPhone || "Unknown Lead"}
                        </p>
                        {['whatsapp', 'instagram', 'facebook'].includes(channel) && ['closed', 'resolved', 'completed'].includes(conversation.status) && (
                          <span className="rounded border border-border px-1 text-[9px] text-muted-foreground">Completed</span>
                        )}
                        {conversation.lastMessageAt && (
                          <span className="text-[10px] text-muted-foreground shrink-0 whitespace-nowrap">
                            {formatDistanceToNow(new Date(conversation.lastMessageAt), {
                              addSuffix: false,
                            }).replace("about ", "").replace(" minutes", "m").replace(" hours", "h").replace(" days", "d")}
                          </span>
                        )}
                      </div>

                      {["facebook", "instagram"].includes(channel) && <p className="truncate text-[11px] text-muted-foreground">via {conversation.providerAccountName || conversation.providerAccountId || "Account not recorded"}</p>}
                      <div className="truncate">
                        {getSubtitleInfo(conversation)}
                      </div>

                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {parseMessageContent(conversation.lastMessagePreview) || "No messages yet"}
                      </p>
                    </div>

                  </button>
                    {onDelete && isSelected && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreVertical className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive gap-2 text-xs"
                            onClick={(e) => onDelete(conversation, e)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                </div>
              );
            })}
          </div>
        )}
        {!loading && !error && pagination && <ConversationLoadMore {...pagination} />}
      </ScrollArea>
      </div>
    </div>
  );
}
