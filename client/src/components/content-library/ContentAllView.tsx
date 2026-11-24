"use client";
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useContentCounts } from '@/hooks/use-content-counts';
import { tabConfig, getTabIcon, ContentTabType, ContentAsset } from './types';
import { TemplatesGridSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { LoadingState } from '@/components/ui/loading-state';
import { Callout } from '@/components/ui/callout';
import { normalizeUploadUrl } from '@/lib/utils';
import { buildContentMedia, uniqueMediaUrls } from '@/lib/contentMedia';
import {
  Image, Video, Mail, MessageSquare, Share2, Megaphone, FileText,
  LayoutGrid, List, Clock, Eye, Trash2, Send, CheckCircle2, ExternalLink
} from 'lucide-react';
import PublishContentDialog from '@/components/modals/PublishContentDialog';

// Helper to extract image URL from content asset
function extractImageUrl(asset: ContentAsset): string | undefined {
  const directImage = buildContentMedia(asset).imageUrls[0];
  if (directImage) return directImage;
  try {
    const parsed = JSON.parse(asset.content);
    return uniqueMediaUrls(parsed.imageUrls, parsed.imageUrl, parsed.image_url)[0];
  } catch {
    if (asset.content?.startsWith('data:') || asset.content?.startsWith('http') || asset.content?.startsWith('/uploads/') || asset.content?.startsWith('/api/uploads/')) {
      return asset.content;
    }
    return undefined;
  }
}

function getMediaCounts(asset: ContentAsset): { imageCount: number; videoCount: number } {
  const imageCount = new Set([...(asset.imageUrl ? [asset.imageUrl] : []), ...(asset.imageUrls || [])].filter(Boolean)).size;
  const videoCount = new Set([...(asset.videoUrl ? [asset.videoUrl] : []), ...(asset.videoUrls || [])].filter(Boolean)).size;
  return { imageCount, videoCount };
}

// Type icon and color mapping
function getTypeIcon(type: string) {
  switch (type) {
    case 'image': return { Icon: Image, bg: 'bg-blue-100 dark:bg-blue-950/40', color: 'text-blue-500', label: 'Image', badge: 'bg-blue-500/80' };
    case 'video': return { Icon: Video, bg: 'bg-purple-100 dark:bg-purple-950/40', color: 'text-purple-500', label: 'Video', badge: 'bg-purple-500/80' };
    case 'email_template': return { Icon: Mail, bg: 'bg-green-100 dark:bg-green-950/40', color: 'text-green-500', label: 'Email', badge: 'bg-green-500/80' };
    case 'sms_template': return { Icon: MessageSquare, bg: 'bg-amber-100 dark:bg-amber-950/40', color: 'text-amber-500', label: 'SMS', badge: 'bg-amber-500/80' };
    case 'social_post': return { Icon: Share2, bg: 'bg-violet-100 dark:bg-violet-950/40', color: 'text-violet-500', label: 'Social', badge: 'bg-violet-500/80' };
    case 'social_dm': return { Icon: MessageSquare, bg: 'bg-cyan-100 dark:bg-cyan-950/40', color: 'text-cyan-500', label: 'DM', badge: 'bg-cyan-500/80' };
    case 'ad_copy': return { Icon: Megaphone, bg: 'bg-orange-100 dark:bg-orange-950/40', color: 'text-orange-500', label: 'Ad', badge: 'bg-orange-500/80' };
    case 'blog_post': return { Icon: FileText, bg: 'bg-teal-100 dark:bg-teal-950/40', color: 'text-teal-500', label: 'Blog', badge: 'bg-teal-500/80' };
    default: return { Icon: FileText, bg: 'bg-gray-100 dark:bg-gray-800', color: 'text-gray-500', label: type, badge: 'bg-gray-500/80' };
  }
}

// Mode: "cards" = flat grid, "overview" = category tiles
interface CardsViewProps {
  mode: 'cards';
  allAssets?: ContentAsset[];
  onDeleteAsset?: (id: number) => void;
  onPreviewAsset?: (asset: ContentAsset) => void;
  loadingCounts?: boolean;
  threadId?: never;
  onTabChange?: never;
}

interface OverviewViewProps {
  mode: 'overview';
  threadId?: number;
  onTabChange?: (tab: ContentTabType) => void;
  loadingCounts?: boolean;
  contentCounts?: Record<string, number>;
  allAssets?: never;
  onDeleteAsset?: never;
  onPreviewAsset?: never;
}

type ContentAllViewProps = CardsViewProps | OverviewViewProps;

export default function ContentAllView(props: ContentAllViewProps) {
  if (props.mode === 'overview') {
    return <OverviewView key={props.threadId ?? 'all'} threadId={props.threadId} onTabChange={props.onTabChange} contentCounts={props.contentCounts} loading={props.loadingCounts} />;
  }
  return <CardsView allAssets={props.allAssets ?? []} onDeleteAsset={props.onDeleteAsset} onPreviewAsset={props.onPreviewAsset} loadingCounts={props.loadingCounts} />;
}

/** Cards grid view – Windows File Manager style – used by SavedTemplatesPage */
function CardsView({ allAssets, onDeleteAsset, onPreviewAsset, loadingCounts }: { allAssets: ContentAsset[]; onDeleteAsset?: (id: number) => void; onPreviewAsset?: (asset: ContentAsset) => void; loadingCounts?: boolean }) {
  const router = useRouter();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [publishTarget, setPublishTarget] = useState<ContentAsset | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  // Track items published during this session for immediate badge display
  const [publishedIds, setPublishedIds] = useState<Set<number>>(new Set());

  if (loadingCounts) {
    return (
      <div className="p-6">
        <TemplatesGridSkeleton count={8} />
      </div>
    );
  }

  const filteredAssets = (filterType === 'all' ? allAssets : allAssets.filter(a => a.type === filterType))
    .map(a => publishedIds.has(a.id) && !a.publishedAt ? { ...a, publishedAt: new Date().toISOString() } : a);

  // Count by type
  const typeCounts: Record<string, number> = {};
  allAssets.forEach(a => { typeCounts[a.type] = (typeCounts[a.type] || 0) + 1; });
  const uniqueTypes = Object.keys(typeCounts);

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex flex-col gap-2 border-b bg-card px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
        <div className="min-w-0 overflow-x-auto">
          <div className="flex w-max overflow-hidden rounded-lg border">
            <button
              className={`px-3 py-2 text-sm font-medium transition-colors ${filterType === 'all' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              onClick={() => setFilterType('all')}
            >
              All ({allAssets.length})
            </button>
            {uniqueTypes.map(type => {
              const info = getTypeIcon(type);
              return (
                <button
                  key={type}
                  className={`flex items-center gap-1 border-l px-3 py-2 text-sm font-medium transition-colors ${filterType === type ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                  onClick={() => setFilterType(type)}
                >
                  <info.Icon className="w-3 h-3" /> {info.label} ({typeCounts[type]})
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-1.5 self-end sm:self-auto">
          <div className="flex border rounded-lg overflow-hidden">
            <button
              className={`p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-muted' : 'hover:bg-muted/50'}`}
              onClick={() => setViewMode('grid')}
              title="Thumbnail view"
              aria-label="Use thumbnail view"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              className={`p-1.5 border-l transition-colors ${viewMode === 'list' ? 'bg-muted' : 'hover:bg-muted/50'}`}
              onClick={() => setViewMode('list')}
              title="Details view"
              aria-label="Use details view"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="border-b bg-muted/30 px-4 py-2 text-sm text-muted-foreground">
        <span>{filteredAssets.length} items</span>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto bg-background p-3">
        {filteredAssets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <p className="text-lg font-medium">No content yet</p>
            <p className="text-sm mt-1">Generate content from the Chat or switch to a category tab above</p>
          </div>
        ) : viewMode === 'grid' ? (
          /* ── Thumbnail Grid View ── */
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {filteredAssets.map((asset) => {
              const info = getTypeIcon(asset.type);
              const imageUrl = extractImageUrl(asset);
              const { imageCount, videoCount } = getMediaCounts(asset);
              const totalMedia = imageCount + videoCount;

              return (
                <div
                  key={asset.id}
                  className="group relative flex flex-col items-center cursor-pointer rounded-lg p-1.5 hover:bg-accent transition-colors"
                  onClick={() => onPreviewAsset?.(asset)}
                >
                  {/* Thumbnail */}
                  <div className="relative w-full aspect-square rounded-md overflow-hidden bg-muted border border-border/50">
                    {imageUrl ? (
                      <img
                        src={normalizeUploadUrl(imageUrl)}
                        alt={asset.title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className={`w-full h-full flex flex-col items-center justify-center gap-1 ${info.bg}`}>
                        <info.Icon className={`w-8 h-8 ${info.color}`} />
                        <span className={`text-xs font-medium ${info.color}`}>{info.label}</span>
                      </div>
                    )}
                    {/* Type badge overlay */}
                    <div className={`absolute left-1 top-1 rounded px-1.5 py-0.5 text-xs font-medium text-white ${info.badge}`}>
                      {info.label}
                    </div>
                    {/* Published badge */}
                    {asset.publishedAt && (
                      <div aria-label="Published" className="absolute right-1 top-1 flex items-center gap-0.5 rounded bg-green-600 px-1.5 py-0.5 text-xs font-medium text-white">
                        <CheckCircle2 className="w-2.5 h-2.5" />
                      </div>
                    )}
                    {/* Media count badge */}
                    {totalMedia > 0 && (
                      <div className="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
                        {imageCount > 0 && <span className="flex items-center gap-0.5"><Image className="w-2.5 h-2.5" />{imageCount}</span>}
                        {videoCount > 0 && <span className="flex items-center gap-0.5"><Video className="w-2.5 h-2.5" />{videoCount}</span>}
                      </div>
                    )}
                    {/* Hover overlay with actions */}
                    <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/40 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      <button
                        className="p-1.5 bg-white/90 rounded-full hover:bg-white transition-colors"
                        title="Preview"
                        aria-label={`Preview ${asset.title}`}
                        onClick={(e) => { e.stopPropagation(); onPreviewAsset?.(asset); }}
                      >
                        <Eye className="w-3.5 h-3.5 text-gray-700" />
                      </button>
                      {asset.publishedAt && asset.publishedUrl && (
                        <a
                          href={asset.publishedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-full bg-white/90 p-1.5 transition-colors hover:bg-white"
                          title="View provider post"
                          aria-label={`View published ${asset.title}`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <ExternalLink className="h-3.5 w-3.5 text-gray-700" />
                        </a>
                      )}
                      {!asset.publishedAt && (asset.type === 'social_post' || asset.type === 'video') && (
                        <button
                          className="rounded-full bg-primary p-1.5 text-primary-foreground transition-colors hover:bg-primary/90"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (asset.type === 'social_post') {
                              let cap = asset.content;
                              try {
                                const parsed = JSON.parse(asset.content);
                                cap = parsed.caption || parsed.body || parsed.text || parsed.message || asset.content;
                              } catch { /* not JSON */ }
                              router.push(`/dashboard/saved-templates/social/publish?assetId=${asset.id}&caption=${encodeURIComponent(cap)}&from=${encodeURIComponent(window.location.pathname)}`);
                            } else {
                              setPublishTarget(asset);
                            }
                          }}
                          title="Publish to social"
                          aria-label={`Publish ${asset.title}`}
                        >
                          <Send className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {onDeleteAsset && !asset.publishedAt && (
                        <button
                          className="p-1.5 bg-white/90 rounded-full hover:bg-red-100 transition-colors"
                          onClick={(e) => { e.stopPropagation(); onDeleteAsset(asset.id); }}
                          title="Delete"
                          aria-label={`Delete ${asset.title}`}
                        >
                          <Trash2 className="w-3.5 h-3.5 text-red-600" />
                        </button>
                      )}
                    </div>
                  </div>
                  {/* File name */}
                  <span className="mt-1 line-clamp-2 w-full px-0.5 text-center text-sm leading-snug text-foreground">
                    {asset.title}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          /* ── List/Details View ── */
          <div className="overflow-x-auto rounded-lg border">
            <div className="min-w-[760px]">
            {/* Table header */}
            <div className="grid grid-cols-[40px_1fr_90px_90px_100px_140px_60px] gap-2 px-3 py-2 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
              <span></span>
              <span>Name</span>
              <span>Type</span>
              <span>Status</span>
              <span>Channel</span>
              <span>Date</span>
              <span>Actions</span>
            </div>
            {/* Rows */}
            {filteredAssets.map((asset) => {
              const info = getTypeIcon(asset.type);
              const imageUrl = extractImageUrl(asset);

              return (
                <div
                  key={asset.id}
                  className="group grid grid-cols-[40px_1fr_90px_90px_100px_140px_60px] gap-2 px-3 py-1.5 items-center hover:bg-accent transition-colors cursor-pointer border-b border-border/30 last:border-b-0"
                  onClick={() => onPreviewAsset?.(asset)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPreviewAsset?.(asset); } }}
                >
                  {/* Mini thumbnail */}
                  <div className="w-8 h-8 rounded overflow-hidden bg-muted flex-shrink-0">
                    {imageUrl ? (
                      <img src={normalizeUploadUrl(imageUrl)} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className={`w-full h-full flex items-center justify-center ${info.bg}`}>
                        <info.Icon className={`w-4 h-4 ${info.color}`} />
                      </div>
                    )}
                  </div>
                  {/* Name */}
                  <span className="text-sm truncate">{asset.title}</span>
                  {/* Type */}
                  <Badge variant="outline" className="text-xs w-fit">{info.label}</Badge>
                  {/* Status */}
                  {asset.publishedAt ? (
                    <span className="flex items-center gap-1 text-xs text-green-500 font-medium truncate">
                      <CheckCircle2 className="w-3 h-3 flex-shrink-0" /> Published
                    </span>
                  ) : (
                    <span
                      className={asset.status === 'failed' ? "truncate text-xs text-destructive" : "truncate text-xs text-muted-foreground"}
                      title={asset.lastError || undefined}
                    >
                      {asset.status === 'scheduled' && asset.retryCount
                        ? `retry ${asset.retryCount}`
                        : asset.status || '—'}
                    </span>
                  )}
                  {/* Channel */}
                  <span className="text-xs text-muted-foreground truncate">{asset.channel || '—'}</span>
                  {/* Date */}
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(asset.createdAt).toLocaleDateString()}
                  </span>
                  {/* Actions */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {asset.publishedAt && asset.publishedUrl && (
                      <a
                        href={asset.publishedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded p-1 hover:bg-muted"
                        title="View provider post"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <ExternalLink className="h-3.5 w-3.5 text-emerald-600" />
                      </a>
                    )}
                    {!asset.publishedAt && (asset.type === 'social_post' || asset.type === 'video') && (
                      <button
                        className="p-1 hover:bg-violet-100 dark:hover:bg-violet-950/30 rounded"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (asset.type === 'social_post') {
                            let cap = asset.content;
                            try {
                              const parsed = JSON.parse(asset.content);
                              cap = parsed.caption || parsed.body || parsed.text || parsed.message || asset.content;
                            } catch { /* not JSON */ }
                            router.push(`/dashboard/saved-templates/social/publish?assetId=${asset.id}&caption=${encodeURIComponent(cap)}&from=${encodeURIComponent(window.location.pathname)}`);
                          } else {
                            setPublishTarget(asset);
                          }
                        }}
                        title="Publish"
                      >
                        <Send className="w-3.5 h-3.5 text-violet-600" />
                      </button>
                    )}
                    {onDeleteAsset && !asset.publishedAt && (
                      <button
                        className="p-1 hover:bg-red-100 dark:hover:bg-red-950/30 rounded"
                        onClick={(e) => { e.stopPropagation(); onDeleteAsset(asset.id); }}
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-red-500" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            </div>
          </div>
        )}
      </div>

      {/* Publish Dialog */}
      {publishTarget && (
        <PublishContentDialog
          open={!!publishTarget}
          onOpenChange={(open) => { if (!open) setPublishTarget(null); }}
          assetId={publishTarget.id}
          assetTitle={publishTarget.title}
          assetType={publishTarget.type}
          hasImage={!!(publishTarget.imageUrl || (publishTarget.imageUrls && publishTarget.imageUrls.length > 0))}
          hasVideo={!!(publishTarget.videoUrl || (publishTarget.videoUrls && publishTarget.videoUrls.length > 0))}
          onPublished={() => {
            if (publishTarget) setPublishedIds(prev => new Set(prev).add(publishTarget.id));
            setPublishTarget(null);
          }}
        />
      )}
    </div>
  );
}

/** Overview tiles view – used by ContentStudioTab */
type OverviewProps = { threadId?: number; onTabChange?: (tab: ContentTabType) => void; contentCounts?: Record<string, number>; loading?: boolean };
function OverviewView(props: OverviewProps) {
  return props.contentCounts ? <OverviewTiles {...props} contentCounts={props.contentCounts} /> : <FetchedOverview {...props} />;
}
function FetchedOverview(props: OverviewProps) {
  const query = useContentCounts(props.threadId);
  return <OverviewTiles {...props} contentCounts={query.counts} loading={query.isLoading} loadError={query.isError} onRetry={() => void query.refetch()} />;
}
function OverviewTiles({ threadId, onTabChange, contentCounts, loading, loadError, onRetry }: OverviewProps & { contentCounts: Record<string, number>; loadError?: boolean; onRetry?: () => void }) {
  if (loading) {
    return (
      <LoadingState aria-label="Loading content library" label="Loading content library…" className="h-64" />
    );
  }

  return (
    <div className="h-full min-w-0 overflow-auto p-4">
      <div className="mb-4 border-b pb-4">
        <h3 className="text-sm font-semibold">{threadId ? 'Your campaign library' : 'Your content library'}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Open a content type to review saved work, edit a draft, or create something new.</p>
      </div>
      {loadError && (
        <Callout
          tone="danger"
          size="sm"
          className="mb-4"
          actions={<button type="button" className="underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring" onClick={onRetry}>Retry counts</button>}
        >
          Saved content counts could not be loaded. You can still open a library below.
        </Callout>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
        {tabConfig.slice(1).map((tab) => (
          <button
            type="button"
            key={tab.id}
            className="min-w-0 text-left p-4 rounded-xl border bg-card hover:border-primary/50 hover:bg-primary/5 transition-colors motion-reduce:transition-none cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onTabChange?.(tab.id)}
          >
            <div className="flex items-center justify-between mb-3">
              <div className={`p-2 rounded-lg ${tab.bgColor} ${tab.darkBgColor} ${tab.color} ${tab.darkColor}`}>
                {getTabIcon(tab)}
              </div>
              <div className="w-5 h-5 text-muted-foreground group-hover:text-foreground transition-colors">
                →
              </div>
            </div>
            <p className="text-sm font-semibold mb-1">{tab.label}</p>
            <p className="text-sm text-muted-foreground">
              <span className={`font-bold ${tab.textColor} ${tab.darkTextColor}`}>
                {contentCounts[tab.id] ?? '—'}
              </span>
              {' '}saved
            </p>
          </button>
        ))}
      </div>
      <div className="mt-6 text-center text-muted-foreground">
        <span className="font-semibold text-foreground">{contentCounts['all'] ?? '—'}</span>
        {' '}total content items
        {threadId && <span className="ml-2 text-xs">(filtered by current chat)</span>}
      </div>
    </div>
  );
}
