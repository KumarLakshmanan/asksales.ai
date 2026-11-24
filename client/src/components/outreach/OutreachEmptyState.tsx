/**
 * OutreachEmptyState - Empty state when no conversation is selected
 * Supports dark mode and channel-specific theming
 */

import type { OutreachChannel } from "./types";
import { getChannelTheme, type ChannelTheme } from "./outreach-theme";
import { Lock } from "lucide-react";

interface OutreachEmptyStateProps {
  channel: OutreachChannel;
  title?: string;
  description?: string;
  /** Override theme (optional) */
  theme?: ChannelTheme;
  /** Custom content to render below the text */
  children?: React.ReactNode;
}

export function OutreachEmptyState({
  channel,
  title,
  description,
  theme: themeOverride,
  children,
}: OutreachEmptyStateProps) {
  const theme = themeOverride || getChannelTheme(channel);
  const Icon = theme.icon;

  const getDefaultTitle = () => {
    switch (channel) {
      case "instagram":
        return "No conversation selected";
      case "email":
        return "No conversation selected";
      case "sms":
        return "Select a conversation";
      case "whatsapp":
        return "WhatsApp Business";
      default:
        return "No conversation selected";
    }
  };

  const getDefaultDescription = () => {
    switch (channel) {
      case "whatsapp":
        return "Send and receive messages, and more. All from your browser.";
      case "sms":
        return "Choose a conversation from the list to view messages";
      default:
        return "Select a conversation from the list to view messages";
    }
  };

  // WhatsApp has a unique large empty state
  if (channel === "whatsapp") {
    return (
      <div className={`flex-1 flex flex-col items-center justify-center ${theme.topBarBg}`} role="status">
        <div className="text-center max-w-md">
          <div className="w-32 h-32 mx-auto mb-6 relative">
            <div className={`absolute inset-0 ${theme.emptyIconBg} rounded-full`}></div>
            <Icon className="w-16 h-16 text-green-600 dark:text-green-400 absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2" aria-hidden="true" />
          </div>
          <h3 className="text-2xl font-light text-foreground mb-2">
            {title || getDefaultTitle()}
          </h3>
          <p className="text-muted-foreground mb-4">
            {description || getDefaultDescription()}
          </p>
          <div className="text-xs text-muted-foreground flex items-center justify-center gap-1">
            <Lock className="w-3 h-3" aria-hidden="true" />
            <span>End-to-end encrypted</span>
          </div>
          {children}
        </div>
      </div>
    );
  }

  // Instagram has a gradient circle icon
  if (channel === "instagram" && theme.emptyIconBg) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground" role="status">
        <div className={`w-20 h-20 rounded-full ${theme.emptyIconBg} flex items-center justify-center mb-4`}>
          <Icon className="w-10 h-10 text-white" />
        </div>
        <h3 className="text-lg font-medium mb-2">{title || getDefaultTitle()}</h3>
        <p className="text-sm">{description || getDefaultDescription()}</p>
        {children}
      </div>
    );
  }

  // Standard empty state (email, sms)
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground" role="status">
      <Icon className="w-16 h-16 mb-4 text-muted-foreground/40" />
      <h3 className="text-lg font-medium mb-2">{title || getDefaultTitle()}</h3>
      <p className="text-sm">{description || getDefaultDescription()}</p>
      {children}
    </div>
  );
}
