import { beforeEach, expect, it, vi } from 'vitest';
import api from '@/lib/api';
import { widgetApi } from '@/components/widgets/api';
vi.mock('@/lib/api', () => ({ default: { patch: vi.fn(), post: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.patch).mockResolvedValue({ widget: {} } as never);
  vi.mocked(api.post).mockResolvedValue({ widget: {} } as never);
});
it('persists exact target IDs but not transient review validation', async () => {
  const values = { campaignId: 23, platforms: ['meta'], _review_validation_error: 'Loading…' };
  await widgetApi.updateFormValues(41, values);
  expect(api.patch).toHaveBeenCalledWith('/api/widgets/41', { formValues: { campaignId: 23, platforms: ['meta'] } });
  expect(values._review_validation_error).toBe('Loading…');
});
it('does not strip approval blockers from submission payloads', async () => {
  const values = { campaignId: 23, platforms: ['meta'], _review_validation_error: 'Invalid target' };
  await widgetApi.submitWidget(41, values);
  expect(api.post).toHaveBeenCalledWith('/api/widgets/41/submit', { values });
});
