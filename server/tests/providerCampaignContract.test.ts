import {
  defaultGoogleProviderConfig,
  defaultMetaProviderConfig,
  normalizeGoogleCreative,
  validateProviderCampaign,
} from '../services/ads/ProviderCampaignContract.js';

const googleCreative = {
  headlines: ['Primary offer', 'Trusted service', 'Learn more today'],
  descriptions: ['A useful first description.', 'A useful second description.'],
  keywords: ['revenue operations'],
  finalUrl: 'https://example.com/offer',
};

describe('ProviderCampaignContract', () => {
  it('does not invent Google keywords or RSA variants when the reviewed creative omitted them', () => {
    const creative = normalizeGoogleCreative({
      headline: 'Primary offer',
      description: 'A useful description.',
    }, 'Campaign');

    expect(creative.keywords).toEqual([]);
    expect(creative.headlines).toEqual(['Primary offer']);
    expect(creative.descriptions).toEqual(['A useful description.']);
    const errors = validateProviderCampaign({ platforms: ['google'], objective: 'traffic', campaignName: 'Campaign', landingPageUrl: 'https://example.com', creatives: { google: [creative] }, providerConfig: { google: defaultGoogleProviderConfig() }, hasEndDate: true });
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('3 to 15 headlines'), expect.stringContaining('2 to 4 descriptions')]));
  });

  it('rejects duplicate Google RSA assets case-insensitively', () => {
    const errors = validateProviderCampaign({
      platforms: ['google'],
      objective: 'traffic',
      campaignName: 'Search campaign',
      landingPageUrl: 'https://example.com',
      creatives: {
        google: [{
          ...googleCreative,
          headlines: ['Primary offer', 'primary offer', 'Learn more today'],
          descriptions: ['Useful details.', 'useful details.'],
        }],
      },
      providerConfig: { google: defaultGoogleProviderConfig() },
      hasEndDate: true,
    });

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('headlines must be unique'),
      expect.stringContaining('descriptions must be unique'),
    ]));
  });

  it('requires reviewed Google Search keywords and validates RSA limits', () => {
    const errors = validateProviderCampaign({
      platforms: ['google'],
      objective: 'traffic',
      campaignName: 'Search campaign',
      landingPageUrl: 'https://example.com',
      creatives: {
        google: [{ ...googleCreative, keywords: [], headlines: ['Only one'] }],
      },
      providerConfig: { google: defaultGoogleProviderConfig() },
      hasEndDate: true,
    });

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('3 to 15 headlines'),
      expect.stringContaining('reviewed keyword'),
    ]));
  });

  it('requires explicit Meta conversion destinations for sales and app campaigns', () => {
    const salesErrors = validateProviderCampaign({
      platforms: ['meta'],
      objective: 'sales',
      campaignName: 'Sales campaign',
      landingPageUrl: 'https://example.com',
      creatives: {
        meta: [{
          headline: 'Offer',
          primaryText: 'Buy today',
          imageUrl: 'https://example.com/image.jpg',
        }],
      },
      providerConfig: { meta: defaultMetaProviderConfig('sales') },
      hasEndDate: true,
    });
    const appErrors = validateProviderCampaign({
      platforms: ['meta'],
      objective: 'app_promotion',
      campaignName: 'App campaign',
      landingPageUrl: 'https://example.com',
      creatives: {
        meta: [{
          headline: 'Install',
          primaryText: 'Install today',
          videoId: '123',
        }],
      },
      providerConfig: {
        meta: {
          ...defaultMetaProviderConfig('app_promotion'),
          promotedObject: { applicationId: 'app-123' },
        },
      },
      hasEndDate: true,
    });

    expect(salesErrors).toContain('Meta sales campaigns require an explicit Pixel ID for conversion optimization.');
    expect(appErrors).toContain('Meta app promotion campaigns require both an application ID and an App Store or Play Store URL.');
  });

  it('accepts a fully reviewed dual-provider contract', () => {
    expect(validateProviderCampaign({
      platforms: ['meta', 'google'],
      objective: 'traffic',
      campaignName: 'Reviewed campaign',
      landingPageUrl: 'https://example.com',
      creatives: {
        meta: [{
          headline: 'Offer',
          primaryText: 'Learn more today',
          imageHash: 'hash-123',
        }],
        google: [googleCreative],
      },
      providerConfig: {
        meta: defaultMetaProviderConfig('traffic'),
        google: defaultGoogleProviderConfig(),
      },
      hasEndDate: true,
    })).toEqual([]);
  });

  it('validates tracking and final URL suffix recovery rules', () => {
    const errors = validateProviderCampaign({
      platforms: ['google'],
      objective: 'traffic',
      campaignName: 'Reviewed campaign',
      landingPageUrl: 'https://example.com',
      creatives: { google: [googleCreative] },
      providerConfig: {
        google: {
          ...defaultGoogleProviderConfig(),
          trackingTemplate: 'https://tracker.example/click',
          finalUrlSuffix: '?source=google',
        },
      },
      hasEndDate: true,
    });

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('{lpurl}'),
      expect.stringContaining('must not begin'),
    ]));
  });
});
