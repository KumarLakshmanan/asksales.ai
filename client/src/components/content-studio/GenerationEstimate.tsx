"use client";
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';

type Estimate = { credits: number | null; ready: boolean; model?: string; basis: string };
export function GenerationEstimate({ image = false, video = false, copies = 1, includeText = true, duration = 8, resolution = '720p', imageSize = '1K' }: { image?: boolean; video?: boolean; copies?: number; includeText?: boolean; duration?: number; resolution?: string; imageSize?: string }) {
  const parameters = new URLSearchParams({ duration: String(duration), resolution, imageSize });
  const query = useQuery({ queryKey: ['content-generation-estimates', duration, resolution, imageSize], queryFn: () => api.get<{ text: Estimate; image: Estimate; video: Estimate }>(`/api/content/studio/estimates?${parameters}`), staleTime: 60_000, retry: false });
  if (query.isPending) return <p className="text-xs text-muted-foreground">Checking provider readiness and estimated credits…</p>;
  if (query.isError || !query.data) return <p className="text-xs text-amber-700 dark:text-amber-400">Credit estimate unavailable. Check provider pricing before generating.</p>;
  const selections = [...(includeText ? [query.data.text] : []), ...(image ? [query.data.image] : []), ...(video ? [query.data.video] : [])];
  const known = selections.every((item) => item.credits !== null);
  const total = selections.reduce((sum, item) => sum + (item.credits || 0), 0) * copies;
  return <div className="space-y-1 text-xs text-muted-foreground" aria-live="polite" aria-label="Generation estimate">
    <p className="font-medium text-foreground">{known ? `Estimated ${total} ${total === 1 ? 'credit' : 'credits'}` : 'Cost estimate unavailable for this model'}{copies > 1 ? ` for ${copies} variants` : ''}</p>
    {selections.map((item, index) => <p key={index}>{item.ready ? 'Ready' : 'Setup required'}: {item.credits === null ? 'no verified price yet' : `${item.credits} ${item.credits === 1 ? 'credit' : 'credits'}`} · {item.basis}.</p>)}
    <p>Estimate, not a spending cap. Actual usage is charged.</p>
  </div>;
}
