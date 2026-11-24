import { activationConfirmationError } from '../services/ads/AutonomousAdsService.js';

const confirmedAt = new Date('2026-08-30T12:00:00.000Z');
const reviewed: Parameters<typeof activationConfirmationError>[0] = {
  autoActivate: true,
  confirmation: {
    confirmedAt,
    source: 'direct_review' as const,
    scope: 'live_activation_and_spend' as const,
    campaignName: 'Reviewed campaign',
    platforms: ['google'],
    lifetimeBudget: 250,
    currency: 'USD',
  },
  campaignName: 'Reviewed campaign',
  platforms: ['google'],
  lifetimeBudget: 250,
  currency: 'USD',
};

describe('Google Ads live activation safety', () => {
  it('accepts a matching fresh confirmation', () => {
    expect(activationConfirmationError(reviewed, new Date('2026-08-30T12:09:59.000Z'))).toBeNull();
  });

  it('rejects expired or materially changed confirmations', () => {
    expect(activationConfirmationError(reviewed, new Date('2026-08-30T12:10:01.000Z'))).toContain('expired');
    expect(activationConfirmationError({ ...reviewed, lifetimeBudget: 251 }, confirmedAt)).toContain('budget or currency changed');
    expect(activationConfirmationError({ ...reviewed, campaignName: 'Changed campaign' }, confirmedAt)).toContain('campaign name changed');
  });

  it('requires no confirmation for paused publication', () => {
    expect(activationConfirmationError({ ...reviewed, autoActivate: false, confirmation: undefined }, confirmedAt)).toBeNull();
  });
});
