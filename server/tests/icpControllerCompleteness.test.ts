import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { mockAuthRequest, mockResponse } from './helpers/mockHelpers.js';

const create = jest.fn<(...args: any[]) => Promise<any>>();
const read = jest.fn<(...args: any[]) => Promise<any>>();
const update = jest.fn<(...args: any[]) => Promise<any>>();
const awaiting = jest.fn<(...args: any[]) => Promise<void>>();
jest.unstable_mockModule('../models/icpData/functions', () => ({ createIcpData: create, getIcpDataById: read, updateIcpData: update }));
jest.unstable_mockModule('../models/db', () => ({ db: {} }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: { icpGenerated: jest.fn() } }));
jest.unstable_mockModule('../models/conversationWorkflow/functions.js', () => ({ markIcpRevisionAwaitingApproval: awaiting }));
const { createIcpProfileHandler, updateIcpHandler } = await import('../controllers/icpController.js');
const profile = { id: 7, userId: 1, threadId: 221, revision: 2, approved: true,
  campaignName: 'Synthetic hotel campaign', targetAudience: 'Hotel owners', summary: 'A saved profile summary', primaryRegions: ['Coimbatore'] };
const scope = <T>(work: () => T) => withBusinessScope({ userId: 1, businessProfileId: 10 }, work);

beforeEach(() => {
  jest.clearAllMocks();
  create.mockImplementation(async data => ({ ...data, id: 8, revision: 1 }));
  read.mockResolvedValue(profile);
  update.mockImplementation(async (_id, data) => ({ ...profile, ...data }));
  awaiting.mockResolvedValue(undefined);
});

describe('manual ICP completeness uses the saved-field scoring contract', () => {
  it('counts a persisted summary during profile creation', async () => {
    const response = mockResponse();
    await scope(() => createIcpProfileHandler(mockAuthRequest(1, { body: profile }), response));
    expect(response._status).toBe(201);
    expect(response._json.icp.fitScore).toBe(27);
  });
  it('scores the merged saved profile and invalidates approval on edit', async () => {
    const response = mockResponse();
    await scope(() => updateIcpHandler(mockAuthRequest(1, { params: { id: '7' }, body: { summary: 'Updated summary' } }), response));
    expect(response._status).toBe(200);
    expect(update).toHaveBeenCalledWith(7, expect.objectContaining({ fitScore: 27, approved: false, approvedRevision: null, revision: 3 }));
    expect(awaiting).toHaveBeenCalledWith(expect.objectContaining({ icpId: 7, revision: 3, threadId: 221 }));
  });
});
