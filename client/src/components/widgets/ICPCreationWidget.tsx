"use client";

/**
 * ICPCreationWidget
 * Interactive widget for ICP (Ideal Customer Profile) creation.
 */

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import type { WidgetProps } from "./types";

export function ICPCreationWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    user_message: (widget.formValues.user_message as string) || '',
    campaign_name: (widget.formValues.campaign_name as string) || '',
    target_audience: (widget.formValues.target_audience as string) || '',
    industry: (widget.formValues.industry as string) || '',
    regions: (widget.formValues.regions as string) || '',
    company_size: (widget.formValues.company_size as string) || '',
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
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Campaign Requirements *</Label>
        <Textarea
          value={form.user_message}
          onChange={(e) => updateField('user_message', e.target.value)}
          placeholder="Describe your campaign requirements, target audience, goals..."
          className="min-h-[120px] text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Campaign Name</Label>
        <Input
          value={form.campaign_name}
          onChange={(e) => updateField('campaign_name', e.target.value)}
          placeholder="e.g. Q1 Lead Gen Campaign"
          className="h-9 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Target Audience</Label>
        <Input
          value={form.target_audience}
          onChange={(e) => updateField('target_audience', e.target.value)}
          placeholder="e.g. SaaS startup founders"
          className="h-9 text-xs"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Industry</Label>
          <Input
            value={form.industry}
            onChange={(e) => updateField('industry', e.target.value)}
            placeholder="e.g. Technology"
            className="h-9 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Company Size</Label>
          <Input
            value={form.company_size}
            onChange={(e) => updateField('company_size', e.target.value)}
            placeholder="e.g. 50-200 employees"
            className="h-9 text-xs"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Regions</Label>
        <Input
          value={form.regions}
          onChange={(e) => updateField('regions', e.target.value)}
          placeholder="e.g. US, Europe, India"
          className="h-9 text-xs"
        />
      </div>
    </div>
  );
}
