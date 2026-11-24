"use client";

/**
 * VideoGenerationWidget
 * Interactive widget for AI video generation.
 */

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import { VideoSettingsGroup } from "./shared";
import type { WidgetProps } from "./types";
import { GOOGLE_VIDEO_CAPABILITIES, prepareVideoSettings } from '../../../../shared/videoSettings';
import { useWidgetPromptEnhancement } from '@/hooks/use-widget-prompt-enhancement';

export function VideoGenerationWidget({ widget, onFormChange }: WidgetProps) {
  const proposed = prepareVideoSettings(widget.formValues, (widget.formValues.video_capabilities as import('../../../../shared/videoSettings').VideoCapabilities) || GOOGLE_VIDEO_CAPABILITIES, widget.formValues.provider !== 'openrouter');
  const [form, setForm] = useState({
    prompt: (widget.formValues.prompt as string) || '',
    include_brand_logo: widget.formValues.include_brand_logo !== false,
    aspect_ratio: (proposed.aspect_ratio as string) || '16:9',
    duration_seconds: (proposed.duration_seconds as number) || 8,
    number_of_videos: (proposed.number_of_videos as number) || 1,
    person_generation: (widget.formValues.person_generation as string) || 'allow_adult',
    negative_prompt: (widget.formValues.negative_prompt as string) || '',
    seed: (widget.formValues.seed as number) || undefined,
    style: (widget.formValues.style as string) || 'cinematic',
    resolution: (proposed.resolution as string) || (widget.formValues.video_resolution as string) || '720p',
    generate_audio: (widget.formValues.generate_audio as boolean) || false,
  });

  useEffect(() => {
    onFormChange(form);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  const { isEnhancing, enhancePrompt: handleEnhancePrompt } = useWidgetPromptEnhancement({
    widgetId: widget.id, threadId: widget.threadId, contentType: 'video', prompt: form.prompt,
    apply: prompt => setForm(current => ({ ...current, prompt })),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label htmlFor={`brand-logo-${widget.id}`} className="text-xs">Include brand logo</Label>
        <Switch id={`brand-logo-${widget.id}`} checked={form.include_brand_logo} onCheckedChange={include_brand_logo => setForm(f => ({ ...f, include_brand_logo }))} />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Prompt</Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleEnhancePrompt}
            loading={isEnhancing}
            loadingText="Enhance"
            disabled={!form.prompt.trim()}
            className="h-7 text-xs text-primary hover:bg-primary/10 hover:text-primary"
          >
            <Sparkles className="w-3.5 h-3.5 mr-1" /> Enhance
          </Button>
        </div>
        <Textarea
          value={form.prompt}
          onChange={(e) => setForm(f => ({ ...f, prompt: e.target.value }))}
          placeholder="Describe the video to generate..."
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
          number_of_videos: form.number_of_videos,
          person_generation: form.person_generation,
          video_resolution: form.resolution,
          generate_audio: form.generate_audio,
          style: form.style,
        }}
        onChange={(v) => setForm(f => ({
          ...f,
          aspect_ratio: v.aspect_ratio || '16:9',
          duration_seconds: v.duration_seconds || 8,
          number_of_videos: v.number_of_videos || 1,
          person_generation: v.person_generation || 'allow_adult',
          resolution: v.video_resolution || '720p',
          generate_audio: v.generate_audio === true,
          style: v.style || 'cinematic',
        }))}
      />

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Negative Prompt (optional)</Label>
        <Input
          value={form.negative_prompt}
          onChange={(e) => setForm(f => ({ ...f, negative_prompt: e.target.value }))}
          placeholder="What to exclude from the video"
          className="h-9 text-xs"
        />
      </div>
    </div>
  );
}
