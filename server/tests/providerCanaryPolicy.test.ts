import { describe, expect, it } from '@jest/globals';
import { PROVIDER_CANARY_CONFIRMATION } from '../services/integrations/ProviderCanaryService.js';

describe('provider release-canary policy', () => {
  it('uses a distinct, explicit confirmation phrase for provider probes', () => {
    expect(PROVIDER_CANARY_CONFIRMATION).toBe('RUN_PROVIDER_CANARY');
  });

  it('keeps the CLI execution interlock and non-mutating contract visible to operators', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../scripts/run-provider-canary.ts', import.meta.url), 'utf8'));
    expect(source).toContain('PROVIDER_CANARY_ALLOW_EXECUTE');
    expect(source).toContain('--account-id is required');
    expect(source).toContain('--execute');
    expect(source).toContain('never publishes, sends, uploads, or deletes');
    expect(source).toContain("'meta_ads'");
    expect(source).toContain("'google_ads'");
  });

  it('enforces the external-probe gate in the service as well as the CLI', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../services/integrations/ProviderCanaryService.ts', import.meta.url), 'utf8'));
    expect(source).toContain("process.env.PROVIDER_CANARY_ALLOW_EXECUTE !== 'true'");
    expect(source).toContain('requestedAccountIdentifier && binding.accountIdentifier === requestedAccountIdentifier');
    expect(source).toContain("request.platform === 'meta_ads'");
    expect(source).toContain("request.platform === 'google_ads'");
  });

  it('keeps paid-ad canaries read-only provider checks', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../services/integrations/ProviderVerificationService.ts', import.meta.url), 'utf8'));
    expect(source).toContain('verifyGoogleAdsCredentials');
    expect(source).toContain('getGoogleAdsAccountInfo');
    expect(source).toContain('verifyMetaAds');
    expect(source).not.toContain('createGoogleAdsSearchCampaign(');
    expect(source).not.toContain('.createCampaign(');
  });
});
