/**
 * Safe release canary for connected providers.
 *
 * Default mode is database-only planning. To make the read-only provider
 * identity/scope/webhook probes, all three interlocks below are required:
 *   PROVIDER_CANARY_ALLOW_EXECUTE=true pnpm canary:provider -- --user-id 42 --platform instagram --credential-id 17 --account-id 123 --execute --confirm RUN_PROVIDER_CANARY
 *
 * This script never publishes, sends, uploads, or deletes provider content.
 */
import '../env.js';
import {
  PROVIDER_CANARY_CONFIRMATION,
  runProviderCanary,
} from '../services/integrations/ProviderCanaryService.js';
import type { ProviderVerificationPlatform } from '../models/providerVerificationRuns/schema.js';
import { option } from './lib/cliArgs.js';

const supported = new Set<ProviderVerificationPlatform>(['facebook', 'instagram', 'whatsapp', 'meta_ads', 'google_ads', 'youtube', 'gmail', 'resend']);

async function main() {
  const userId = Number(option('--user-id'));
  const platform = String(option('--platform') || '').toLowerCase() as ProviderVerificationPlatform;
  const credentialValue = option('--credential-id');
  const credentialId = credentialValue === undefined ? undefined : Number(credentialValue);
  const execute = process.argv.includes('--execute');
  const confirmation = option('--confirm');
  const accountIdentifier = option('--account-id');

  if (!Number.isSafeInteger(userId) || userId <= 0 || !supported.has(platform)) {
    throw new Error('Usage: --user-id <positive integer> --platform <facebook|instagram|whatsapp|meta_ads|google_ads|youtube|gmail|resend> [--credential-id <id>] [--account-id <provider account id>] [--execute --confirm RUN_PROVIDER_CANARY]');
  }
  if (credentialId !== undefined && (!Number.isSafeInteger(credentialId) || credentialId <= 0)) {
    throw new Error('--credential-id must be a positive integer.');
  }
  if (execute && process.env.PROVIDER_CANARY_ALLOW_EXECUTE !== 'true') {
    throw new Error('Refusing external provider probes. Set PROVIDER_CANARY_ALLOW_EXECUTE=true together with --execute and the confirmation phrase.');
  }
  if (execute && confirmation !== PROVIDER_CANARY_CONFIRMATION) {
    throw new Error(`--confirm must equal ${PROVIDER_CANARY_CONFIRMATION}.`);
  }
  if (platform !== 'resend' && !accountIdentifier?.trim()) {
    throw new Error('--account-id is required for every account-bound provider canary (Resend uses the tenant domain binding).');
  }

  const result = await runProviderCanary({ userId, platform, credentialId, accountIdentifier, execute, confirmation });
  // This result contains only IDs, status, and timestamps. Never print a
  // token, provider body, domain record value, or recipient address here.
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'passing' || result.status === 'planned' ? 0 : 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Provider canary failed.');
  process.exitCode = 1;
});
