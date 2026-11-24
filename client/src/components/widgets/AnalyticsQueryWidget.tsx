"use client";

/**
 * AnalyticsQueryWidget
 * Interactive widget for analytics queries.
 */

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { WidgetProps } from "./types";

const QUERY_TYPES = [
  { value: 'overview', label: 'Overview', description: 'All marketing data' },
  { value: 'campaign', label: 'Campaigns', description: 'Campaign performance' },
  { value: 'lead', label: 'Leads', description: 'Lead generation metrics' },
  { value: 'outreach', label: 'Outreach', description: 'Email & SMS stats' },
];

export function AnalyticsQueryWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    question: (widget.formValues.question as string) || '',
    query_type: (widget.formValues.query_type as string) || 'overview',
    scope: widget.formValues.scope === 'all_owned' ? 'all_owned' : 'current_campaign',
  });

  useEffect(() => {
    onFormChange(form);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  const updateField = (field: string, value: unknown) => {
    setForm(f => ({ ...f, [field]: value }));
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs font-medium">Analytics Type</Label>
        <div className="grid grid-cols-2 gap-2">
          {QUERY_TYPES.map((type) => (
            <button
              key={type.value}
              type="button"
              onClick={() => updateField('query_type', type.value)}
              className={cn(
                "p-3 rounded-xl border text-left transition-all",
                form.query_type === type.value
                  ? "border-primary/40 bg-primary/10"
                  : "border-border hover:border-border/80 bg-secondary/30"
              )}
            >
              <span className="text-sm font-medium">{type.label}</span>
              <span className="block text-xs text-muted-foreground mt-0.5">{type.description}</span>
            </button>
          ))}
        </div>
      </div>

      {form.query_type === 'campaign' && <div className="space-y-1.5">
        <Label htmlFor={`analytics-scope-${widget.id}`} className="text-xs font-medium">Campaign scope</Label>
        <select id={`analytics-scope-${widget.id}`} value={form.scope}
          onChange={event => updateField('scope', event.target.value)}
          className="w-full rounded-md border border-border bg-background p-2 text-sm">
          <option value="current_campaign">This conversation</option>
          <option value="all_owned">All campaigns in my account</option>
        </select>
      </div>}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Question</Label>
        <Textarea
          value={form.question}
          onChange={(e) => updateField('question', e.target.value)}
          placeholder="e.g. What's my best performing campaign? Show lead conversion rates."
          className="min-h-[80px] text-sm"
        />
      </div>
    </div>
  );
}
