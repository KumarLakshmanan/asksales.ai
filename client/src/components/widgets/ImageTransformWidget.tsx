"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImageSettingsGroup, SourceImagePicker } from "./shared";
import type { WidgetProps } from "./types";

export function ImageTransformWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    prompt: (widget.formValues.prompt as string) || '',
    include_brand_logo: widget.formValues.include_brand_logo !== false,
    source_image_id: (widget.formValues.source_image_id as string) || '',
    aspect_ratio: (widget.formValues.aspect_ratio as string) || '1:1',
    image_size: (widget.formValues.image_size as string) || '1K',
    number_of_images: (widget.formValues.number_of_images as number) || 1,
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
        <Label className="text-xs font-medium">Transformation Prompt *</Label>
        <Textarea
          value={form.prompt}
          onChange={(e) => setForm(f => ({ ...f, prompt: e.target.value }))}
          placeholder="Describe how to transform the image..."
          className="min-h-[100px] text-sm"
        />
      </div>

      <ImageSettingsGroup
        values={{
          aspect_ratio: form.aspect_ratio,
          image_size: form.image_size,
          number_of_images: form.number_of_images,
        }}
        onChange={(v) => setForm(f => ({
          ...f,
          aspect_ratio: v.aspect_ratio || '1:1',
          image_size: v.image_size || '1K',
          number_of_images: v.number_of_images || 1,
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
