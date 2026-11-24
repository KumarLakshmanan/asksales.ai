"use client";

import { Button } from "@/components/ui/button";
import { RefreshCw, Wifi, Gauge, Settings } from "lucide-react";

interface OfficialApiStatusProps {
  officialApiConnected: boolean;
  dailyLimit: number;
  sentToday: number;
  onRefreshStatus: () => void;
  onSettingsClick: () => void;
}

export function OfficialApiStatus({ officialApiConnected, dailyLimit, sentToday, onRefreshStatus, onSettingsClick }: OfficialApiStatusProps) {
  return (
    <div className="border-b border-border bg-card/50 px-4 py-2 flex items-center justify-between flex-wrap gap-2" role="status" aria-label="Connection status">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <Wifi className="w-3.5 h-3.5 text-emerald-500" />
          <span className="text-xs text-emerald-600 dark:text-emerald-400">API {officialApiConnected ? "Connected" : "Not Connected"}</span>
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-1.5">
          <Gauge className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-xs text-muted-foreground">{sentToday}/{dailyLimit} today</span>
          {sentToday >= dailyLimit && <span className="text-xs text-red-500 font-medium ml-1" role="alert">Limit reached</span>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onRefreshStatus} aria-label="Refresh connection status"><RefreshCw className="w-3 h-3 mr-1" /> Refresh</Button>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onSettingsClick} aria-label="Open integration settings"><Settings className="w-3 h-3 mr-1" /> Settings</Button>
      </div>
    </div>
  );
}
