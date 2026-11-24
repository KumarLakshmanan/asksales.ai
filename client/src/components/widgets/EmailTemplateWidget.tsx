"use client";

/**
 * EmailTemplateWidget
 * Interactive widget for email template generation.
 */

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToneSelector, TONE_OPTIONS, TagInput, AutoGenerateToggle } from "./shared";
import type { WidgetProps } from "./types";

export function EmailTemplateWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    include_image_prompt: widget.formValues.include_image_prompt as boolean | undefined,
    include_video_prompt: widget.formValues.include_video_prompt as boolean | undefined,
    recipient_role: (widget.formValues.recipient_role as string) || '',
    sender_name: (widget.formValues.sender_name as string) || '',
    sender_business_name: (widget.formValues.sender_business_name as string) || '',
    subject_line: (widget.formValues.subject_line as string) || '',
    email_body_points: (widget.formValues.email_body_points as string[]) || [],
    content_instructions: (widget.formValues.content_instructions as string) || '',
    tone: (widget.formValues.tone as string) || 'professional',
    language: (widget.formValues.language as string) || 'English',
    length: (widget.formValues.length as string) || 'medium',
    email_type: (widget.formValues.email_type as string) || 'cold_outreach',
    include_personalization: (widget.formValues.include_personalization as boolean) ?? true,
    include_unsubscribe: (widget.formValues.include_unsubscribe as boolean) ?? true,
    cta_text: (widget.formValues.cta_text as string) || '',
    auto_generate_image: (widget.formValues.auto_generate_image as boolean) ?? false,
    auto_generate_video: (widget.formValues.auto_generate_video as boolean) ?? false,
    image_aspect_ratio: (widget.formValues.image_aspect_ratio as string) || '16:9',
    image_size: (widget.formValues.image_size as string) || '1K',
    image_count: (widget.formValues.image_count as number) || 1,
    image_style: (widget.formValues.image_style as string) || 'photorealistic',
    video_aspect_ratio: (widget.formValues.video_aspect_ratio as string) || '16:9',
    video_resolution: (widget.formValues.video_resolution as string) || '720p',
    video_duration_seconds: (widget.formValues.video_duration_seconds as number) || 8,
    video_count: (widget.formValues.video_count as number) || 1,
    video_style: (widget.formValues.video_style as string) || 'cinematic',
    sequence_steps: clampSequenceSteps(widget.formValues.sequence_steps),
    step_delay_days: Array.isArray(widget.formValues.step_delay_days) ? (widget.formValues.step_delay_days as number[]) : [],
  });
  const [delayText, setDelayText] = useState(() => form.step_delay_days.join(', '));

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
        <Label htmlFor="email-sender-name" className="text-xs">Sender name (optional)</Label>
        <Input id="email-sender-name" value={form.sender_name} onChange={e => updateField('sender_name', e.target.value)} />
        <Label htmlFor="email-sender" className="text-xs">Sender business</Label>
        <Input id="email-sender" value={form.sender_business_name} onChange={e => updateField('sender_business_name', e.target.value)} placeholder="Business sending this campaign" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Recipient Role</Label>
        <Input
          value={form.recipient_role}
          onChange={(e) => updateField('recipient_role', e.target.value)}
          placeholder="e.g. CEO, Marketing Manager"
          className="h-9 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Subject Line (optional)</Label>
        <Input
          value={form.subject_line}
          onChange={(e) => updateField('subject_line', e.target.value)}
          placeholder="Auto-generated if empty"
          className="h-9 text-xs"
        />
      </div>

      <TagInput
        value={form.email_body_points}
        onChange={(v) => updateField('email_body_points', v)}
        placeholder="Add key point..."
        label="Key Points"
      />

      <div className="space-y-1.5">
        <Label htmlFor={`email-constraints-${widget.id}`} className="text-xs font-medium">Content instructions</Label>
        <Textarea id={`email-constraints-${widget.id}`} value={form.content_instructions} onChange={(e) => updateField('content_instructions', e.target.value)} className="text-sm" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`email-sequence-steps-${widget.id}`} className="text-xs font-medium">Emails in sequence</Label>
          <Input
            id={`email-sequence-steps-${widget.id}`}
            type="number"
            min={1}
            max={5}
            value={form.sequence_steps}
            onChange={(e) => updateField('sequence_steps', clampSequenceSteps(e.target.value))}
            className="h-9 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">1 for a single email, up to 5. Each step is saved as its own draft.</p>
        </div>
        {form.sequence_steps > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor={`email-step-delays-${widget.id}`} className="text-xs font-medium">Days before each follow-up</Label>
            <Input
              id={`email-step-delays-${widget.id}`}
              value={delayText}
              onChange={(e) => {
                setDelayText(e.target.value);
                updateField('step_delay_days', parseDelayDays(e.target.value));
              }}
              placeholder="e.g. 3, 7"
              className="h-9 text-xs"
            />
            <p className="text-[11px] text-muted-foreground">Counted from the previous email. Empty means 3 days each.</p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Email Type</Label>
          <Select value={form.email_type} onValueChange={(v) => updateField('email_type', v)}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cold_outreach">Cold Outreach</SelectItem>
              <SelectItem value="follow_up">Follow Up</SelectItem>
              <SelectItem value="newsletter">Newsletter</SelectItem>
              <SelectItem value="promotional">Promotional</SelectItem>
              <SelectItem value="introduction">Introduction</SelectItem>
              <SelectItem value="thank_you">Thank You</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Length</Label>
          <Select value={form.length} onValueChange={(v) => updateField('length', v)}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="short">Short (2-3 sentences)</SelectItem>
              <SelectItem value="medium">Medium (1-2 paragraphs)</SelectItem>
              <SelectItem value="long">Long (3+ paragraphs)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <ToneSelector
        value={form.tone}
        onChange={(v) => updateField('tone', v)}
        options={TONE_OPTIONS.email}
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

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">CTA Text (optional)</Label>
        <Input
          value={form.cta_text}
          onChange={(e) => updateField('cta_text', e.target.value)}
          placeholder='e.g. "Book a Demo", "Learn More"'
          className="h-9 text-xs"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Include {"{{first_name}}"} personalization</Label>
          <Switch checked={form.include_personalization} onCheckedChange={(v) => updateField('include_personalization', v)} />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Include unsubscribe link</Label>
          <Switch checked={form.include_unsubscribe} onCheckedChange={(v) => updateField('include_unsubscribe', v)} />
        </div>
      </div>

      <div className="border-t pt-4 space-y-4">
        <AutoGenerateToggle
          capabilities={widget.formValues.video_capabilities as import('../../../../shared/videoSettings').VideoCapabilities | undefined}
          provider={widget.formValues.video_provider as string | undefined}
          type="image"
          enabled={form.auto_generate_image}
          onEnabledChange={(v) => updateField('auto_generate_image', v)}
          settings={{
            image_aspect_ratio: form.image_aspect_ratio,
            image_size: form.image_size,
            image_count: form.image_count,
            image_style: form.image_style,
          }}
          onSettingsChange={(s) => setForm(f => ({
            ...f,
            image_aspect_ratio: s.image_aspect_ratio as string,
            image_size: s.image_size as string,
            image_count: s.image_count as number,
            image_style: s.image_style as string,
          }))}
          label="Auto-generate Email Banner"
        />

        <AutoGenerateToggle
          capabilities={widget.formValues.video_capabilities as import('../../../../shared/videoSettings').VideoCapabilities | undefined}
          provider={widget.formValues.video_provider as string | undefined}
          type="video"
          enabled={form.auto_generate_video}
          onEnabledChange={(v) => updateField('auto_generate_video', v)}
          settings={{
            video_aspect_ratio: form.video_aspect_ratio,
            video_resolution: form.video_resolution,
            video_duration_seconds: form.video_duration_seconds,
            video_count: form.video_count,
            video_style: form.video_style,
          }}
          onSettingsChange={(s) => setForm(f => ({
            ...f,
            video_aspect_ratio: s.video_aspect_ratio as string,
            video_resolution: s.video_resolution as string,
            video_duration_seconds: s.video_duration_seconds as number,
            video_count: s.video_count as number,
            video_style: s.video_style as string,
          }))}
          label="Auto-generate Video Intro"
        />
      </div>
    </div>
  );
}

function clampSequenceSteps(value: unknown): number {
  const steps = Math.trunc(Number(value));
  return Number.isFinite(steps) ? Math.min(Math.max(steps, 1), 5) : 1;
}

function parseDelayDays(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .filter((part) => part.trim() !== "")
    .map((part) => Math.trunc(Number(part)))
    .filter((days) => Number.isFinite(days) && days >= 0 && days <= 90);
}
