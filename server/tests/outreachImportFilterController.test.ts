import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';

const recipients = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const sources = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../services/outreach/CreationService.js', () => ({
  getCreationRecipients: recipients, getCreationOptions: jest.fn(), getCreationTemplates: jest.fn(), prepareCreationContact: jest.fn(),
}));
jest.unstable_mockModule('../services/outreach/CreationImportSources.js', () => ({ getCreationImportSources: sources }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));
const { getOutreachCreationRecipients, getOutreachCreationImportSources } = await import('../controllers/outreachCreationController.js');
const scope = <T>(work: () => T) => withBusinessScope({ userId: 1, businessProfileId: 10 }, work);
function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

beforeEach(() => { jest.clearAllMocks(); recipients.mockResolvedValue({ recipients: [], nextCursor: null }); sources.mockResolvedValue({ campaigns: [], crmImports: [] }); });

describe('outreach import filter API', () => {
  it.each(['email', 'whatsapp', 'sms', 'instagram', 'facebook'])('passes campaign and upload filters for %s', async channel => {
    const res = response();
    await scope(() => getOutreachCreationRecipients({ user: { id: 1 }, query: { channel, importSource: 'campaign', campaignId: '22', importId: '7', after: '3' } } as any, res as any));
    expect(recipients).toHaveBeenCalledWith(1, channel, expect.any(Object), expect.objectContaining({
      after: 3, importFilter: { source: 'campaign', campaignId: 22, importId: 7 },
    }));
    expect(res.json).toHaveBeenCalled();
  });
  it('supports CRM, historical campaign and unassigned upload filters', async () => {
    for (const [query, filter] of [
      [{ importSource: 'crm', importId: '9' }, { source: 'crm', importId: 9 }],
      [{ importSource: 'campaign_legacy', campaignId: '22' }, { source: 'campaign_legacy', campaignId: 22 }],
      [{ importSource: 'campaign', campaignId: 'unassigned' }, { source: 'campaign', campaignId: 'unassigned' }],
    ] as const) {
      const res = response();
      await scope(() => getOutreachCreationRecipients({ user: { id: 1 }, query: { channel: 'email', ...query } } as any, res as any));
      expect(recipients).toHaveBeenLastCalledWith(1, 'email', expect.any(Object), expect.objectContaining({ importFilter: filter }));
    }
  });
  it.each([
    { importSource: ['crm'] }, { importSource: 'crm', campaignId: '22' },
    { importSource: 'campaign_legacy', importId: '7' }, { importId: '7' },
    { importSource: 'campaign', ids: '1' }, { importSource: 'campaign', threadId: '22' },
    { importSource: 'campaign', campaignId: '-1' },
  ])('rejects invalid or ambiguous filter combinations', async query => {
    const res = response();
    await scope(() => getOutreachCreationRecipients({ user: { id: 1 }, query: { channel: 'email', ...query } } as any, res as any));
    expect(res.status).toHaveBeenCalledWith(400);
    expect(recipients).not.toHaveBeenCalled();
  });
  it('returns only sources for the current business owner', async () => {
    const res = response();
    await scope(() => getOutreachCreationImportSources({ user: { id: 1 } } as any, res as any));
    expect(sources).toHaveBeenCalledWith(1);
    expect(res.json).toHaveBeenCalledWith({ campaigns: [], crmImports: [] });
  });
});
