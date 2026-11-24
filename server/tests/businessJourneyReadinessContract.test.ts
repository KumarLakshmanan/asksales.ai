import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('business journey readiness contract', () => {
  it('uses the same official-provider binding checks as outreach execution', () => {
    const controller = readFileSync(resolve(process.cwd(), 'controllers/providerVerificationController.ts'), 'utf8');
    expect(controller).toContain('inspectOfficialProviderBinding');
    expect(controller).toContain("['linkedin', 'facebook', 'instagram', 'twitter']");
    expect(controller).toContain("eq(channelCredentialsTable.platform, 'msg91_sms')");
    expect(controller).toContain('autonomousAdsService.getAccountReadiness(id, false)');
    expect(controller).toContain("process.env.AD_PROVIDER_MUTATIONS_ENABLED === 'true'");
  });

  it('exposes the read-only endpoint before the parameterized verification route', () => {
    const routes = readFileSync(resolve(process.cwd(), 'routes/providerVerification.routes.ts'), 'utf8');
    expect(routes.indexOf("router.get('/business-journeys'"))
      .toBeLessThan(routes.indexOf("router.post('/:platform/verify'"));
  });

  it('accepts the official manual Meta credentials created by the integration controllers', () => {
    const binding = readFileSync(resolve(process.cwd(), 'services/outreach/ProviderBindingService.ts'), 'utf8');
    expect(binding).toContain("credentialTypes: ['oauth', 'manual']");
    expect(binding).toContain("credentialTypes: ['oauth', 'api_key', 'manual']");
  });
});
