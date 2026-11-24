"use client";

/**
 * CrmReminderWidget
 * Interactive widget for creating CRM reminders.
 */

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WidgetProps } from "./types";

export function CrmReminderWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    title: (widget.formValues.title as string) || '',
    reminder_due_at: (widget.formValues.reminder_due_at as string) || '',
    reminder_type: (widget.formValues.reminder_type as string) || 'followup',
    description: (widget.formValues.description as string) || '',
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

  // Format datetime for input
  const formatDateTimeForInput = (iso: string) => {
    if (!iso) return '';
    try {
      const date = new Date(iso);
      return date.toISOString().slice(0, 16);
    } catch {
      return '';
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Reminder Title *</Label>
        <Input
          value={form.title}
          onChange={(e) => updateField('title', e.target.value)}
          placeholder="e.g. Meeting with John, Follow up on proposal"
          className="h-9 text-xs"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Due Date & Time *</Label>
          <Input
            type="datetime-local"
            value={formatDateTimeForInput(form.reminder_due_at)}
            onChange={(e) => updateField('reminder_due_at', e.target.value ? new Date(e.target.value).toISOString() : '')}
            className="h-9 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Type</Label>
          <Select value={form.reminder_type} onValueChange={(v) => updateField('reminder_type', v)}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="followup">Follow Up</SelectItem>
              <SelectItem value="meeting">Meeting</SelectItem>
              <SelectItem value="call">Call</SelectItem>
              <SelectItem value="task">Task</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Description</Label>
        <Textarea
          value={form.description}
          onChange={(e) => updateField('description', e.target.value)}
          placeholder="Additional details"
          className="min-h-[60px] text-sm"
        />
      </div>
    </div>
  );
}
