/**
 * OutreachTopBar - Top action bar for outreach conversation view
 * Contains label, refresh button, and new button with channel-specific theming
 */

import { Button } from "@/components/ui/button";
import { RefreshCw, Plus } from "lucide-react";
import type { OutreachChannel } from "./types";
import { getChannelTheme, type ChannelTheme } from "./outreach-theme";

interface OutreachTopBarProps {
  channel: OutreachChannel;
  onSync: () => void;
  onNew: () => void;
  syncing?: boolean;
  /** Override theme (optional) */
  theme?: ChannelTheme;
  /** Custom label text */
  label?: string;
  /** Additional buttons/content before the default buttons */
  extraActions?: React.ReactNode;
}

export function OutreachTopBar({
  channel,
  onSync,
  onNew,
  syncing = false,
  theme: themeOverride,
  label = "Conversations",
  extraActions,
}: OutreachTopBarProps) {
  const theme = themeOverride || getChannelTheme(channel);

  return (
    <div className={`sticky top-0 z-10 flex items-center justify-between border-b border-border/70 px-3 py-2 ${theme.topBarBg} backdrop-blur-xl sm:px-5`}>
      <div className="flex items-center gap-2">
        <div className={`h-1.5 w-1.5 rounded-full ${theme.headerIconBg}`} />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      </div>
      
      <div className="flex items-center gap-3">
        {extraActions}
        <Button
          variant="outline"
          size="sm"
          onClick={onSync}
          loading={syncing}
          className="h-8 w-8 rounded-lg border-border/70 bg-background p-0"
          aria-label="Sync conversations"
        >
          <RefreshCw className="w-3.5 h-3.5 opacity-60" />
        </Button>
        <Button
          size="sm"
          className="h-8 rounded-lg px-3 text-xs font-medium"
          onClick={onNew}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New Campaign
        </Button>
      </div>
    </div>
  );
}
