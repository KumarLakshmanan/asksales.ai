"use client";

/**
 * SocialPostWidget
 * Interactive widget for social media post generation.
 */

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PlatformCards, PLATFORM_SETS, ToneSelector, TONE_OPTIONS, AutoGenerateToggle } from "./shared";
import type { WidgetProps } from "./types";

export function SocialPostWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    include_image_prompt: widget.formValues.include_image_prompt as boolean | undefined,
    include_video_prompt: widget.formValues.include_video_prompt as boolean | undefined,
    platform: (widget.formValues.platform as string) || 'all',
    topic: (widget.formValues.topic as string) || '',
    tone: (widget.formValues.tone as string) || 'professional',
    length: (widget.formValues.length as string) || 'medium',
    language: (widget.formValues.language as string) || 'English',
    include_emojis: (widget.formValues.include_emojis as boolean) ?? true,
    include_cta: (widget.formValues.include_cta as boolean) ?? true,
    cta_text: (widget.formValues.cta_text as string) || '',
    content_instructions: (widget.formValues.content_instructions as string) || '',
    post_format: (widget.formValues.post_format as string) || 'text',
    hashtags: (widget.formValues.hashtags as boolean) ?? true,
    number_of_hashtags: (widget.formValues.number_of_hashtags as number) || 8,
    number_of_posts: (widget.formValues.number_of_posts as number) || 1,
    auto_generate_image: (widget.formValues.auto_generate_image as boolean) ?? false,
    auto_generate_video: (widget.formValues.auto_generate_video as boolean) ?? false,
    image_aspect_ratio: (widget.formValues.image_aspect_ratio as string) || '1:1',
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
      <PlatformCards
        value={form.platform}
        onChange={(v) => updateField('platform', v)}
        platforms={PLATFORM_SETS.social}
      />

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Topic</Label>
        <Textarea
          value={form.topic}
          onChange={(e) => updateField('topic', e.target.value)}
          placeholder="What is the post about?"
          className="min-h-[80px] text-sm"
        />
      </div>

      <ToneSelector
        value={form.tone}
        onChange={(v) => updateField('tone', v)}
        options={TONE_OPTIONS.social}
      />

      <div className="space-y-1.5">
        <Label htmlFor={`social-constraints-${widget.id}`} className="text-xs font-medium">Content instructions</Label>
        <Textarea id={`social-constraints-${widget.id}`} value={form.content_instructions} onChange={(e) => updateField('content_instructions', e.target.value)} className="text-sm" />
      </div>
      {form.include_cta && <div className="space-y-1.5">
        <Label htmlFor={`social-cta-${widget.id}`} className="text-xs font-medium">Exact CTA text</Label>
        <Input id={`social-cta-${widget.id}`} value={form.cta_text} onChange={(e) => updateField('cta_text', e.target.value)} placeholder="Optional; preserved verbatim" className="h-9 text-xs" />
      </div>}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Length</Label>
          <Select value={form.length} onValueChange={(v) => updateField('length', v)}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="short">Short (1-2 lines)</SelectItem>
              <SelectItem value="medium">Medium (3-5 lines)</SelectItem>
              <SelectItem value="long">Long (6+ lines)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Format</Label>
          <Select value={form.post_format} onValueChange={(v) => updateField('post_format', v)}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="carousel">Carousel</SelectItem>
              <SelectItem value="story">Story</SelectItem>
              <SelectItem value="reel">Reel</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`social-post-count-${widget.id}`} className="text-xs font-medium">Number of posts</Label>
        <Input
          id={`social-post-count-${widget.id}`}
          type="number"
          inputMode="numeric"
          min={1}
          max={30}
          value={form.number_of_posts}
          onChange={(e) => updateField('number_of_posts', Math.min(30, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
          className="h-9 text-xs"
          aria-describedby={`social-post-count-help-${widget.id}`}
        />
        <p id={`social-post-count-help-${widget.id}`} className="text-[11px] text-muted-foreground">
          {form.number_of_posts > 1
            ? `Creates ${form.number_of_posts} separate draft posts, each checked against the platform's character limit.`
            : "Use more than 1 for a content plan, e.g. 30 for a 30-day plan (up to 30)."}
        </p>
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
          <Label className="text-xs font-medium">Emojis</Label>
          <Switch checked={form.include_emojis} onCheckedChange={(v) => updateField('include_emojis', v)} />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Call to Action</Label>
          <Switch checked={form.include_cta} onCheckedChange={(v) => updateField('include_cta', v)} />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Hashtags ({form.number_of_hashtags})</Label>
          <Switch checked={form.hashtags} onCheckedChange={(v) => updateField('hashtags', v)} />
        </div>
      </div>

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
      />
    </div>
  );
}
