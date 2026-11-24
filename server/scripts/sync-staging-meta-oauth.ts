import { pgPool } from '../models/db.js';
import {
  createAdminCredential,
  getActiveAdminCredential,
  getAdminCredentialsByPlatform,
  recordAdminCredentialAudit,
  updateAdminCredential,
} from '../models/adminApiCredentials/functions.js';

const STAGING_URL = 'https://dev.asksales.ai';
const MANAGED_NAME = 'AskSales.ai Dev (staging environment)';

async function main() {
  if (process.env.APP_URL !== STAGING_URL) {
    throw new Error('Meta OAuth environment synchronization is limited to dev.asksales.ai.');
  }

  const appId = process.env.META_APP_ID?.trim() || '';
  const appSecret = process.env.META_APP_SECRET?.trim() || '';
  if (!/^\d{15,20}$/.test(appId) || !/^[a-f\d]{32}$/i.test(appSecret)) {
    throw new Error('Staging Meta App ID or secret is missing or invalid.');
  }

  const credentials = await getAdminCredentialsByPlatform('meta_app');
  const managed = credentials.find((credential) => credential.name === MANAGED_NAME);
  if (credentials.some((credential) => credential.isActive && credential.id !== managed?.id)) {
    throw new Error('Another Meta application is active on staging; resolve it before synchronizing the environment.');
  }

  if (managed) {
    if (managed.apiKey !== appId || managed.apiSecret !== appSecret || !managed.isActive) {
      await updateAdminCredential(managed.id, {
        apiKey: appId,
        apiSecret: appSecret,
        isActive: true,
        priority: 'high',
        deactivationReason: null,
        deactivatedAt: null,
      });
      await recordAdminCredentialAudit({
        credentialId: managed.id,
        platform: 'meta_app',
        action: 'rotate',
        changedFields: ['apiKey', 'apiSecret', 'isActive'],
        message: 'Synchronized from the private staging environment.',
      });
      console.log('Staging Meta OAuth credential updated.');
    } else {
      console.log('Staging Meta OAuth credential already matches the environment.');
    }
  } else {
    const created = await createAdminCredential({
      platform: 'meta_app',
      name: MANAGED_NAME,
      apiKey: appId,
      apiSecret: appSecret,
      isActive: true,
      priority: 'high',
      config: { webhookUrl: `${STAGING_URL}/api/webhooks/meta` },
    });
    await recordAdminCredentialAudit({
      credentialId: created.id,
      platform: 'meta_app',
      action: 'create',
      changedFields: ['apiKey', 'apiSecret', 'config'],
      message: 'Provisioned from the private staging environment.',
    });
    console.log('Staging Meta OAuth credential created.');
  }

  const active = await getActiveAdminCredential('meta_app');
  if (active?.name !== MANAGED_NAME || active.apiKey !== appId || active.apiSecret !== appSecret) {
    throw new Error('The staging Meta OAuth credential did not become active.');
  }
}

main().catch(() => {
  console.error('Staging Meta OAuth credential synchronization failed.');
  process.exitCode = 1;
}).finally(async () => {
  await pgPool?.end();
});
