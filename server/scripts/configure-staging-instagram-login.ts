import { readFileSync } from 'node:fs';
import { pgPool } from '../models/db.js';
import {
  getActiveAdminCredential,
  recordAdminCredentialAudit,
  updateAdminCredential,
} from '../models/adminApiCredentials/functions.js';
import { mergeIntegrationCredentialConfig } from '../utils/integrationSecrets.js';

async function main() {
  if (process.env.APP_URL !== 'https://dev.asksales.ai') {
    throw new Error('This script only configures the Dev environment.');
  }

  const appId = process.env.INSTAGRAM_APP_ID?.trim() || '';
  const appSecret = readFileSync(0, 'utf8').trim();
  if (!/^\d{15,20}$/.test(appId) || !/^[a-f\d]{32}$/i.test(appSecret)) {
    throw new Error('Instagram app ID or secret is invalid.');
  }

  const credential = await getActiveAdminCredential('meta_app');
  if (!credential || credential.name !== 'AskSales.ai Dev (staging environment)') {
    throw new Error('The managed Dev Meta application must be active.');
  }

  const config = mergeIntegrationCredentialConfig(credential.config, {
    instagramAppId: appId,
    instagramAppSecret: appSecret,
    directInstagramLoginEnabled: true,
  });
  await updateAdminCredential(credential.id, {
    config,
    rotatedAt: new Date(),
    lastValidatedAt: null,
    validationStatus: null,
    validationMessage: null,
  });
  await recordAdminCredentialAudit({
    credentialId: credential.id,
    platform: 'meta_app',
    action: 'rotate',
    changedFields: ['config.instagramAppId', 'config.instagramAppSecret', 'config.directInstagramLoginEnabled'],
    message: 'Configured direct Instagram Login on Dev.',
  });

  const saved = await getActiveAdminCredential('meta_app');
  const savedConfig = saved?.config as Record<string, unknown> | null;
  if (savedConfig?.instagramAppId !== appId || savedConfig.instagramAppSecret !== appSecret) {
    throw new Error('Instagram Login credentials did not persist.');
  }
  console.log('Dev Instagram Login configured and verified.');
}

main().catch(() => {
  console.error('Dev Instagram Login configuration failed.');
  process.exitCode = 1;
}).finally(async () => {
  await pgPool?.end();
});
