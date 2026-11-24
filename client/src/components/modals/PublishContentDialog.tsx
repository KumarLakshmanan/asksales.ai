"use client";

import { SocialPublisher } from '@/components/social-publishing/SocialPublisher';

interface PublishContentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: number;
  assetTitle?: string;
  assetType?: string;
  defaultCaption?: string;
  hasVideo?: boolean;
  hasImage?: boolean;
  onPublished?: (result: { platform: 'instagram' | 'facebook' | 'youtube' | 'linkedin' | 'twitter'; postUrl?: string }) => void;
}

/** Compatibility entry point: all saved content uses the same reviewed publisher. */
export default function PublishContentDialog({ open, onOpenChange, assetId, assetType, defaultCaption, onPublished }: PublishContentDialogProps) {
  return <SocialPublisher assetId={assetId} open={open} onOpenChange={onOpenChange} initialCaption={defaultCaption} initialPlatform={assetType === 'video' ? 'youtube' : undefined} onPublished={result => {
    if (result?.scheduled || result?.accepted) return;
    const entries = Object.entries(result?.results || {});
    const first = entries.find(([, entry]) => entry.success) || entries[0];
    if (first) onPublished?.({ platform: first[0] as 'instagram' | 'facebook' | 'youtube', postUrl: first[1].postUrl });
  }} />;
}
