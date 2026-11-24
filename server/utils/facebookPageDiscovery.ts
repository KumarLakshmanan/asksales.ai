import { collectMetaPages } from './metaPagePagination.js';
import type { MetaTokenInspection } from '../services/integrations/MetaCapabilityRegistry.js';

export interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
  tasks?: string[];
}

interface PageListResponse {
  data?: FacebookPage[];
  paging?: { next?: string };
  error?: { code?: number; message?: string };
}

/** Only accept provider-issued Page tokens, never substitute the user's token. */
function usablePage(page: unknown): page is FacebookPage {
  if (!page || typeof page !== 'object') return false;
  const value = page as Partial<FacebookPage>;
  return typeof value.id === 'string' && /^\d+$/.test(value.id)
    && typeof value.name === 'string' && typeof value.access_token === 'string' && value.access_token.length > 0;
}

export async function discoverFacebookPages(input: {
  apiBase: string;
  userAccessToken: string;
  inspection: MetaTokenInspection;
}): Promise<FacebookPage[]> {
  if (!input.inspection.grantedScopes.includes('pages_show_list')) {
    throw new Error('Facebook did not grant Page access. Reconnect and allow AskSales to see the Pages you select.');
  }

  const headers = { Authorization: `Bearer ${input.userAccessToken}` };
  const listResponse = await fetch(`${input.apiBase}/me/accounts?fields=id,name,access_token,tasks`, {
    headers, signal: AbortSignal.timeout(15_000),
  });
  const list = await listResponse.json().catch(() => ({})) as PageListResponse;
  if (!listResponse.ok || list.error) {
    throw new Error('Facebook could not list your Pages. Reconnect, allow Page access, and try again.');
  }

  const listed = (await collectMetaPages(list, input.userAccessToken)).filter(usablePage);
  if (listed.length) return listed;

  // Facebook Login can grant a specific Page while /me/accounts returns no
  // entries. The token debugger identifies the exact Page IDs consented to.
  // Fetch only those IDs and require a Page access token in the response.
  const pageIds = [...new Set(input.inspection.granularScopes
    .filter((entry) => entry.scope.startsWith('pages_') && input.inspection.grantedScopes.includes(entry.scope))
    .flatMap((entry) => entry.targetIds))].slice(0, 100);
  const authorized: FacebookPage[] = [];
  for (const pageId of pageIds) {
    const response = await fetch(`${input.apiBase}/${pageId}?fields=id,name,access_token,tasks`, {
      headers, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) continue;
    const page = await response.json().catch(() => null);
    if (usablePage(page) && page.id === pageId) authorized.push(page);
  }
  if (authorized.length) return authorized;

  throw new Error('Facebook returned no Pages for this login. Reconnect and select your Page in Facebook’s permission screen. If it is missing there, give this Facebook profile Page access with the Messages task in Meta Business settings.');
}
