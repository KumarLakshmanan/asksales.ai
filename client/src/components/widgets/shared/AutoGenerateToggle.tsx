"use client";

/**
 * AutoGenerateToggle
 * Toggle with collapsible settings for auto-generating images/videos.
 */

import type { VideoCapabilities } from '../../../../../shared/videoSettings';
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ImageSettingsGroup } from "./ImageSettingsGroup";
import { VideoSettingsGroup } from "./VideoSettingsGroup";

interface AutoGenerateToggleProps {
  type: 'image' | 'video';
  capabilities?: VideoCapabilities;
  provider?: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  settings: Record<string, unknown>;
  onSettingsChange: (settings: Record<string, unknown>) => void;
  label?: string;
}

export function AutoGenerateToggle({
  type,
  capabilities,
  provider,
  enabled,
  onEnabledChange,
  settings,
  onSettingsChange,
  label,
}: AutoGenerateToggleProps) {
  const [isOpen, setIsOpen] = useState(false);

  const displayLabel = label || (type === 'image' ? 'Auto-generate Image' : 'Auto-generate Video');

  return (
    <div className="space-y-2 rounded-[10px] border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-xs font-medium">{displayLabel}</Label>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Creates and stores a separate {type} asset with the ad copy.</p>
        </div>
        <Switch checked={enabled} onCheckedChange={onEnabledChange} />
      </div>

      {enabled && (
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {type === 'image' ? 'Image Settings' : 'Video Settings'}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            {type === 'image' ? (
              <ImageSettingsGroup
                values={{
                  aspect_ratio: settings.image_aspect_ratio as string,
                  image_size: settings.image_size as string,
                  number_of_images: settings.image_count as number,
                  style: settings.image_style as string,
                }}
                onChange={(v) => onSettingsChange({
                  ...settings,
                  image_aspect_ratio: v.aspect_ratio,
                  image_size: v.image_size,
                  image_count: v.number_of_images,
                  image_style: v.style,
                })}
              />
            ) : (
              <VideoSettingsGroup
                capabilities={capabilities}
                provider={provider}
                values={{
                  aspect_ratio: settings.video_aspect_ratio as string,
                  duration_seconds: settings.video_duration_seconds as number,
                  number_of_videos: settings.video_count as number,
                  video_resolution: settings.video_resolution as string,
                  style: settings.video_style as string,
                }}
                onChange={(v) => onSettingsChange({
                  ...settings,
                  video_aspect_ratio: v.aspect_ratio,
                  video_duration_seconds: v.duration_seconds,
                  video_count: v.number_of_videos,
                  video_resolution: v.video_resolution,
                  video_style: v.style,
                })}
              />
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
