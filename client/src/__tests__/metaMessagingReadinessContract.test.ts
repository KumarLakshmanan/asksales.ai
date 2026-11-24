import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('Meta messaging readiness presentation', () => {
  const instagram = read('src/app/dashboard/(main)/integrations/instagram/components/InstagramOfficialAPI.tsx');
  const facebook = read('src/app/dashboard/(main)/integrations/facebook/components/FacebookOfficialAPI.tsx');
  const providerReadiness = read('src/components/integrations/ProviderReadinessPanel.tsx');
  const integrationsOverview = read('src/app/dashboard/(main)/integrations/page.tsx');

  it('requires a reconnect when provider verification rejected the saved authorization', () => {
    for (const component of [instagram, facebook]) {
      expect(component).toContain('requiresReconnect');
      expect(component).toContain('"Reconnect Required"');
      expect(component).toContain('{requiresReconnect ? "Reconnect" : "Connect"}');
      expect(component).toContain('Meta rejected the saved');
    }
  });

  it('keeps Meta App Review notices out of client presentation', () => {
    for (const component of [instagram, facebook]) {
      expect(component).toContain('showReadinessWarning');
      expect(component).toContain('readinessErrorCode !== "APP_REVIEW"');
      expect(component).not.toContain('hasReadinessWarning');
      expect(component).not.toContain('Meta App Review is not approved');
      expect(component).toContain('Reconnecting the same');
    }
  });

  it('filters deployment review checks from the owner readiness panel', () => {
    expect(providerReadiness).toContain('check.id !== "app_review"');
    expect(providerReadiness).toContain('const visibleChecks');
  });

  it('keeps provider release readiness off the integrations overview', () => {
    expect(integrationsOverview).not.toContain('ProviderReadinessPanel');
  });
});
