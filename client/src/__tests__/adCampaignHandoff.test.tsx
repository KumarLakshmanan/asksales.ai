import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdCampaignHandoff } from '@/components/content-studio/AdCampaignHandoff';
import { adCampaignBrief } from '@/lib/adCampaignBrief';
import api from '@/lib/api';
vi.mock('@/lib/api', () => ({ default: { get: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
const asset = { id: 42, type: 'ad_copy', title: 'A reviewed campaign', channel: 'google', content: JSON.stringify({ headline: 'Workflow notes', primaryText: 'Discover useful notes', displayUrl: 'https://example.com', headlines: ['Read our guide'] }), imageUrls: ['/uploads/ad.png'] };
it('keeps campaign preparation distinct from launch and retains draft data', () => {
  const brief = adCampaignBrief(asset);
  expect(brief).toContain('Do not launch, publish, or spend money');
  expect(brief).toContain('Saved content asset: 42');
  expect(brief).toContain('Read our guide');
  expect(brief).toContain('/uploads/ad.png');
  expect(() => adCampaignBrief({ ...asset, type: 'email_template' })).toThrow();
});
it('loads the saved ad and waits for explicit insertion without sending', async () => {
  vi.mocked(api.get).mockResolvedValue(asset as never);
  const insert = vi.fn();
  render(<AdCampaignHandoff assetId="42" onInsert={insert} />);
  const action = await screen.findByRole('button', { name: 'Insert campaign brief' });
  expect(insert).not.toHaveBeenCalled();
  fireEvent.click(action);
  expect(insert).toHaveBeenCalledWith(adCampaignBrief(asset));
  expect(screen.getByRole('button', { name: 'Brief added to composer' })).toBeDisabled();
});
it('rejects invalid IDs without making an asset request', async () => {
  render(<AdCampaignHandoff assetId="../1" onInsert={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid saved ad ID');
  expect(api.get).not.toHaveBeenCalled();
});
