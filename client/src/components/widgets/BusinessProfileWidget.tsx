"use client";

/**
 * BusinessProfileWidget
 * Interactive widget for saving business profile information.
 */

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import type { WidgetProps } from "./types";

export function BusinessProfileWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    company_name: (widget.formValues.company_name as string) || '',
    industry: (widget.formValues.industry as string) || '',
    city: (widget.formValues.city as string) || '',
    country: (widget.formValues.country as string) || '',
    description: (widget.formValues.description as string) || '',
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
        <Label className="text-xs font-medium">Company Name *</Label>
        <Input
          value={form.company_name}
          onChange={(e) => updateField('company_name', e.target.value)}
          placeholder="Your company name"
          className="h-9 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Industry</Label>
        <Input
          value={form.industry}
          onChange={(e) => updateField('industry', e.target.value)}
          placeholder="e.g. SaaS, E-commerce, Healthcare"
          className="h-9 text-xs"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">City</Label>
          <Input
            value={form.city}
            onChange={(e) => updateField('city', e.target.value)}
            placeholder="e.g. San Francisco"
            className="h-9 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Country</Label>
          <Input
            value={form.country}
            onChange={(e) => updateField('country', e.target.value)}
            placeholder="e.g. United States"
            className="h-9 text-xs"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Description</Label>
        <Textarea
          value={form.description}
          onChange={(e) => updateField('description', e.target.value)}
          placeholder="What does your company do? Products/services offered?"
          className="min-h-[100px] text-sm"
        />
      </div>
    </div>
  );
}
