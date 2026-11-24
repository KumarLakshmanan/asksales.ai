"use client";

/**
 * ImageSettingsGroup
 * Reusable sub-component for image generation settings.
 * Used in ImageGeneration, SocialPost, EmailTemplate, AdGeneration, etc.
 */

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useEffect, useState } from "react";
import api from "@/lib/api";

interface ImageSettingsGroupProps {
  values: {
    aspect_ratio?: string;
    image_size?: string;
    number_of_images?: number;
    style?: string;
  };
  onChange: (values: {
    aspect_ratio?: string;
    image_size?: string;
    number_of_images?: number;
    style?: string;
  }) => void;
  showCount?: boolean;
  compact?: boolean;
  showStyle?: boolean;
}

const ASPECT_RATIOS = [
  { value: '1:1', label: '1:1', description: 'Square' },
  { value: '16:9', label: '16:9', description: 'Landscape' },
  { value: '9:16', label: '9:16', description: 'Portrait' },
  { value: '4:3', label: '4:3', description: 'Standard' },
  { value: '3:4', label: '3:4', description: 'Tall' },
  { value: '3:2', label: '3:2', description: 'Photo' },
  { value: '2:3', label: '2:3', description: 'Photo Tall' },
  { value: '21:9', label: '21:9', description: 'Ultra-wide' },
];

const IMAGE_SIZES = [
  { value: '1K', label: '1K', description: '1024px' },
  { value: '2K', label: '2K', description: '2048px' },
  { value: '4K', label: '4K', description: '4096px' },
];

const IMAGE_STYLES = [
  { value: 'photorealistic', label: 'Photorealistic' },
  { value: 'digital-art', label: 'Digital Art' },
  { value: 'illustration', label: 'Illustration' },
  { value: '3d-render', label: '3D Render' },
  { value: 'watercolor', label: 'Watercolor' },
  { value: 'minimalist', label: 'Minimalist' },
  { value: 'cinematic', label: 'Cinematic' },
  { value: 'flat-design', label: 'Flat Design' },
];

type ImageModelOptions = { model: string; aspectRatios: string[] | null; resolutions: string[] | null };
let imageModelOptionsRequest: Promise<ImageModelOptions | undefined> | null = null;

/**
 * The configured model's real ratios and sizes (same endpoint as the Image
 * creator). Widgets render outside a QueryClient, so this is a shared promise.
 */
function useImageModelOptions() {
  const [options, setOptions] = useState<ImageModelOptions | undefined>();
  useEffect(() => {
    let active = true;
    imageModelOptionsRequest ??= Promise.resolve().then(() => api.get<ImageModelOptions>('/api/content/studio/image-options')).catch(() => {
      imageModelOptionsRequest = null;
      return undefined;
    });
    void imageModelOptionsRequest.then((value) => { if (active) setOptions(value); });
    return () => { active = false; };
  }, []);
  return options;
}

export function ImageSettingsGroup({ values, onChange, showCount = true, compact = false, showStyle = true }: ImageSettingsGroupProps) {
  const options = useImageModelOptions();
  const aspectRatios = options?.aspectRatios?.length
    ? ASPECT_RATIOS.filter((ratio) => options.aspectRatios?.includes(ratio.value))
    : ASPECT_RATIOS;
  // Never offer a size the model rejects (Seedream 5.0 Pro has no 4K); a model
  // without a size setting keeps 1K, which the server ignores for it.
  const imageSizes = options
    ? IMAGE_SIZES.filter((size) => options.resolutions?.includes(size.value)).concat(options.resolutions?.length ? [] : [IMAGE_SIZES[0]])
    : IMAGE_SIZES.filter((size) => size.value !== '4K');
  return (
    <div className={`space-y-3 ${compact ? 'space-y-2' : ''}`}>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Aspect Ratio</Label>
          <Select
            value={values.aspect_ratio || '1:1'}
            onValueChange={(v) => onChange({ ...values, aspect_ratio: v })}
          >
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {aspectRatios.map((ar) => (
                <SelectItem key={ar.value} value={ar.value}>
                  <span className="font-mono">{ar.label}</span>
                  <span className="text-muted-foreground ml-1">({ar.description})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Size</Label>
          <Select
            value={values.image_size || '1K'}
            onValueChange={(v) => onChange({ ...values, image_size: v })}
          >
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {imageSizes.map((size) => (
                <SelectItem key={size.value} value={size.value}>
                  {size.label}
                  <span className="text-muted-foreground ml-1">({size.description})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {showStyle && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Style</Label>
          <Select
            value={values.style || 'photorealistic'}
            onValueChange={(v) => onChange({ ...values, style: v })}
          >
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {IMAGE_STYLES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {showCount && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">
            Number of Images: {values.number_of_images || 1}
          </Label>
          <Slider
            value={[values.number_of_images || 1]}
            onValueChange={([v]) => onChange({ ...values, number_of_images: v })}
            min={1}
            max={4}
            step={1}
            className="w-full"
          />
        </div>
      )}
    </div>
  );
}
