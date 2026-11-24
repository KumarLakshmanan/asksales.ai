"use client";

/**
 * ImageGenerationWidget
 * Interactive widget for AI image generation.
 * Pre-filled by AI, user can edit before submitting.
 */

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import { ImageSettingsGroup } from "./shared";
import type { WidgetProps } from "./types";
import { useWidgetPromptEnhancement } from '@/hooks/use-widget-prompt-enhancement';

export function ImageGenerationWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    prompt: (widget.formValues.prompt as string) || '',
    include_brand_logo: widget.formValues.include_brand_logo !== false,
    aspect_ratio: (widget.formValues.aspect_ratio as string) || '1:1',
    image_size: (widget.formValues.image_size as string) || '1K',
    number_of_images: (widget.formValues.number_of_images as number) || 1,
    negative_prompt: (widget.formValues.negative_prompt as string) || '',
    seed: (widget.formValues.seed as number) || undefined,
    style: (widget.formValues.style as string) || 'photorealistic',
    for_content_type: (widget.formValues.for_content_type as string) || 'general',
  });

  useEffect(() => {
    onFormChange(form);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  const { isEnhancing, enhancePrompt: handleEnhancePrompt } = useWidgetPromptEnhancement({
    widgetId: widget.id, threadId: widget.threadId, contentType: 'image', prompt: form.prompt,
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
          placeholder="Describe the image to generate..."
          className="min-h-[100px] text-sm"
        />
      </div>

      <ImageSettingsGroup
        values={{
          aspect_ratio: form.aspect_ratio,
          image_size: form.image_size,
          number_of_images: form.number_of_images,
          style: form.style,
        }}
        onChange={(v) => setForm(f => ({
          ...f,
          aspect_ratio: v.aspect_ratio || '1:1',
          image_size: v.image_size || '1K',
          number_of_images: v.number_of_images || 1,
          style: v.style || 'photorealistic',
        }))}
      />

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Negative Prompt (optional)</Label>
        <Input
          value={form.negative_prompt}
          onChange={(e) => setForm(f => ({ ...f, negative_prompt: e.target.value }))}
          placeholder="What to exclude from the image"
          className="h-9 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Seed (optional)</Label>
        <Input
          type="number"
          value={form.seed || ''}
          onChange={(e) => setForm(f => ({ ...f, seed: e.target.value ? Number(e.target.value) : undefined }))}
          placeholder="Random seed for reproducibility"
          className="h-9 text-xs"
        />
      </div>
    </div>
  );
}
