/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const adsModel = {
  getAd: jest.fn<any>(),
  getAds: jest.fn<any>(),
  getAdsByCampaignId: jest.fn<any>(),
  createAd: jest.fn<any>(),
  updateAd: jest.fn<any>(),
  deleteAd: jest.fn<any>(),
  userOwnsAdCampaign: jest.fn<any>(),
};
const createPerformanceCampaign = jest.fn<any>();

jest.unstable_mockModule('../models/ads/functions', () => adsModel);
jest.unstable_mockModule('../models/db', () => ({
  db: { execute: jest.fn<any>().mockResolvedValue({ rows: [] }) },
}));
jest.unstable_mockModule('../models/metaPageConnections/functions', () => ({
  getMetaAdsCreds: jest.fn<any>().mockResolvedValue(null),
}));
jest.unstable_mockModule('../models/performanceAdCampaigns/functions.js', () => ({
  PerformanceAdCampaignModel: { create: createPerformanceCampaign },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../services/NotificationService.js', () => ({
  NotificationService: { adCampaignPublished: jest.fn() },
}));
jest.unstable_mockModule('../utils/metaApiVersion.js', () => ({
  getGraphApiBase: jest.fn<any>().mockResolvedValue('https://graph.facebook.com/v24.0'),
  getGraphApiVersion: jest.fn<any>().mockResolvedValue('v24.0'),
}));

const { mockAuthRequest, mockResponse } = await import('./helpers/mockHelpers');
const controller = await import('../controllers/adsController');

describe('Ads tenant and persistence boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adsModel.getAd.mockResolvedValue(undefined);
    adsModel.getAds.mockResolvedValue([]);
    adsModel.getAdsByCampaignId.mockResolvedValue([]);
    adsModel.userOwnsAdCampaign.mockResolvedValue(false);
    adsModel.deleteAd.mockResolvedValue(false);
    createPerformanceCampaign.mockResolvedValue({ id: 91 });
  });

  it('scopes ad reads to the authenticated tenant', async () => {
    adsModel.getAd.mockResolvedValue({ id: 7, campaignId: 12 });
    const req = mockAuthRequest(42, { params: { id: '7' } });
    const res = mockResponse();

    await controller.getAdHandler(req, res);

    expect(adsModel.getAd).toHaveBeenCalledWith(7, 42);
    expect(res._status).toBe(200);
  });

  it('does not create an ad under another tenant campaign', async () => {
    const req = mockAuthRequest(42, {
      body: {
        campaignId: 12,
        platform: 'meta',
        adName: 'Launch creative',
        status: 'draft',
        startDate: '2026-08-01T00:00:00.000Z',
      },
    });
    const res = mockResponse();

    await controller.createAdHandler(req, res);

    expect(res._status).toBe(404);
    expect(adsModel.createAd).not.toHaveBeenCalled();
  });

  it('rejects mass-assignment fields on ad updates', async () => {
    const req = mockAuthRequest(42, { params: { id: '7' }, body: { id: 99, status: 'active' } });
    const res = mockResponse();

    await controller.updateAdHandler(req, res);

    expect(res._status).toBe(400);
    expect(adsModel.updateAd).not.toHaveBeenCalled();
  });

  it('returns not found when a scoped ad deletion matches no record', async () => {
    const req = mockAuthRequest(42, { params: { id: '7' } });
    const res = mockResponse();

    await controller.deleteAdHandler(req, res);

    expect(adsModel.deleteAd).toHaveBeenCalledWith(7, 42);
    expect(res._status).toBe(404);
  });

  it('keeps the retired draft export inert, matching the mounted 410 contract', async () => {
    const req = mockAuthRequest(42, {
      body: {
        platforms: ['meta'],
        campaignName: 'August Launch',
        objective: 'OUTCOME_TRAFFIC',
        budgetType: 'DAILY',
        dailyBudget: 100000,
        currency: 'INR',
        startTime: 1785542400,
        endTime: 1788134400,
        targeting: { age_min: 18, geo_locations: { countries: ['IN'] } },
        adsets: [{ id: 'creative-1', title: 'Launch', content: 'New offer' }],
        status: 'draft',
      },
    });
    const res = mockResponse();

    await controller.saveCampaignDraftHandler(req, res);

    expect(res._status).toBe(410);
    expect(createPerformanceCampaign).not.toHaveBeenCalled();
    expect(res._json.error).toContain('publish=false');
  });
  it('keeps the retired publisher inert even when invoked directly',async()=>{
    const res=mockResponse();await controller.publishCampaignHandler(mockAuthRequest(42,{body:{}}),res);
    expect(res._status).toBe(410);expect(createPerformanceCampaign).not.toHaveBeenCalled();
  });

});
