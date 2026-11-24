"use client";
/**
 * EmailSenderPicker
 * Dropdown to select which email sender to use when composing outreach emails.
 * Shows the user's configured senders (Resend domains + Gmail accounts).
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, Mail, Globe, Star, Check } from "lucide-react";
import api from "@/lib/api";

export interface EmailSender {
  id: number;
  type: "resend" | "gmail";
  label: string;
  email: string;
  displayName?: string | null;
  isDefault: boolean;
  isVerified: boolean;
  connectionActive?: boolean;
}

interface EmailSenderPickerProps {
  value?: number | null;
  onChange: (senderId: number, sender: EmailSender) => void;
  /** Called when senders are loaded with the default sender */
  onLoad?: (sender: EmailSender | null) => void;
  /** When set, only show senders matching this provider type (e.g. 'resend' or 'gmail') */
  conversationProvider?: string | null;
  /** An existing thread's verified sender is fixed; avoid syncing or selecting another account. */
  lockedSender?: Pick<EmailSender, 'email' | 'type'>;
  compact?: boolean;
}

export function EmailSenderPicker({ value, onChange, onLoad, conversationProvider, lockedSender, compact }: EmailSenderPickerProps) {
  const [senders, setSenders] = useState<EmailSender[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasReportedDefault, setHasReportedDefault] = useState(false);

  useEffect(() => {
    if (lockedSender) return;
    const load = async () => {
      try {
        // Sync first to auto-detect senders, then list
        await api.post("/api/email-senders/sync");
        const res = await api.get<{ senders: EmailSender[] }>("/api/email-senders?availableOnly=true");
        setSenders((res.senders || []).filter(sender => sender.isVerified && sender.connectionActive === true));
      } catch {
        setSenders([]);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [lockedSender]);

  // Report default sender once loaded
  useEffect(() => {
    const visibleSenders = conversationProvider
      ? senders.filter((s) => s.type === conversationProvider)
      : senders;

    if (!loading && !visibleSenders.length && !hasReportedDefault) {
      onLoad?.(null);
      setHasReportedDefault(true);
    } else if (!loading && visibleSenders.length > 0 && !hasReportedDefault && onLoad) {
      const defaultSender = visibleSenders.find((s) => s.isDefault) || visibleSenders[0];
      onLoad(defaultSender);
      if (!visibleSenders.some(sender => sender.id === value) && defaultSender) {
        onChange(defaultSender.id, defaultSender);
      }
      setHasReportedDefault(true);
    } else if (!loading && visibleSenders.length > 0 && !hasReportedDefault && !visibleSenders.some(sender => sender.id === value)) {
      const defaultSender = visibleSenders.find((s) => s.isDefault) || visibleSenders[0];
      onChange(defaultSender.id, defaultSender);
      setHasReportedDefault(true);
    }
  }, [loading, senders, hasReportedDefault, onLoad, onChange, value, conversationProvider]);

  // Filter senders by conversation provider when set
  const filteredSenders = conversationProvider
    ? senders.filter((s) => s.type === conversationProvider)
    : senders;

  const selectedSender = filteredSenders.find((s) => s.id === value) || filteredSenders.find((s) => s.isDefault) || filteredSenders[0];

  if (lockedSender) return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {lockedSender.type === 'gmail' ? <Mail className="h-3.5 w-3.5 shrink-0" /> : <Globe className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">From: <span className="font-medium text-foreground">{lockedSender.email}</span></span>
    </div>
  );
  if (loading || filteredSenders.length === 0) return null;

  // If only one sender, show it as a static badge
  if (filteredSenders.length === 1) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {filteredSenders[0].type === "gmail" ? <Mail className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
        <span>From: {filteredSenders[0].email}</span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={`gap-1.5 text-xs h-7 ${compact ? "px-2" : ""}`}>
          {selectedSender?.type === "gmail" ? <Mail className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
          <span className="max-w-[200px] truncate">
            {selectedSender?.email || "Select sender"}
          </span>
          <ChevronDown className="w-3 h-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-xs">Send from</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {filteredSenders.map((sender) => (
          <DropdownMenuItem
            key={sender.id}
            onClick={() => onChange(sender.id, sender)}
            className="flex items-center gap-2 cursor-pointer"
          >
            {sender.type === "gmail" ? <Mail className="w-4 h-4 text-red-500" /> : <Globe className="w-4 h-4 text-blue-500" />}
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">{sender.email}</div>
              <div className="text-xs text-muted-foreground truncate">{sender.label}</div>
            </div>
            <div className="flex items-center gap-1">
              {sender.isDefault && (
                <Badge variant="secondary" className="text-[10px] px-1 py-0">
                  <Star className="w-2.5 h-2.5 mr-0.5" />
                  Default
                </Badge>
              )}
              {selectedSender?.id === sender.id && <Check className="w-4 h-4 text-primary" />}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
