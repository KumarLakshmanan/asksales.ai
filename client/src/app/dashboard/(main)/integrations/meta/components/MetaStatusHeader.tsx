"use client";

import { cn } from "@/lib/utils";
import { Facebook } from "lucide-react";
import { motion } from "framer-motion";

interface MetaStatusHeaderProps {
  connected: boolean;
  accountName: string | null;
}

export function MetaStatusHeader({
  connected,
  accountName
}: MetaStatusHeaderProps) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-x-6 px-4 h-10 rounded-xl border border-border/40 bg-muted/20"
    >
      {/* Official API Status */}
      <div className="flex items-center gap-2.5">
        <div className={cn(
          "w-2 h-2 rounded-full",
          connected ? "bg-blue-500 animate-pulse" : "bg-muted-foreground/30"
        )} />
        <div className="flex items-center gap-2">
          <Facebook className="w-3.5 h-3.5 text-muted-foreground/50" />
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/80">Meta Ads API</span>
          {connected ? (
            <span className="text-xs font-bold text-foreground truncate max-w-[120px]">{accountName || "Active"}</span>
          ) : (
            <span className="text-xs font-medium text-muted-foreground/40 italic">Offline</span>
          )}
        </div>
      </div>

    </motion.div>

  );
}
