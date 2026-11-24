"use client";

/**
 * SmsTemplateWidget
 * Interactive widget for SMS template generation.
 */

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToneSelector, TONE_OPTIONS } from "./shared";
import type { WidgetProps } from "./types";

export function SmsTemplateWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    key_message: (widget.formValues.key_message as string) || '',
    include_image_prompt: widget.formValues.include_image_prompt === true,
    auto_generate_image: widget.formValues.auto_generate_image === true,
    campaign_name: (widget.formValues.campaign_name as string) || '',
    target_audience: (widget.formValues.target_audience as string) || '',
    call_to_action: (widget.formValues.call_to_action as string) || '',
    tone: (widget.formValues.tone as string) || 'professional',
    language: (widget.formValues.language as string) || 'English',
    urgency: (widget.formValues.urgency as string) || 'medium',
    include_link: (widget.formValues.include_link as boolean) ?? false,
    include_personalization: (widget.formValues.include_personalization as boolean) ?? false,
    sms_type: (widget.formValues.sms_type as string) || 'promotional',
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
        <Label className="text-xs font-medium">Key Message *</Label>
        <Textarea
          value={form.key_message}
          onChange={(e) => updateField('key_message', e.target.value)}
          placeholder="Main point to convey in the SMS"
          className="min-h-[80px] text-sm"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Campaign Name</Label>
          <Input
            value={form.campaign_name}
            onChange={(e) => updateField('campaign_name', e.target.value)}
            placeholder="For tracking"
            className="h-9 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">SMS Type</Label>
          <Select value={form.sms_type} onValueChange={(v) => updateField('sms_type', v)}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="promotional">Promotional</SelectItem>
              <SelectItem value="transactional">Transactional</SelectItem>
              <SelectItem value="reminder">Reminder</SelectItem>
              <SelectItem value="follow_up">Follow Up</SelectItem>
              <SelectItem value="announcement">Announcement</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Target Audience</Label>
        <Input
          value={form.target_audience}
          onChange={(e) => updateField('target_audience', e.target.value)}
          placeholder="Describe target audience"
          className="h-9 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Call to Action</Label>
        <Input
          value={form.call_to_action}
          onChange={(e) => updateField('call_to_action', e.target.value)}
          placeholder='e.g. "Visit our website", "Reply YES"'
          className="h-9 text-xs"
        />
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="sms-image" className="text-xs font-medium">Generate accompanying image (MMS)</Label>
        <Switch id="sms-image" checked={form.auto_generate_image} onCheckedChange={v => setForm(f => ({ ...f, auto_generate_image: v, include_image_prompt: v }))} />
      </div>
      <ToneSelector
        value={form.tone}
        onChange={(v) => updateField('tone', v)}
        options={TONE_OPTIONS.sms}
      />

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Language</Label>
        <Input
          value={form.language}
          onChange={(e) => updateField('language', e.target.value)}
          placeholder="English"
          className="h-9 text-xs"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Include link placeholder</Label>
          <Switch checked={form.include_link} onCheckedChange={(v) => updateField('include_link', v)} />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Include {"{{first_name}}"} personalization</Label>
          <Switch checked={form.include_personalization} onCheckedChange={(v) => updateField('include_personalization', v)} />
        </div>
      </div>
    </div>
  );
}
