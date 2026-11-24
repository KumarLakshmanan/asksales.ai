/** Read-only by default. --apply repairs account subscriptions; it never sends a message. */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import { getGraphApiVersion } from '../utils/metaApiVersion.js';
import { boundMetaPageToken, decryptMetaSecret } from '../utils/metaCredentialSecrets.js';
import { isDirectInstagramLogin } from '../utils/instagramOAuthCredential.js';
import { channelCredentialsTable, type ChannelCredentialRecord } from '../models/channelCredentials/schema.js';
import { getActiveAdminCredential } from '../models/adminApiCredentials/functions.js';

const apply = process.argv.includes('--apply');
const ownerArg = process.argv.find(arg => arg.startsWith('--user-id='));
const userId = ownerArg ? Number(ownerArg.split('=')[1]) : null;
if (ownerArg && (!Number.isSafeInteger(userId) || Number(userId) <= 0)) throw new Error('Expected --user-id=<positive integer>.');

async function main() {
  const owners = await withSystemScope('Inspect social webhook subscriptions', () => db.execute(sql`
    SELECT DISTINCT user_id,business_profile_id FROM channel_credentials
    WHERE platform IN ('whatsapp','instagram_api','facebook_api') AND is_active=TRUE
      AND business_profile_id IS NOT NULL AND (${userId}::integer IS NULL OR user_id=${userId})`));
  let incomplete = false;
  for (const owner of owners.rows) await withBusinessScope({ userId: Number(owner.user_id), businessProfileId: Number(owner.business_profile_id) }, async () => {
    const credentials = await db.select().from(channelCredentialsTable);
    const version = await getGraphApiVersion();
    const admin = await getActiveAdminCredential('meta_app');
    const config = admin?.config as { appId?: string; instagramAppId?: string } | null;
    for (const credential of credentials.filter((c: ChannelCredentialRecord) => c.userId === Number(owner.user_id) && c.isActive && ['whatsapp','instagram_api','facebook_api'].includes(c.platform))) {
      const context = { userId: owner.user_id, businessProfileId: owner.business_profile_id, credentialId: credential.id, platform: credential.platform };
      try {
        if (credential.platform === 'whatsapp') {
          // smb_message_echoes is an app-level WABA subscription, not a phone's subscribed_fields setting.
          const appId = config?.appId || admin?.apiKey;
          if (!appId || !admin?.apiSecret) throw new Error('Meta app subscription credentials are unavailable.');
          const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(appId)}/subscriptions`, {
            headers: { Authorization: `Bearer ${appId}|${decryptMetaSecret(admin.apiSecret)}` }, signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error('Could not inspect the app webhook subscriptions.');
          const body = await response.json() as { data?: Array<{ object: string; fields?: Array<{ name: string }> }> };
          const subscribed = body.data?.find(item => item.object === 'whatsapp_business_account')?.fields?.some(field => field.name === 'smb_message_echoes');
          if (!subscribed) incomplete = true;
          console.log(JSON.stringify({ ...context, status: subscribed ? 'subscribed' : 'action_required',
            detail: subscribed ? 'Verify a Business App/WhatsApp Web echo reaches the inbox.' : 'Enable smb_message_echoes for the WhatsApp Business Account object in Meta App Dashboard; verify coexistence is connected.' }));
          continue;
        }
        const direct = credential.platform === 'instagram_api' && isDirectInstagramLogin(credential);
        const account = credential.accountIdentifier;
        const connection = (await db.execute(sql`SELECT page_id,page_access_token FROM meta_page_connections
          WHERE user_id=${credential.userId} AND is_active=TRUE AND (page_id=${account} OR instagram_account_id=${account}) LIMIT 1`)).rows[0];
        const target = direct ? account : connection?.page_id || account;
        const token = decryptMetaSecret(boundMetaPageToken(credential) || connection?.page_access_token || credential.accessToken);
        if (!target || !token) throw new Error('The account or access token is unavailable. Reconnect this account.');
        const url = `https://graph.${direct ? 'instagram' : 'facebook'}.com/${version}/${encodeURIComponent(String(target))}/subscribed_apps`;
        const headers = { Authorization: `Bearer ${token}` };
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Could not inspect account subscriptions. Check granted permissions.');
        const body = await response.json() as { data?: Array<{ id?: string; subscribed_fields?: string[] }> };
        const appId = direct ? config?.instagramAppId : config?.appId || admin?.apiKey;
        const own = body.data?.find(item => item.id === appId);
        if (!appId) throw new Error('The configured Meta app identity is unavailable.');
        const fields = own?.subscribed_fields || [];
        const missing = ['messages','message_echoes'].filter(field => !fields.includes(field));
        if (missing.length && apply) {
          const repaired = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ subscribed_fields: [...new Set([...fields,...missing])].join(',') }), signal: AbortSignal.timeout(15000) });
          const result = await repaired.json() as { success?: boolean };
          if (!repaired.ok || result.success !== true) throw new Error('Subscription repair was not confirmed. Reconnect with the required permissions.');
        } else if (missing.length) incomplete = true;
        console.log(JSON.stringify({ ...context, status: missing.length ? apply ? 'repaired' : 'action_required' : 'subscribed', missing }));
      } catch (error) {
        incomplete = true;
        // Provider bodies/tokens are deliberately excluded from diagnostics.
        console.log(JSON.stringify({ ...context, status: 'unverified', detail: error instanceof Error ? error.message : 'Subscription check failed.' }));
      }
    }
  });
  process.exitCode = incomplete ? 1 : 0;
}
await main();
process.exit(process.exitCode || 0);
