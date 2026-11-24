"use client";

import { useState } from 'react';
import api from '@/lib/api';
import { buildContentMedia } from '@/lib/contentMedia';
import type { SocialPublishingAsset } from '@/lib/socialPublishing';
import { normalizeUploadUrl } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type InstagramReviewSettings = { altText?: string; locationId?: string; collaborators?: string[]; shareToFeed?: boolean; coverUrl?: string; thumbOffset?: string };

export function InstagramReviewFields({ value, onChange, postType, idPrefix = 'instagram' }: { value: InstagramReviewSettings; onChange: (patch: Partial<InstagramReviewSettings>) => void; postType: string; idPrefix?: string }) {
  const [covers, setCovers] = useState<Array<{ url: string; title: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function loadCovers() {
    setLoading(true); setError('');
    try {
      const assets = await api.get<SocialPublishingAsset[]>('/api/content/assets?type=image');
      setCovers(assets.flatMap(asset => buildContentMedia(asset).imageUrls.map(url => ({ url: new URL(normalizeUploadUrl(url), window.location.origin).href, title: asset.title }))));
      if (!assets.length) setError('Create or upload an image in Content Library first.');
    } catch { setError('Images could not be loaded. Try again.'); } finally { setLoading(false); }
  }
  if (postType === 'story') return null;
  return <details className="mt-4 space-y-3"><summary className="cursor-pointer text-sm font-medium">More Instagram settings</summary><div className="grid gap-3 pt-3 sm:grid-cols-2">
    {postType === 'post' && <div className="space-y-2 sm:col-span-2"><Label htmlFor={`${idPrefix}-alt`}>Image alt text</Label><Input id={`${idPrefix}-alt`} maxLength={1000} value={value.altText || ''} onChange={event => onChange({ altText: event.target.value })} placeholder="Describe the image for people using screen readers" /></div>}
    <div className="space-y-2"><Label htmlFor={`${idPrefix}-location`}>Location ID</Label><Input id={`${idPrefix}-location`} value={value.locationId || ''} onChange={event => onChange({ locationId: event.target.value })} placeholder="Optional Facebook Place ID" /></div>
    <div className="space-y-2"><Label htmlFor={`${idPrefix}-collaborators`}>Collaborator usernames</Label><Input id={`${idPrefix}-collaborators`} defaultValue={(value.collaborators || []).join(', ')} onChange={event => onChange({ collaborators: event.target.value.split(',').map(name => name.trim().replace(/^@/, '')).filter(Boolean) })} placeholder="username, another_username" /><p className="text-xs text-muted-foreground">Collaborators must accept Instagram’s invitation.</p></div>
    {postType === 'reel' && <><div className="space-y-2 sm:col-span-2"><Label htmlFor={`${idPrefix}-feed`} className="flex items-center justify-between">Also share Reel to feed<Switch id={`${idPrefix}-feed`} checked={value.shareToFeed ?? true} onCheckedChange={shareToFeed => onChange({ shareToFeed })} /></Label></div>
      <div className="space-y-2"><Label htmlFor={`${idPrefix}-cover`}>Reel cover image</Label><Input id={`${idPrefix}-cover`} value={value.coverUrl || ''} onChange={event => onChange({ coverUrl: event.target.value })} placeholder="https://…" /><Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void loadCovers()}>{loading ? 'Loading images…' : 'Choose from Content Library'}</Button>{covers.length > 0 && <Select value={value.coverUrl || ''} onValueChange={coverUrl => onChange({ coverUrl })}><SelectTrigger aria-label="Cover from Content Library"><SelectValue placeholder="Choose saved image" /></SelectTrigger><SelectContent>{covers.map((cover, index) => <SelectItem key={`${cover.url}:${index}`} value={cover.url}>{cover.title || `Image ${index + 1}`}</SelectItem>)}</SelectContent></Select>}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}</div>
      <div className="space-y-2"><Label htmlFor={`${idPrefix}-offset`}>Thumbnail offset (seconds)</Label><Input id={`${idPrefix}-offset`} type="number" min="0" step="0.1" value={value.thumbOffset || ''} onChange={event => onChange({ thumbOffset: event.target.value })} /></div></>}
  </div></details>;
}
