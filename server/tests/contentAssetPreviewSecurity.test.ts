/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  contentAssetPreviewSchema,
  contentAssetPreviewUpdateSchema,
} from '../middleware/schemas';

const previewModel = {
  findAllForUser: jest.fn<any>(),
  findByLeadIdForUser: jest.fn<any>(),
  createForUser: jest.fn<any>(),
  updateForUser: jest.fn<any>(),
};
const leadModel = {
  findByIdForUser: jest.fn<any>(),
};

jest.unstable_mockModule('../models/contentAssetPreviews/functions', () => ({
  ContentAssetPreviewModel: previewModel,
}));
jest.unstable_mockModule('../models/leads/functions', () => ({
  LeadModel: leadModel,
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));

const { mockAuthRequest, mockResponse } = await import('./helpers/mockHelpers');
const controller = await import('../controllers/contentAssetPreviewController');

const validPreview = {
  type: 'text_image',
  message: 'A tenant-owned preview',
  imageUrl: '/uploads/images/preview.png',
  channel: 'linkedin',
  leadId: 11,
  status: 'pending_approval',
} as const;

describe('content asset preview tenant boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    previewModel.findAllForUser.mockResolvedValue([]);
    previewModel.findByLeadIdForUser.mockResolvedValue([]);
    previewModel.createForUser.mockResolvedValue({ id: 1 });
    previewModel.updateForUser.mockResolvedValue({ id: 1 });
    leadModel.findByIdForUser.mockResolvedValue({
      id: 11,
      fullName: 'Canonical Lead',
      name: null,
      firstName: null,
      lastName: null,
    });
  });

  it('scopes list reads to the authenticated user', async () => {
    const req = mockAuthRequest(42);
    const res = mockResponse();

    await controller.getContentAssetPreviews(req, res);

    expect(previewModel.findAllForUser).toHaveBeenCalledWith(42);
    expect(res._status).toBe(200);
  });

  it('scopes lead-filtered reads to both lead and authenticated user', async () => {
    const req = mockAuthRequest(42, { query: { leadId: '11' } });
    const res = mockResponse();

    await controller.getContentAssetPreviews(req, res);

    expect(previewModel.findByLeadIdForUser).toHaveBeenCalledWith(11, 42);
  });

  it('does not create a preview for another tenant lead', async () => {
    leadModel.findByIdForUser.mockResolvedValue(undefined);
    const req = mockAuthRequest(42, { body: validPreview });
    const res = mockResponse();

    await controller.createContentAssetPreview(req, res);

    expect(leadModel.findByIdForUser).toHaveBeenCalledWith(11, 42);
    expect(previewModel.createForUser).not.toHaveBeenCalled();
    expect(res._status).toBe(404);
  });

  it('derives ownership and lead name server-side on create', async () => {
    const req = mockAuthRequest(42, {
      body: {
        ...validPreview,
        userId: 999,
        leadName: 'Spoofed name',
      },
    });
    const res = mockResponse();

    await controller.createContentAssetPreview(req, res);

    expect(previewModel.createForUser).toHaveBeenCalledWith(42, {
      type: 'text_image',
      message: 'A tenant-owned preview',
      imageUrl: '/uploads/images/preview.png',
      videoUrl: undefined,
      channel: 'linkedin',
      leadId: 11,
      leadName: 'Canonical Lead',
      status: 'pending_approval',
    });
    expect(res._status).toBe(201);
  });

  it('does not allow an update to reassign tenant or lead ownership', async () => {
    const req = mockAuthRequest(42, {
      params: { id: '7' },
      body: {
        status: 'approved',
        userId: 999,
        leadId: 999,
        leadName: 'Spoofed name',
      },
    });
    const res = mockResponse();

    await controller.updateContentAssetPreview(req, res);

    expect(previewModel.updateForUser).toHaveBeenCalledWith(7, 42, {
      status: 'approved',
    });
  });
});

describe('content asset preview request validation', () => {
  it('accepts the persisted preview contract', () => {
    expect(contentAssetPreviewSchema.safeParse(validPreview).success).toBe(true);
  });

  it('rejects legacy mismatched and ownership-controlled fields', () => {
    expect(contentAssetPreviewSchema.safeParse({
      assetId: 1,
      variant: 'a',
      content: 'legacy payload',
    }).success).toBe(false);
    expect(contentAssetPreviewSchema.safeParse({
      ...validPreview,
      userId: 42,
      leadName: 'Caller supplied',
    }).success).toBe(false);
  });

  it('requires media for the corresponding preview type', () => {
    expect(contentAssetPreviewSchema.safeParse({
      ...validPreview,
      imageUrl: undefined,
    }).success).toBe(false);
    expect(contentAssetPreviewSchema.safeParse({
      ...validPreview,
      type: 'text_video',
      imageUrl: undefined,
      videoUrl: undefined,
    }).success).toBe(false);
  });

  it('allows only mutable fields on update', () => {
    expect(contentAssetPreviewUpdateSchema.safeParse({ status: 'approved' }).success).toBe(true);
    expect(contentAssetPreviewUpdateSchema.safeParse({}).success).toBe(false);
    expect(contentAssetPreviewUpdateSchema.safeParse({
      status: 'approved',
      userId: 42,
      leadId: 11,
    }).success).toBe(false);
  });

  it('requires corresponding media when changing the preview type', () => {
    expect(contentAssetPreviewUpdateSchema.safeParse({
      type: 'text_image',
    }).success).toBe(false);
    expect(contentAssetPreviewUpdateSchema.safeParse({
      type: 'text_video',
      videoUrl: '/uploads/videos/preview.mp4',
    }).success).toBe(true);
  });
});
