import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('Google Ads publishing entry paths', () => {
  it('links Saved Templates to review with exact template identity', () => {
    const library = read('src/app/dashboard/(main)/saved-templates/ads/page.tsx');
    const review = read('src/app/dashboard/(main)/saved-templates/ads/publish/page.tsx');

    expect(library).toContain('templateId=${template.id}');
    expect(library).toContain('primaryLabel="Review campaign"');
    expect(review).toContain('sourceType: "content_template"');
    expect(review).toContain('sourceVersion: template.version || 1');
    expect(review).toContain('safeDashboardReturnPath');
  });

  it('uses valid non-nested platform selectors and explicit live activation confirmation', () => {
    const review = read('src/app/dashboard/(main)/saved-templates/ads/publish/page.tsx');
    const platformSection = review.slice(
      review.indexOf('{/* Platforms selection */}'),
      review.indexOf('{/* Select creatives */}'),
    );

    expect(platformSection).toContain('role="checkbox"');
    expect(platformSection).toContain('aria-checked={isSelected}');
    expect(platformSection).not.toContain('<button');
    expect(review).toContain('library-live-activation-confirmation');
    expect(review).toContain('!publishForm.activationConfirmed');
  });

  it('preserves Content Studio profile and asset revision provenance', () => {
    const contentTab = read('src/components/content-library/ContentTabContent.tsx');
    const adCopyTab = read('src/components/tabs/content-studio/AdCopyTab.tsx');
    const modal = read('src/components/modals/PublishCampaignModal.tsx');

    expect(contentTab).toContain('businessProfileId={businessProfileId}');
    expect(adCopyTab).toContain('CreatorScopeProvider');
    expect(read('src/components/content-studio/creators/AdCreator.tsx')).toContain('version: asset.version');
    expect(read('src/lib/ad-review-handoff.ts')).toContain('displayedRevision: ad.version ?? null');
    expect(modal).toContain('candidate.id === selectedBusinessProfileId');
    expect(modal).toContain('modal-live-activation-confirmation');
    expect(modal).toContain("publishForm.publishPlatforms.includes('meta') ? <>");
  });
});
