"use client";

/**
 * LeadGenConfigWidget
 * Interactive widget for configuring lead generation parameters.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { WidgetProps } from "./types";

const PLATFORM_OPTIONS = [
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'google_maps', label: 'Google Maps' },
  { value: 'justdial', label: 'JustDial' },
  { value: 'twitter', label: 'Twitter' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' },
];

export function LeadGenConfigWidget({ widget, onFormChange }: WidgetProps) {
  const requirementsRef = useRef<HTMLTextAreaElement>(null);
  const [form, setForm] = useState({
    platforms: (widget.formValues.platforms as string[]) || [],
    selected_workflows: (widget.formValues.selected_workflows as string[]) || [],
    user_requirements: (widget.formValues.user_requirements as string) || '',
    icp_id: (widget.formValues.icp_id as number) || undefined,
  });

  useEffect(() => {
    onFormChange(form);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  const resizeRequirements = useCallback(() => {
    const textarea = requirementsRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(240, Math.max(96, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 240 ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeRequirements();
  }, [form.user_requirements, resizeRequirements]);

  const togglePlatform = (platform: string) => {
    setForm(f => ({
      ...f,
      platforms: f.platforms.includes(platform)
        ? f.platforms.filter(p => p !== platform)
        : [...f.platforms, platform],
      // A strategy approved for a removed provider must not survive invisibly
      // into the submitted payload. Strategies for providers that remain
      // selected are preserved exactly as the agent presented them.
      selected_workflows: f.platforms.includes(platform)
        ? f.selected_workflows.filter(workflow => !workflow.startsWith(`${platform}_`) && workflow !== platform)
        : f.selected_workflows,
    }));
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs font-medium">Target Platforms</Label>
        <div className="flex flex-wrap gap-2">
          {PLATFORM_OPTIONS.map((platform) => (
            <button
              key={platform.value}
              type="button"
              onClick={() => togglePlatform(platform.value)}
              aria-pressed={form.platforms.includes(platform.value)}
              className={`rounded-[8px] border px-3 py-1.5 text-xs font-medium transition-colors ${
                form.platforms.includes(platform.value)
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground'
              }`}
            >
              {platform.label}
            </button>
          ))}
        </div>
        {form.platforms.length === 0 ? (
          <p role="alert" className="text-xs text-destructive">Select at least one target platform before confirming.</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Requirements</Label>
        <Textarea
          ref={requirementsRef}
          value={form.user_requirements}
          onChange={(e) => setForm(f => ({ ...f, user_requirements: e.target.value }))}
          onInput={resizeRequirements}
          placeholder="e.g. Find exactly 5 restaurant leads in New York"
          className="min-h-24 max-h-60 resize-y overflow-y-hidden text-sm [overflow-wrap:anywhere]"
        />
      </div>
    </div>
  );
}
