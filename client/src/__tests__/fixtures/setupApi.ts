import { beforeEach } from "vitest";
type Call = (...args: unknown[]) => unknown;
type Payload = Record<string, unknown>;
interface FixtureDraft { data: unknown; step: unknown; revision: number; updatedAt: string }
/** Stateful draft/job adapter for the existing setup component fixtures. */
export function setupApiFixture(mocks: { get: Call; put: Call; post: Call }) {
  const drafts = new Map<string, FixtureDraft>();
  beforeEach(() => drafts.clear());
  return {
    get: (url: string, ...options: unknown[]) => url.includes('/api/setup/drafts/') ? Promise.resolve({ draft: drafts.get(url) || null }) : url.endsWith('/website-analysis/jobs/latest') ? Promise.resolve({ job: null }) : mocks.get(url, ...options),
    put: async (url: string, value: Payload, ...options: unknown[]) => {
      if (!url.includes('/api/setup/drafts/')) return mocks.put(url, value, ...options);
      const draft = { data: value.data, step: value.step, revision: (drafts.get(url)?.revision || 0) + 1, updatedAt: new Date().toISOString() };
      drafts.set(url, draft); return { draft };
    },
    post: async (url: string, value: Payload, ...options: unknown[]) => {
      const response = await mocks.post(url, value, ...options) as Payload;
      if (url.endsWith('/website-analysis/jobs') && response.data) return { job: { id: 'fixture-job', url: value.url, status: 'completed', stage: 'complete', updatedAt: new Date().toISOString(), result: response } };
      return response;
    },
    delete: async (url: string) => { drafts.delete(url); return { draft: null }; },
  };
}
