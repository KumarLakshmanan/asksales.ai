"use client";

import { cn } from "@/lib/utils";
import { CheckCircle2, XCircle } from "lucide-react";
import { motion } from "framer-motion";

interface StatusDotProps {
  active: boolean;
  color?: string;
}

function StatusDot({ active, color = "bg-emerald-500" }: StatusDotProps) {
  return (
    <div
      className={cn(
        "w-2 h-2 rounded-full transition-colors",
        active ? color : "bg-muted-foreground/30"
      )}
    />
  );
}

interface StatusItemProps {
  icon: React.ReactNode;
  label: string;
  connected: boolean;
  username?: string | null;
  connectedLabel?: string;
  disconnectedLabel?: string;
}

function StatusItem({
  icon,
  label,
  connected,
  username,
  connectedLabel = "Connected",
  disconnectedLabel = "Not linked",
}: StatusItemProps) {
  return (
    <div className="flex items-center gap-2.5">
      {icon}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
        {connected ? (
          <span className="text-sm font-semibold text-foreground">
            {username ? `@${username}` : connectedLabel}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground italic">
            {disconnectedLabel}
          </span>
        )}
      </div>
    </div>
  );
}

interface SimpleStatusHeaderProps {
  connected: boolean;
  label?: string;
  detail?: string | null;
  connectedLabel?: string;
  disconnectedLabel?: string;
}

export function SimpleStatusHeader({
  connected,
  label,
  detail,
  connectedLabel = "Connected",
  disconnectedLabel = "Not Connected",
}: SimpleStatusHeaderProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex min-h-10 items-center gap-x-3 rounded-xl border border-border bg-card px-4 py-2"
    >
      {connected ? (
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
      ) : (
        <XCircle className="w-3.5 h-3.5 text-muted-foreground/40" />
      )}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">
          {label || (connected ? connectedLabel : disconnectedLabel)}
        </span>
        {connected && detail && (
          <span className="text-sm font-semibold text-foreground">
            {detail}
          </span>
        )}
      </div>
    </motion.div>
  );
}

interface EmailStatusHeaderProps {
  gmailConnected: boolean;
  gmailNeedsReconnect?: boolean;
  resendConnected: boolean;
  statusAvailable?: boolean;
}

export function EmailStatusHeader({
  gmailConnected,
  gmailNeedsReconnect = false,
  resendConnected,
  statusAvailable = true,
}: EmailStatusHeaderProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex min-h-10 flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-card px-4 py-2"
    >
      <StatusItem
        icon={<StatusDot active={gmailConnected} color="bg-emerald-500" />}
        label="Gmail"
        connected={statusAvailable && gmailConnected}
        disconnectedLabel={statusAvailable ? gmailNeedsReconnect ? "Reconnect needed" : "Not linked" : "Status unavailable"}
      />

      <div className="w-px h-3 bg-border/40 hidden sm:block" />

      <StatusItem
        icon={<StatusDot active={resendConnected} color="bg-blue-500" />}
        label="Resend"
        connected={statusAvailable && resendConnected}
        disconnectedLabel={statusAvailable ? "Not linked" : "Status unavailable"}
      />
    </motion.div>
  );
}
