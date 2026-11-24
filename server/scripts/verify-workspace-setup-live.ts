/** Controlled smoke test against a disposable, authenticated local QA workspace.
 * Uses the real API, standalone queue worker, crawl/AI/indexing and asset storage.
 * Never logs tokens or provider payloads. See docs/workspace-setup-improvements.md.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

type Job = { id: string; status: string; result?: { data?: Record<string, unknown>; kbEntryId?: number; analysisSummary?: { pages: number; knowledgeSaved: boolean; warnings: string[] } }; error?: string };
async function main() {
  const base = process.env.WORKSPACE_SETUP_LIVE_API_URL;
  const token = process.env.WORKSPACE_SETUP_LIVE_TOKEN;
  const profileId = Number(process.env.WORKSPACE_SETUP_LIVE_PROFILE_ID);
  const website = process.env.WORKSPACE_SETUP_LIVE_WEBSITE;
  if (process.env.WORKSPACE_SETUP_LIVE_ALLOW !== 'true' || !base || !token || !website || !Number.isSafeInteger(profileId) || profileId <= 0) {
    console.log(JSON.stringify({ status: 'unavailable', reason: 'Configure the local QA API, authenticated disposable workspace, website, and explicit live-test flag.' }));
    process.exitCode = 2; return;
  }
  const origin = new URL(base);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || !['http:', 'https:'].includes(origin.protocol)) throw new Error('Use a local disposable QA API.');
  const target = new URL(website);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use a public HTTP or HTTPS test website.');
  const headers = { Authorization: `Bearer ${token}`, 'X-Business-Profile-Id': String(profileId), 'Content-Type': 'application/json' };
  let cookie = '';
  let csrf = '';
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(new URL(path, origin), { method, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-XSRF-TOKEN': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) { cookie = cookies.map(value => value.split(';')[0]).join('; '); csrf = decodeURIComponent(cookies.find(value => value.startsWith('XSRF-TOKEN='))?.split(';')[0].slice(11) || ''); }
    if (!response.ok) throw new Error(`QA API check failed (${response.status}); review server diagnostics.`);
    return response.json() as Promise<T>;
  };
  await request('/api/auth/csrf-token');
  const identity = await request<{ user?: { id?: number }; id?: number }>('/api/auth/me');
  if (!identity.user?.id && !identity.id) throw new Error('Authenticated identity was not returned.');
  const profiles = await request<Array<{ id: number; role?: string; isDefault?: boolean; archivedAt?: string }>>('/api/settings/business-profiles');
  const profile = profiles.find(value => value.id === profileId);
  if (!profile || profile.role !== 'owner' || profile.isDefault || profile.archivedAt) throw new Error('Select an owned, active, nondefault disposable QA workspace.');
  const { job: started } = await request<{ job: Job }>('/api/setup/website-analysis/jobs', 'POST', { url: target.href, forceRefresh: true, idempotencyKey: randomUUID() });
  let job = started;
  const deadline = Date.now() + 10 * 60_000;
  while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
    await delay(2000);
    job = (await request<{ job: Job }>(`/api/setup/website-analysis/jobs/${job.id}`)).job;
  }
  if (job.status !== 'completed' || !job.result?.data || !job.result.kbEntryId || !job.result.analysisSummary?.knowledgeSaved) throw new Error(`Analysis smoke check incomplete (${job.status}); review the QA workspace.`);
  const knowledge = await request<{ extractedText?: string; chunks?: unknown[]; embeddingsGenerated?: boolean }>(`/api/settings/knowledge-base/${job.result.kbEntryId}/extracted-text`);
  if (!knowledge.extractedText?.trim() && !knowledge.chunks?.length) throw new Error('Saved knowledge is empty.');
  if (knowledge.embeddingsGenerated !== true) throw new Error('Knowledge indexing has not completed.');
  const assets = Array.isArray(job.result.data.extractedImages) ? job.result.data.extractedImages : [];
  const stored = assets.filter(asset => asset && typeof asset === 'object' && typeof (asset as { url?: unknown }).url === 'string');
  if (!job.result.data.screenshotUrl && !stored.length) throw new Error('No stored image or screenshot was available to verify asset storage.');
  const assetUrls = [...stored.map(asset => (asset as { url: string }).url), ...(typeof job.result.data.screenshotUrl === 'string' ? [job.result.data.screenshotUrl] : [])];
  const storageOrigin = process.env.WORKSPACE_SETUP_LIVE_STORAGE_ORIGIN ? new URL(process.env.WORKSPACE_SETUP_LIVE_STORAGE_ORIGIN).origin : null;
  let verifiedAssets = 0;
  for (const value of assetUrls.slice(0, 3)) {
    const assetUrl = new URL(value, origin);
    if (assetUrl.origin !== origin.origin && assetUrl.origin !== storageOrigin) continue;
    const response = await fetch(assetUrl, { headers: assetUrl.origin === origin.origin ? headers : {}, signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !(response.headers.get('content-type') || '').startsWith('image/')) throw new Error('Stored asset cannot be read.');
    verifiedAssets++;
  }
  if (!verifiedAssets) throw new Error('No stored asset was verified. Configure the expected storage origin for a remote asset host.');
  console.log(JSON.stringify({ status: 'passed', checks: ['authentication', 'workspace_ownership', 'background_job', 'crawl_and_ai', 'knowledge_persistence', 'knowledge_indexing', 'asset_storage'], pages: job.result.analysisSummary.pages, warnings: job.result.analysisSummary.warnings.length }));
}
main().catch(() => { console.error(JSON.stringify({ status: 'failed', reason: 'Live setup verification did not pass. Review the disposable QA workspace and server diagnostics; provider responses and credentials are not printed.' })); process.exitCode = 1; });
