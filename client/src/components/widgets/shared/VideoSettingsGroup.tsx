"use client";

/**
 * VideoSettingsGroup
 * Reusable sub-component for video generation settings.
 */

import { GOOGLE_VIDEO_CAPABILITIES, type VideoCapabilities } from "../../../../../shared/videoSettings";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

interface VideoSettingsGroupProps {
  values: {
    aspect_ratio?: string;
    duration_seconds?: number;
    number_of_videos?: number;
    person_generation?: string;
    video_resolution?: string;
    generate_audio?: boolean;
    style?: string;
  };
  onChange: (values: {
    aspect_ratio?: string;
    duration_seconds?: number;
    number_of_videos?: number;
    person_generation?: string;
    video_resolution?: string;
    generate_audio?: boolean;
    style?: string;
  }) => void;
  capabilities?: VideoCapabilities;
  provider?: string;
  showCount?: boolean;
  showPersonGeneration?: boolean;
  showStyle?: boolean;
  showAudio?: boolean;
}

const VIDEO_STYLES = [
  { value: 'cinematic', label: 'Cinematic' },
  { value: 'promotional', label: 'Promotional' },
  { value: 'explainer', label: 'Explainer' },
  { value: 'social-media', label: 'Social Media' },
  { value: 'product-demo', label: 'Product Demo' },
  { value: 'animated', label: 'Animated' },
];

export function VideoSettingsGroup({
  values,
  onChange,
  capabilities = GOOGLE_VIDEO_CAPABILITIES,
  provider = "google",
  showCount = true,
  showPersonGeneration = true,
  showStyle = true,
  showAudio = true,
}: VideoSettingsGroupProps) {
  const durations = provider === 'google' && values.video_resolution === '1080p' ? [8] : capabilities.durations || [4, 6, 8];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Aspect Ratio</Label>
          <Select
            value={values.aspect_ratio || '16:9'}
            onValueChange={(v) => onChange({ ...values, aspect_ratio: v })}
          >
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(capabilities.aspectRatios || ['16:9', '9:16']).map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Resolution</Label>
          <Select
            value={values.video_resolution || '720p'}
            onValueChange={(v) => onChange({ ...values, video_resolution: v, ...(provider === 'google' && v === '1080p' ? { duration_seconds: 8 } : {}) })}
          >
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(capabilities.resolutions || ['720p', '1080p']).map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}
              {values.video_resolution && !(capabilities.resolutions || ['720p', '1080p']).includes(values.video_resolution) && <SelectItem value={values.video_resolution} disabled>{values.video_resolution} (unsupported)</SelectItem>}
            </SelectContent>
          </Select>
        </div>
      </div>

      {showStyle && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Style</Label>
          <Select
            value={values.style || 'cinematic'}
            onValueChange={(v) => onChange({ ...values, style: v })}
          >
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VIDEO_STYLES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">
          Duration: {values.duration_seconds || 8}s
        </Label>
        <Select value={String(values.duration_seconds || 8)} onValueChange={v => onChange({ ...values, duration_seconds: Number(v) })}>
          <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{durations.map(value => <SelectItem key={value} value={String(value)}>{value}s</SelectItem>)}
            {values.duration_seconds && !durations.includes(values.duration_seconds) && <SelectItem value={String(values.duration_seconds)} disabled>{values.duration_seconds}s (unsupported)</SelectItem>}
          </SelectContent>
        </Select>
      </div>

      {showPersonGeneration && (
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Allow People</Label>
          <Switch
            checked={values.person_generation !== 'dont_allow'}
            onCheckedChange={(checked) =>
              onChange({ ...values, person_generation: checked ? 'allow_adult' : 'dont_allow' })
            }
          />
        </div>
      )}

      {showAudio && (
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Generate Audio</Label>
          <Switch
            checked={values.generate_audio === true}
            onCheckedChange={(checked) => onChange({ ...values, generate_audio: checked })}
          />
        </div>
      )}

      {showCount && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">
            Number of Videos: {values.number_of_videos || 1}
          </Label>
          {(capabilities.maxOutputs || 1) > 1 && <Slider
            value={[values.number_of_videos || 1]}
            onValueChange={([v]) => onChange({ ...values, number_of_videos: v })}
            min={1}
            max={capabilities.maxOutputs || 1}
            step={1}
            className="w-full"
          />}
        </div>
      )}
    </div>
  );
}
