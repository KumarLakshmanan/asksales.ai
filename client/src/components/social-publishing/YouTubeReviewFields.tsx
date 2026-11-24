"use client";

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { YouTubeReviewSettings } from '@/lib/youtubePublishing';
import { Textarea } from '@/components/ui/textarea';
import { useState } from 'react';

export function YouTubeReviewFields({ value, onChange, idPrefix = 'youtube', hideTags = false }: {
  value: YouTubeReviewSettings;
  onChange: (patch: Partial<YouTubeReviewSettings>) => void;
  idPrefix?: string;
  hideTags?: boolean;
}) {
  const [chapterText, setChapterText] = useState(() => (value.chapters || []).map(chapter => `${Math.floor(chapter.startSeconds / 60)}:${String(chapter.startSeconds % 60).padStart(2, '0')} ${chapter.title}`).join('\n'));
  return <div className="space-y-4 rounded-xl border bg-muted/15 p-4">
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2"><Label htmlFor={`${idPrefix}-visibility`}>YouTube visibility</Label>
        <Select value={value.privacyStatus} onValueChange={privacyStatus => onChange({ privacyStatus: privacyStatus as YouTubeReviewSettings['privacyStatus'] })}>
          <SelectTrigger id={`${idPrefix}-visibility`}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="private">Private</SelectItem><SelectItem value="unlisted">Unlisted</SelectItem><SelectItem value="public">Public</SelectItem></SelectContent>
        </Select>
      </div>
      {!hideTags && <div className="space-y-2"><Label htmlFor={`${idPrefix}-tags`}>YouTube tags</Label><Input id={`${idPrefix}-tags`} value={value.tags} onChange={event => onChange({ tags: event.target.value })} placeholder="tutorial, product demo" /><p className="text-xs text-muted-foreground">Separate tags with commas.</p></div>}
      <div className="space-y-2"><Label htmlFor={`${idPrefix}-kids`}>Made for kids?</Label>
        <Select value={value.madeForKids === undefined ? '' : String(value.madeForKids)} onValueChange={answer => onChange({ madeForKids: answer === 'true' })}>
          <SelectTrigger id={`${idPrefix}-kids`}><SelectValue placeholder="Choose the intended audience" /></SelectTrigger>
          <SelectContent><SelectItem value="false">No, not made for kids</SelectItem><SelectItem value="true">Yes, made for kids</SelectItem></SelectContent>
        </Select>
      </div>
      <div className="space-y-2"><Label htmlFor={`${idPrefix}-synthetic`}>Realistic altered or synthetic content?</Label>
        <Select value={value.containsSyntheticMedia === undefined ? '' : String(value.containsSyntheticMedia)} onValueChange={answer => onChange({ containsSyntheticMedia: answer === 'true' })}>
          <SelectTrigger id={`${idPrefix}-synthetic`}><SelectValue placeholder="Review the disclosure" /></SelectTrigger>
          <SelectContent><SelectItem value="false">No disclosure needed</SelectItem><SelectItem value="true">Yes, disclose altered content</SelectItem></SelectContent>
        </Select>
      </div>
    </div>
    <details className="space-y-3"><summary className="cursor-pointer text-sm font-medium">More YouTube settings</summary><div className="grid gap-3 pt-3 sm:grid-cols-2">
      <div className="space-y-2"><Label htmlFor={`${idPrefix}-thumbnail`}>Thumbnail image URL</Label><Input id={`${idPrefix}-thumbnail`} type="url" value={value.thumbnailUrl || ''} onChange={event => onChange({ thumbnailUrl: event.target.value })} placeholder="https://…" /></div>
      <div className="space-y-2"><Label htmlFor={`${idPrefix}-playlist`}>Playlist ID</Label><Input id={`${idPrefix}-playlist`} value={value.playlistId || ''} onChange={event => onChange({ playlistId: event.target.value })} placeholder="Optional playlist owned by your channel" /></div>
      <div className="space-y-2"><Label htmlFor={`${idPrefix}-category`}>Category</Label><Select value={value.categoryId || '22'} onValueChange={categoryId => onChange({ categoryId })}><SelectTrigger id={`${idPrefix}-category`}><SelectValue /></SelectTrigger><SelectContent>{[['22','People & Blogs'],['27','Education'],['28','Science & Technology'],['24','Entertainment'],['26','Howto & Style'],['20','Gaming'],['10','Music'],['17','Sports'],['25','News & Politics']].map(([id,label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-2"><Label htmlFor={`${idPrefix}-language`}>Language code</Label><Input id={`${idPrefix}-language`} value={value.defaultLanguage || ''} onChange={event => onChange({ defaultLanguage: event.target.value })} placeholder="en-IN" /></div>
      <div className="space-y-2"><Label htmlFor={`${idPrefix}-license`}>License</Label><Select value={value.license || 'youtube'} onValueChange={license => onChange({ license: license as YouTubeReviewSettings['license'] })}><SelectTrigger id={`${idPrefix}-license`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="youtube">Standard YouTube license</SelectItem><SelectItem value="creativeCommon">Creative Commons attribution</SelectItem></SelectContent></Select></div>
    </div><div className="space-y-2"><Label htmlFor={`${idPrefix}-chapters`}>Chapters</Label><Textarea id={`${idPrefix}-chapters`} value={chapterText} placeholder={'0:00 Introduction\n0:30 Overview\n1:00 Next steps'} onChange={event => { setChapterText(event.target.value); onChange({ chapters: event.target.value.trim() ? event.target.value.split('\n').filter(line => line.trim()).map(line => { const match = line.match(/^(?:(\d+):)?(\d+):(\d{2})\s+(.+)$/); return match ? { startSeconds: Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]), title: match[4] } : { startSeconds: -1, title: line }; }) : undefined }); }} /><p className="text-xs text-muted-foreground">One timestamp and title per line. At least three chapters, beginning at 0:00 and spaced ten seconds apart.</p></div></details>
    <p className="text-xs text-muted-foreground">Shorts require a square or vertical video, up to 3 minutes. YouTube determines the final classification. Community posts are not supported here.</p>
  </div>;
}
