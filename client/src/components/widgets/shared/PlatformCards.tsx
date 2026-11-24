"use client";

/**
 * PlatformCards
 * Visual platform selector cards for LinkedIn, Twitter, Facebook, Instagram, etc.
 */

import React from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface PlatformCardsProps {
  value: string;
  onChange: (value: string) => void;
  platforms: Array<{
    value: string;
    label: string;
    icon?: React.ReactNode;
    color?: string;
  }>;
  label?: string;
}

export function PlatformCards({ value, onChange, platforms, label = 'Platform' }: PlatformCardsProps) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {platforms.map((platform) => (
          <button
            key={platform.value}
            type="button"
            onClick={() => onChange(platform.value)}
            className={cn(
              "flex items-center gap-2 rounded-[9px] border px-3 py-2 text-left transition-colors",
              value === platform.value
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            )}
            aria-pressed={value === platform.value}
          >
            {platform.icon ? (
              <div className="h-5 w-5 text-current">
                {platform.icon}
              </div>
            ) : (
              <span className="flex h-5 w-5 items-center justify-center rounded border border-current/20 font-mono text-[10px] font-semibold">
                {platform.label.charAt(0)}
              </span>
            )}
            <span className="text-xs font-medium">{platform.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Pre-defined platform sets
export const PLATFORM_SETS = {
  social: [
    { value: 'all', label: 'All', color: '#8b5cf6' },
    { value: 'linkedin', label: 'LinkedIn', color: '#0a66c2' },
    { value: 'twitter', label: 'Twitter', color: '#1da1f2' },
    { value: 'facebook', label: 'Facebook', color: '#1877f2' },
    { value: 'instagram', label: 'Instagram', color: '#e4405f' },
  ],
  socialChat: [
    { value: 'linkedin', label: 'LinkedIn', color: '#0a66c2' },
    { value: 'instagram', label: 'Instagram', color: '#e4405f' },
    { value: 'twitter', label: 'Twitter', color: '#1da1f2' },
    { value: 'messenger', label: 'Messenger', color: '#00b2ff' },
  ],
  ad: [
    { value: 'meta', label: 'Meta', color: '#1877f2' },
    { value: 'google', label: 'Google', color: '#4285f4' },
    { value: 'linkedin', label: 'LinkedIn', color: '#0a66c2' },
  ],
};
