export type MetaAccountDiscovery = {
  accounts: Array<{id:string;name:string;currency?:string;timezone_name?:string;account_status?:number}>;
  publishingAvailable: boolean;
};

/** Collect every page before saving discovery, so a later-page failure never looks complete. */
export async function discoverMetaAccountsWithToken(accessToken: string, apiVersion = 'v25.0'): Promise<MetaAccountDiscovery> {
  let url: string | undefined = `https://graph.facebook.com/${apiVersion}/me/adaccounts?fields=id,name,currency,timezone_name,account_status&limit=100`;
  const seen = new Set<string>();
  const rows: Array<{id:string;name:string;currency?:string;timezone_name?:string;account_status?:number}> = [];
  while (url) {
    if (seen.has(url) || seen.size >= 100) throw new Error('Account discovery is incomplete. Retry after reconnecting.');
    const parsed = new URL(url);
    if (parsed.origin !== 'https://graph.facebook.com') throw new Error('Invalid account discovery page.');
    seen.add(url);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
    const data = await response.json() as { error?: unknown; data?: Array<{id:string;name:string;currency?:string;timezone_name?:string;account_status?:number}>; paging?: {next?:string} };
    if (!response.ok || data.error || !Array.isArray(data.data)) throw new Error('Meta account discovery failed. Check Ads permissions and reconnect.');
    rows.push(...data.data);
    url = data.paging?.next;
  }
  let publishingAvailable = false;
  try {
    const permissionResponse = await fetch(`https://graph.facebook.com/${apiVersion}/me/permissions`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const permissionData = await permissionResponse.json() as { data?: Array<{permission?:unknown;status?:unknown}> };
    publishingAvailable = permissionResponse.ok && Array.isArray(permissionData.data)
      && permissionData.data.some((permission: {permission?:unknown;status?:unknown}) => permission.permission === 'ads_management' && permission.status === 'granted');
  } catch {
    // Reporting discovery remains useful when Meta does not expose token scopes.
  }
  return { accounts: rows, publishingAvailable };
}
