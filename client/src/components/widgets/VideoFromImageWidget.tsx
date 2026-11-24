"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { VideoSettingsGroup, SourceImagePicker } from "./shared";
import { GOOGLE_VIDEO_CAPABILITIES, prepareVideoSettings } from '../../../../shared/videoSettings';
import type { WidgetProps } from "./types";

export function VideoFromImageWidget({ widget, onFormChange }: WidgetProps) {
  const proposed = prepareVideoSettings(widget.formValues, (widget.formValues.video_capabilities as import('../../../../shared/videoSettings').VideoCapabilities) || GOOGLE_VIDEO_CAPABILITIES, widget.formValues.provider !== 'openrouter');
  const [form, setForm] = useState({
    prompt: (widget.formValues.prompt as string) || '',
    include_brand_logo: widget.formValues.include_brand_logo !== false,
    source_image_id: (widget.formValues.source_image_id as string) || '',
    aspect_ratio: (proposed.aspect_ratio as string) || '16:9',
    duration_seconds: (proposed.duration_seconds as number) || 8,
    resolution: (proposed.resolution as string) || (widget.formValues.video_resolution as string) || '720p',
    generate_audio: (widget.formValues.generate_audio as boolean) || false,
    seed: (widget.formValues.seed as number) || undefined,
    number_of_videos: (proposed.number_of_videos as number) || 1,
    person_generation: (widget.formValues.person_generation as string) || 'allow_adult',
    negative_prompt: (widget.formValues.negative_prompt as string) || '',
  });

  useEffect(() => {
    onFormChange(form);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label htmlFor={`brand-logo-${widget.id}`} className="text-xs">Include brand logo</Label>
        <Switch id={`brand-logo-${widget.id}`} checked={form.include_brand_logo} onCheckedChange={include_brand_logo => setForm(f => ({ ...f, include_brand_logo }))} />
      </div>
      <SourceImagePicker
        value={form.source_image_id}
        onChange={(v) => setForm(f => ({ ...f, source_image_id: v || '' }))}
      />

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Animation Prompt *</Label>
        <Textarea
          value={form.prompt}
          onChange={(e) => setForm(f => ({ ...f, prompt: e.target.value }))}
          placeholder="Describe the video animation..."
          className="min-h-[100px] text-sm"
        />
      </div>

      {typeof widget.formValues.video_settings_note === 'string' && <p role="status" className="text-xs text-muted-foreground">{widget.formValues.video_settings_note}</p>}
      <VideoSettingsGroup
        provider={widget.formValues.provider as string | undefined}
        capabilities={widget.formValues.video_capabilities as import('../../../../shared/videoSettings').VideoCapabilities | undefined}
        values={{
          aspect_ratio: form.aspect_ratio,
          duration_seconds: form.duration_seconds,
          video_resolution: form.resolution,
          generate_audio: form.generate_audio,
          number_of_videos: form.number_of_videos,
          person_generation: form.person_generation,
        }}
        onChange={(v) => setForm(f => ({
          ...f,
          aspect_ratio: v.aspect_ratio || '16:9',
          duration_seconds: v.duration_seconds || 8,
          resolution: v.video_resolution || '720p',
          generate_audio: v.generate_audio === true,
          number_of_videos: v.number_of_videos || 1,
          person_generation: v.person_generation || 'allow_adult',
        }))}
      />

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Negative Prompt (optional)</Label>
        <Textarea
          value={form.negative_prompt}
          onChange={(e) => setForm(f => ({ ...f, negative_prompt: e.target.value }))}
          placeholder="What to exclude"
          className="min-h-[60px] text-sm"
        />
      </div>
    </div>
  );
}
