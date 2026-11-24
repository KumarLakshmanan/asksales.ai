"use client";

/**
 * PipelineStatusWidget
 * Interactive widget for updating CRM pipeline status.
 */

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { WidgetProps } from "./types";

const PIPELINE_STATUSES = [
  { value: 'interested', label: 'Interested', color: '#10b981' },
  { value: 'negotiation', label: 'Negotiation', color: '#f59e0b' },
  { value: 'demo', label: 'Demo', color: '#3b82f6' },
  { value: 'proposal_sent', label: 'Proposal Sent', color: '#8b5cf6' },
  { value: 'won', label: 'Won', color: '#22c55e' },
  { value: 'lost', label: 'Lost', color: '#ef4444' },
  { value: 'ticket_open', label: 'Ticket Open', color: '#f97316' },
  { value: 'ticket_closed', label: 'Ticket Closed', color: '#6b7280' },
];

export function PipelineStatusWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    pipeline_status: (widget.formValues.pipeline_status as string) || '',
    reason: (widget.formValues.reason as string) || '',
    contact_id: (widget.formValues.contact_id as number) || undefined,
    lead_id: (widget.formValues.lead_id as number) || undefined,
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
        <Label className="text-xs font-medium">Deal Status *</Label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {PIPELINE_STATUSES.map((status) => (
            <button
              key={status.value}
              type="button"
              onClick={() => updateField('pipeline_status', status.value)}
              className={cn(
                "p-3 rounded-xl border text-center transition-all",
                form.pipeline_status === status.value
                  ? "border-primary/40 bg-primary/10"
                  : "border-border hover:border-border/80 bg-secondary/30"
              )}
            >
              <div
                className="w-3 h-3 rounded-full mx-auto mb-1.5"
                style={{ backgroundColor: status.color }}
              />
              <span className="text-xs font-medium">{status.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Reason for Change</Label>
        <Textarea
          value={form.reason}
          onChange={(e) => updateField('reason', e.target.value)}
          placeholder="Why is the status changing?"
          className="min-h-[60px] text-sm"
        />
      </div>
    </div>
  );
}
