"use client";

/**
 * ToneSelector
 * Reusable segmented button group for selecting tone/mood.
 */

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface ToneSelectorProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  label?: string;
}

export function ToneSelector({ value, onChange, options, label = 'Tone' }: ToneSelectorProps) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-[8px] border px-3 py-1.5 text-xs font-medium transition-colors",
              value === option.value
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            )}
            aria-pressed={value === option.value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Pre-defined tone option sets
export const TONE_OPTIONS = {
  social: [
    { value: 'professional', label: 'Professional' },
    { value: 'casual', label: 'Casual' },
    { value: 'funny', label: 'Funny' },
    { value: 'inspirational', label: 'Inspirational' },
    { value: 'informative', label: 'Informative' },
    { value: 'provocative', label: 'Provocative' },
  ],
  email: [
    { value: 'professional', label: 'Professional' },
    { value: 'friendly', label: 'Friendly' },
    { value: 'urgent', label: 'Urgent' },
    { value: 'persuasive', label: 'Persuasive' },
    { value: 'formal', label: 'Formal' },
    { value: 'conversational', label: 'Conversational' },
  ],
  sms: [
    { value: 'professional', label: 'Professional' },
    { value: 'casual', label: 'Casual' },
    { value: 'urgent', label: 'Urgent' },
    { value: 'friendly', label: 'Friendly' },
    { value: 'promotional', label: 'Promotional' },
  ],
  ad: [
    { value: 'professional', label: 'Professional' },
    { value: 'casual', label: 'Casual' },
    { value: 'urgent', label: 'Urgent' },
    { value: 'inspiring', label: 'Inspiring' },
    { value: 'informative', label: 'Informative' },
    { value: 'bold', label: 'Bold' },
  ],
  blog: [
    { value: 'professional', label: 'Professional' },
    { value: 'casual', label: 'Casual' },
    { value: 'informative', label: 'Informative' },
    { value: 'inspirational', label: 'Inspirational' },
    { value: 'conversational', label: 'Conversational' },
    { value: 'authoritative', label: 'Authoritative' },
  ],
  chat: [
    { value: 'professional', label: 'Professional' },
    { value: 'friendly', label: 'Friendly' },
    { value: 'casual', label: 'Casual' },
    { value: 'persuasive', label: 'Persuasive' },
    { value: 'witty', label: 'Witty' },
    { value: 'empathetic', label: 'Empathetic' },
  ],
};
