"use client";

/**
 * SocialChatTemplateWidget
 * Interactive widget for social media DM/chat template generation.
 */

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PlatformCards, PLATFORM_SETS, ToneSelector, TONE_OPTIONS } from "./shared";
import type { WidgetProps } from "./types";

export function SocialChatTemplateWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    platform: (widget.formValues.platform as string) || 'linkedin',
    objective: (widget.formValues.objective as string) || '',
    cta_text: (widget.formValues.cta_text as string) || '',
    content_instructions: (widget.formValues.content_instructions as string) || '',
    include_image_prompt: widget.formValues.include_image_prompt === true,
    auto_generate_image: widget.formValues.auto_generate_image === true,
    message_style: (widget.formValues.message_style as string) || 'introduction',
    tone: (widget.formValues.tone as string) || 'professional',
    language: (widget.formValues.language as string) || 'English',
    recipient_context: (widget.formValues.recipient_context as string) || '',
    include_personalization: (widget.formValues.include_personalization as boolean) ?? true,
    urgency: (widget.formValues.urgency as string) || 'low',
    include_follow_ups: (widget.formValues.include_follow_ups as boolean) ?? false,
    number_of_follow_ups: (widget.formValues.number_of_follow_ups as number) || 2,
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
      <PlatformCards
        value={form.platform}
        onChange={(v) => updateField('platform', v)}
        platforms={PLATFORM_SETS.socialChat}
      />

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Objective *</Label>
        <Textarea
          value={form.objective}
          onChange={(e) => updateField('objective', e.target.value)}
          placeholder="What is the goal of this message?"
          className="min-h-[60px] text-sm"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Message Style</Label>
          <Select value={form.message_style} onValueChange={(v) => updateField('message_style', v)}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="introduction">Introduction</SelectItem>
              <SelectItem value="follow_up">Follow Up</SelectItem>
              <SelectItem value="pitch">Pitch</SelectItem>
              <SelectItem value="thank_you">Thank You</SelectItem>
              <SelectItem value="cold_outreach">Cold Outreach</SelectItem>
              <SelectItem value="networking">Networking</SelectItem>
              <SelectItem value="partnership">Partnership</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Urgency</Label>
          <Select value={form.urgency} onValueChange={(v) => updateField('urgency', v)}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="dm-cta" className="text-xs font-medium">Exact call to action</Label>
        <Input id="dm-cta" value={form.cta_text} onChange={e => updateField('cta_text', e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="dm-instructions" className="text-xs font-medium">Content requirements</Label>
        <Textarea id="dm-instructions" value={form.content_instructions} onChange={e => updateField('content_instructions', e.target.value)} />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="dm-image" className="text-xs font-medium">Generate accompanying image</Label>
        <Switch id="dm-image" checked={form.auto_generate_image} onCheckedChange={v => setForm(f => ({ ...f, auto_generate_image: v, include_image_prompt: v }))} />
      </div>
      <ToneSelector
        value={form.tone}
        onChange={(v) => updateField('tone', v)}
        options={TONE_OPTIONS.chat}
      />

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Recipient Context (optional)</Label>
        <Textarea
          value={form.recipient_context}
          onChange={(e) => updateField('recipient_context', e.target.value)}
          placeholder="Role, company, interests..."
          className="min-h-[60px] text-sm"
        />
      </div>

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
          <Label className="text-xs font-medium">Include {"{{first_name}}"} personalization</Label>
          <Switch checked={form.include_personalization} onCheckedChange={(v) => updateField('include_personalization', v)} />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Generate follow-up variations</Label>
          <Switch checked={form.include_follow_ups} onCheckedChange={(v) => updateField('include_follow_ups', v)} />
        </div>
        {form.include_follow_ups && (
          <div className="space-y-1.5 ml-4">
            <Label className="text-xs font-medium">Number of follow-ups: {form.number_of_follow_ups}</Label>
            <input
              type="range"
              min={1}
              max={5}
              value={form.number_of_follow_ups}
              onChange={(e) => updateField('number_of_follow_ups', Number(e.target.value))}
              className="w-full"
            />
          </div>
        )}
      </div>
    </div>
  );
}
