import api from '@/lib/api';
import { selectedBusinessProfileId } from '@/lib/business-profile';
import { instagramAutomationsApi, type InstagramAutomationMedia } from '@/lib/instagram-automations';
type MediaPage = { media: InstagramAutomationMedia[]; nextCursor: string | null };
const pages = new Map<string, { until: number; promise: Promise<MediaPage> }>();
const scopeKey = (accountId: string) => `${selectedBusinessProfileId() || 'none'}:${accountId}:`;
export function clearInstagramMediaCache(accountId: string) { const prefix = scopeKey(accountId); for (const key of pages.keys()) if (key.startsWith(prefix)) pages.delete(key); }
export function loadInstagramMediaPage(accountId: string, cursor: string | null = null) {
  const key = scopeKey(accountId) + (cursor || 'first');
  const cached = pages.get(key);
  if (cached && cached.until > Date.now()) return cached.promise;
  for (const [oldKey, value] of pages) if (value.until <= Date.now()) pages.delete(oldKey);
  if (pages.size >= 50) pages.delete(pages.keys().next().value!);
  const entry = { until: Date.now() + 60000, promise: Promise.resolve({ media: [], nextCursor: null } as MediaPage) };
  entry.promise = api.get<MediaPage>(`${instagramAutomationsApi(accountId)}/media${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`).catch(error => { if (pages.get(key) === entry) pages.delete(key); throw error; });
  pages.set(key, entry);
  return entry.promise;
}
