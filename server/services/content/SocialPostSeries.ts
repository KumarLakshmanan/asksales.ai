/**
 * Multi-post social generation (content plans, calendars, series).
 *
 * A 30-day Instagram plan is 30 separate posts. Each post is parsed, checked
 * against the platform's per-post limit and saved on its own. One post that is
 * too long is shortened once; if it still fails, only that post is reported.
 * The whole plan is never validated as a single caption.
 */
import {
  ContentComplianceError,
  parseStructuredContent,
} from './ContentComplianceService.js';

export const MAX_SERIES_POSTS = 30;
/** Posts requested per provider call; keeps each JSON response well bounded. */
export const SERIES_BATCH_SIZE = 6;

export type SocialPost = Record<string, unknown> & { caption: string; title?: string; hashtags: string[] };

export interface SeriesPostResult {
  /** 1-based position in the series. */
  number: number;
  post?: SocialPost;
  error?: string;
}

export interface SeriesDependencies {
  /** Ask the provider for posts [start, start + size). Returns the parsed JSON response. */
  requestBatch: (start: number, size: number, earlierTitles: string[]) => Promise<unknown>;
  /** Ask the provider to rewrite one post so it passes the listed problems. Returns the parsed JSON post. */
  repairPost: (post: SocialPost, problems: string[]) => Promise<unknown>;
  /** Apply reviewed, non-model rules (exact CTA, media exclusions). */
  finalize: (post: SocialPost) => SocialPost;
  /** Throws ContentComplianceError when the post breaks a brand or platform rule. */
  validate: (post: SocialPost) => void;
  onProgress?: (done: number, total: number) => void;
}

export function seriesPostCount(value: unknown): number {
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count) || count < 1) return 1;
  return Math.min(count, MAX_SERIES_POSTS);
}

/** Accepts {posts:[...]}, a bare array, or a single post object. */
export function postsFromResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['posts', 'items', 'plan', 'days']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    if (typeof record.caption === 'string') return [record];
  }
  return [];
}

function problemsOf(error: unknown): string[] {
  if (error instanceof ContentComplianceError) return error.violations;
  return ['The post was missing required fields (caption, hashtags).'];
}

/** Parse, finalize and validate one post, with one targeted repair attempt. */
export async function validatedSocialPost(raw: unknown, deps: Pick<SeriesDependencies, 'repairPost' | 'finalize' | 'validate'>): Promise<{ post?: SocialPost; problems?: string[] }> {
  const check = (value: unknown): SocialPost => {
    const post = deps.finalize(parseStructuredContent('social', value) as SocialPost);
    deps.validate(post);
    return post;
  };
  let candidate: SocialPost | undefined;
  try {
    return { post: check(raw) };
  } catch (error) {
    let problems = problemsOf(error);
    try { candidate = deps.finalize(parseStructuredContent('social', raw) as SocialPost); } catch { candidate = undefined; }
    if (!candidate) return { problems };
    try {
      return { post: check(await deps.repairPost(candidate, problems)) };
    } catch (repairError) {
      problems = problemsOf(repairError);
      return { problems };
    }
  }
}

export async function generateSocialPostSeries(count: number, deps: SeriesDependencies): Promise<SeriesPostResult[]> {
  const total = seriesPostCount(count);
  const results: SeriesPostResult[] = [];
  const titles: string[] = [];
  for (let start = 0; start < total; start += SERIES_BATCH_SIZE) {
    const size = Math.min(SERIES_BATCH_SIZE, total - start);
    let raws: unknown[] = [];
    let batchError: string | undefined;
    try {
      raws = postsFromResponse(await deps.requestBatch(start, size, [...titles]));
    } catch {
      batchError = 'The content provider did not return this post. Generate it again from the content library.';
    }
    for (let offset = 0; offset < size; offset += 1) {
      const number = start + offset + 1;
      const raw = raws[offset];
      if (batchError || raw === undefined) {
        results.push({ number, error: batchError || 'The content provider returned fewer posts than requested.' });
        continue;
      }
      const { post, problems } = await validatedSocialPost(raw, deps);
      if (post) {
        results.push({ number, post });
        if (typeof post.title === 'string' && post.title.trim()) titles.push(post.title.trim().slice(0, 80));
      } else {
        results.push({ number, error: (problems || []).join(' ') || 'The post did not pass validation.' });
      }
    }
    deps.onProgress?.(results.length, total);
  }
  return results;
}
