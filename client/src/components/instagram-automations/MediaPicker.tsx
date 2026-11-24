'use client';
import { useEffect, useRef, useState } from 'react';
import { ImageIcon, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  type InstagramAutomationMedia,
} from '@/lib/instagram-automations';
import { Errors } from './Fields';
import { clearInstagramMediaCache, loadInstagramMediaPage } from './mediaCache';
export function MediaPicker({
  accountId,
  selected,
  onChange,
}: {
  accountId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [items, setItems] = useState<InstagramAutomationMedia[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const version = ++generation.current;
    setLoading(true);
    setItems([]);
    setCursor(null);
    setError('');
    loadInstagramMediaPage(accountId)
      .then((result) => {
        if (version === generation.current) {
          setItems(result.media);
          setCursor(result.nextCursor);
        }
      })
      .catch((cause) => {
        if (version === generation.current) setError(cause instanceof Error ? cause.message : 'Posts could not be loaded.');
      })
      .finally(() => {
        if (version === generation.current) setLoading(false);
      });
    return () => {
      generation.current += 1;
    };
  }, [accountId, refresh]);
  const loadMore = async () => {
    const version = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const result = await loadInstagramMediaPage(accountId, cursor);
      if (version !== generation.current) return;
      setItems((previous) => [
        ...previous,
        ...result.media.filter((item) => !previous.some((existing) => existing.id === item.id)),
      ]);
      setCursor(result.nextCursor);
    } catch (cause) {
      if (version === generation.current) setError(cause instanceof Error ? cause.message : 'Posts could not be loaded.');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };
  return (
    <div className="space-y-3">
      <Errors errors={error ? [error] : []} />
      <p className="text-xs text-muted-foreground">
        {selected.length} selected · Posts belong to this Instagram account.
      </p>
      <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => { clearInstagramMediaCache(accountId); setRefresh(value => value + 1); }}>Refresh posts</Button>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {items.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-label={`Select post ${item.caption?.slice(0, 60) || item.id}`}
            aria-pressed={selected.includes(item.id)}
            disabled={selected.length >= 100 && !selected.includes(item.id)}
            onClick={() =>
              onChange(
                selected.includes(item.id)
                  ? selected.filter((id) => id !== item.id)
                  : [...selected, item.id]
              )
            }
            className={`relative overflow-hidden rounded-lg border text-left focus-visible:ring-2 focus-visible:ring-ring ${selected.includes(item.id) ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
          >
            <div className="flex aspect-square items-center justify-center bg-muted">
              {item.thumbnail_url || (item.media_type !== 'VIDEO' && item.media_url) ? (
                <img
                  src={item.thumbnail_url || item.media_url}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <ImageIcon className="h-8 w-8 text-muted-foreground" />
              )}
            </div>
            <div className="p-2">
              <p className="line-clamp-2 text-xs">{item.caption || 'Untitled post'}</p>
              <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {item.media_product_type === 'REELS' ? 'Reel' : 'Post'}
              </p>
            </div>
            {selected.includes(item.id) && (
              <span className="absolute right-2 top-2 rounded-full bg-primary p-1 text-primary-foreground">
                <Check className="h-3 w-3" />
              </span>
            )}
          </button>
        ))}
      </div>
      {!loading && !error && !items.length && (
        <p className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">
          No posts or reels are available for this account.
        </p>
      )}
      {selected
        .filter((id) => !items.some((item) => item.id === id))
        .map((id) => (
          <div
            key={id}
            className="flex items-center justify-between gap-2 rounded-md bg-muted p-2 text-xs"
          >
            <span className="truncate">Selected post {id}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(selected.filter((value) => value !== id))}
            >
              Remove
            </Button>
          </div>
        ))}
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading posts…
        </p>
      )}
      {(cursor || error) && (
        <Button type="button" variant="outline" disabled={loading} onClick={() => void loadMore()}>
          {error ? 'Retry loading posts' : 'Load more posts'}
        </Button>
      )}
    </div>
  );
}
