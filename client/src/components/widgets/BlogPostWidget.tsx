"use client";

/**
 * BlogPostWidget
 * Interactive widget for blog post generation.
 */

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToneSelector, TONE_OPTIONS, TagInput, AutoGenerateToggle } from "./shared";
import type { WidgetProps } from "./types";

export function BlogPostWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    include_image_prompt: widget.formValues.include_image_prompt as boolean | undefined,
    include_video_prompt: widget.formValues.include_video_prompt as boolean | undefined,
    topic: (widget.formValues.topic as string) || '',
    cta_text: (widget.formValues.cta_text as string) || '',
    content_instructions: (widget.formValues.content_instructions as string) || '',
    tone: (widget.formValues.tone as string) || 'professional',
    length: (widget.formValues.length as string) || 'medium',
    target_audience: (widget.formValues.target_audience as string) || '',
    seo_keywords: (widget.formValues.seo_keywords as string[]) || [],
    outline: (widget.formValues.outline as string[]) || [],
    language: (widget.formValues.language as string) || 'English',
    include_meta_description: (widget.formValues.include_meta_description as boolean) ?? true,
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
        <Label className="text-xs font-medium">Topic *</Label>
        <Textarea
          value={form.topic}
          onChange={(e) => updateField('topic', e.target.value)}
          placeholder="Blog post topic or title"
          className="min-h-[80px] text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`blog-cta-${widget.id}`} className="text-xs font-medium">Exact CTA text</Label>
        <Input id={`blog-cta-${widget.id}`} value={form.cta_text} onChange={(e) => updateField('cta_text', e.target.value)} placeholder="Optional; preserved verbatim" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`blog-instructions-${widget.id}`} className="text-xs font-medium">Content instructions</Label>
        <Textarea id={`blog-instructions-${widget.id}`} value={form.content_instructions} onChange={(e) => updateField('content_instructions', e.target.value)} />
      </div>

      <ToneSelector
        value={form.tone}
        onChange={(v) => updateField('tone', v)}
        options={TONE_OPTIONS.blog}
      />

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Length</Label>
          <Select value={form.length} onValueChange={(v) => updateField('length', v)}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="short">Short (500-800 words)</SelectItem>
              <SelectItem value="medium">Medium (1000-1500 words)</SelectItem>
              <SelectItem value="long">Long (2000-3000 words)</SelectItem>
            </SelectContent>
          </Select>
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
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Target Audience</Label>
        <Input
          value={form.target_audience}
          onChange={(e) => updateField('target_audience', e.target.value)}
          placeholder="Who is this blog post for?"
          className="h-9 text-xs"
        />
      </div>

      <TagInput
        value={form.seo_keywords}
        onChange={(v) => updateField('seo_keywords', v)}
        placeholder="Add SEO keyword..."
        label="SEO Keywords"
      />

      <TagInput
        value={form.outline}
        onChange={(v) => updateField('outline', v)}
        placeholder="Add section heading..."
        label="Outline Sections"
      />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Include meta description</Label>
          <Switch checked={form.include_meta_description} onCheckedChange={(v) => updateField('include_meta_description', v)} />
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
          label="Auto-generate Featured Image"
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
          label="Auto-generate Video Summary"
        />
      </div>
    </div>
  );
}
