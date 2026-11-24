"use client";

/**
 * AdGenerationWidget
 * Interactive widget for ad copy generation.
 */

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PlatformCards, PLATFORM_SETS, ToneSelector, TONE_OPTIONS, AutoGenerateToggle } from "./shared";
import type { WidgetProps } from "./types";

export function AdGenerationWidget(props: WidgetProps) {
  return <AdGenerationWidgetEditor key={`${props.widget.id}:${JSON.stringify(props.widget.formValues)}`} {...props} />;
}

function AdGenerationWidgetEditor({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    ...(widget.formValues.creative_brief_id ? {
      creative_brief_id: widget.formValues.creative_brief_id,
      creative_brief_revision: widget.formValues.creative_brief_revision,
      creative_concept_id: widget.formValues.creative_concept_id,
    } : {}),
    platform: (widget.formValues.platform as string) || 'meta',
    objective: (widget.formValues.objective as string) || 'traffic',
    ad_format: (widget.formValues.ad_format as string) || 'image',
    number_of_variations: (widget.formValues.number_of_variations as number) || 1,
    headline: (widget.formValues.headline as string) || '',
    description_text: (widget.formValues.description_text as string) || '',
    cta_text: (widget.formValues.cta_text as string) || '',
    content_instructions: (widget.formValues.content_instructions as string) || '',
    landing_url: (widget.formValues.landing_url as string) || '',
    include_image_prompt: widget.formValues.include_image_prompt === true,
    include_video_prompt: widget.formValues.include_video_prompt === true,
    tone: (widget.formValues.tone as string) || 'professional',
    language: (widget.formValues.language as string) || 'English',
    target_audience: (widget.formValues.target_audience as string) || '',
    cta_type: (widget.formValues.cta_type as string) || 'learn_more',
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
    const { landing_url, ...fields } = form;
    onFormChange({ ...fields, ...(landing_url.trim() ? { landing_url } : {}) });
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
        platforms={PLATFORM_SETS.ad}
      />

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Campaign Objective</Label>
        <Select value={form.objective} onValueChange={(v) => updateField('objective', v)}>
          <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="awareness">Awareness</SelectItem>
            <SelectItem value="traffic">Website Traffic</SelectItem>
            <SelectItem value="engagement">Engagement</SelectItem>
            <SelectItem value="leads">Lead Generation</SelectItem>
            <SelectItem value="sales">Sales</SelectItem>
            <SelectItem value="app_installs">App Installs</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Ad Format</Label>
          <Select value={form.ad_format} onValueChange={(v) => updateField('ad_format', v)}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="image">Image</SelectItem>
              <SelectItem value="video">Video</SelectItem>
              <SelectItem value="carousel">Carousel</SelectItem>
              <SelectItem value="text">Text Only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">CTA Button</Label>
          <Select value={form.cta_type} onValueChange={(v) => updateField('cta_type', v)}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!['learn_more', 'shop_now', 'sign_up', 'book_now', 'contact_us', 'download'].includes(form.cta_type) && (
                <SelectItem value={form.cta_type} disabled>Unsupported: {form.cta_type} — choose a button</SelectItem>
              )}
              <SelectItem value="learn_more">Learn More</SelectItem>
              <SelectItem value="shop_now">Shop Now</SelectItem>
              <SelectItem value="sign_up">Sign Up</SelectItem>
              <SelectItem value="book_now">Book Now</SelectItem>
              <SelectItem value="contact_us">Contact Us</SelectItem>
              <SelectItem value="download">Download</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`ad-variations-${widget.id}`} className="text-xs font-medium">Ad-copy variations (1–5)</Label>
        <Input
          id={`ad-variations-${widget.id}`}
          type="number"
          min={1}
          max={5}
          step={1}
          value={form.number_of_variations}
          onChange={(event) => updateField('number_of_variations', Math.min(5, Math.max(1, Number(event.target.value) || 1)))}
          className="h-9 text-xs"
        />
        <p className="text-xs text-muted-foreground">This is the number of distinct copy drafts, separate from image and video counts.</p>
      </div>

      <ToneSelector
        value={form.tone}
        onChange={(v) => updateField('tone', v)}
        options={TONE_OPTIONS.ad}
      />

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Headline (optional)</Label>
        <Input
          value={form.headline}
          onChange={(e) => updateField('headline', e.target.value)}
          placeholder="Ad headline"
          className="h-9 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Description (optional)</Label>
        <Textarea
          value={form.description_text}
          onChange={(e) => updateField('description_text', e.target.value)}
          placeholder="Main ad text"
          className="min-h-[60px] text-sm"
        />
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
        <Label htmlFor={`ad-cta-${widget.id}`} className="text-xs font-medium">Exact copy CTA</Label>
        <Input id={`ad-cta-${widget.id}`} value={form.cta_text} onChange={(e) => updateField('cta_text', e.target.value)} className="text-sm" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`ad-constraints-${widget.id}`} className="text-xs font-medium">Content constraints</Label>
        <Textarea id={`ad-constraints-${widget.id}`} value={form.content_instructions} onChange={(e) => updateField('content_instructions', e.target.value)} className="text-sm" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`ad-destination-${widget.id}`} className="text-xs font-medium">Destination URL</Label>
        <p className="text-xs text-muted-foreground">Review this destination before generating. Ads must use the approved business domain.</p>
        <Input id={`ad-destination-${widget.id}`} value={form.landing_url} onChange={(e) => updateField('landing_url', e.target.value)} className="text-sm" />
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
