/** Only provider-returned identities may become webhook routing keys. */
export async function verifyMetaManualIdentity(input: {
  appId: string; appSecret: string; accessToken: string;
  platform: 'facebook' | 'instagram'; pageId?: string; instagramAccountId?: string;
}) {
  if (![input.appId, input.appSecret, input.accessToken].every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096)) {
    throw new Error('Invalid Meta credential fields');
  }
  const graph = 'https://graph.facebook.com/v25.0';
  async function get(url: URL, token: string): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Meta could not verify this credential');
    const data = await response.json() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (data.error) throw new Error('Meta could not verify this identity');
    return data;
  }
  const debugUrl = new URL(`${graph}/debug_token`);
  debugUrl.searchParams.set('input_token', input.accessToken);
  const debug = (await get(debugUrl, `${input.appId}|${input.appSecret}`)).data;
  if (!debug?.is_valid || String(debug.app_id) !== input.appId
    || (Number(debug.expires_at) > 0 && Number(debug.expires_at) * 1000 <= Date.now())) {
    throw new Error('The token is expired or belongs to a different Meta app');
  }
  if (Number(debug.data_access_expires_at) > 0 && Number(debug.data_access_expires_at) * 1000 <= Date.now()) {
    throw new Error('Meta data access has expired');
  }
  const scopes = new Set<string>(Array.isArray(debug.scopes) ? debug.scopes : []);
  const linkedPage = input.platform === 'facebook' || Boolean(input.pageId);
  const required = input.platform === 'facebook' ? ['pages_read_engagement', 'pages_messaging']
    : linkedPage ? ['instagram_basic', 'instagram_manage_messages']
      : ['instagram_business_basic', 'instagram_business_manage_messages'];
  if (required.some(scope => !scopes.has(scope))) throw new Error('The token lacks required messaging permissions');
  const profileUrl = new URL(linkedPage ? `${graph}/me` : 'https://graph.instagram.com/v25.0/me');
  profileUrl.searchParams.set('fields', linkedPage ? 'id,name,instagram_business_account{id,username}' : 'user_id,username');
  const profile = await get(profileUrl, input.accessToken);
  if (linkedPage && String(profile.id) !== input.pageId) throw new Error('The Page ID does not belong to this token');
  const instagram = linkedPage ? profile.instagram_business_account : { id: profile.user_id, username: profile.username };
  if (input.platform === 'instagram' && (!instagram?.id || String(instagram.id) !== input.instagramAccountId)) {
    throw new Error('The Instagram account is not linked to this token and Page');
  }
  return {
    pageId: linkedPage ? String(profile.id) : String(instagram.id),
    pageName: String(profile.name || profile.username || profile.id || instagram.id),
    instagramAccountId: instagram?.id ? String(instagram.id) : undefined,
    instagramUsername: instagram?.username ? String(instagram.username) : undefined,
    scopes: [...scopes],
  };
}
