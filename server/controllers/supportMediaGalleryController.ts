import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from 'express';
import { boundedUpload } from '../middleware/boundedUpload.js';
import { supportMediaGalleryService } from '../services/supportMedia/SupportMediaGalleryService.js';
import { GalleryCreationConflict } from '../services/supportMedia/GalleryCreationConflict.js';
import { storageService } from '../services/StorageService.js';
import { withTenantSupportMediaTransaction } from '../services/supportMedia/SupportMediaTenantTransaction.js';
import { sql } from 'drizzle-orm';
import { contentDisposition } from '../utils/contentDisposition.js';
import { supportMediaDeliveryService } from '../services/supportMedia/SupportMediaDeliveryService.js';

function userId(req: Request) { return Number(businessOwnerUserId(req) || 0); }
function id(value: string | string[] | undefined) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0; }
function errorResponse(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : 'Media gallery request failed.';
  return res.status(error instanceof GalleryCreationConflict ? 409 : /not found/i.test(message) ? 404 : 400).json({ success: false, error: message });
}

export const supportMediaUpload = boundedUpload({
  field: 'images', files: 5, mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
});
export const supportMediaReplaceUpload = boundedUpload({
  field: 'image', files: 1, single: true, mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
});

export async function listSupportMediaGalleries(req: Request, res: Response) {
  try { return res.json({ success: true, data: await supportMediaGalleryService.list(userId(req)) }); }
  catch (error) { return errorResponse(res, error); }
}

export async function getSupportMediaGallery(req: Request, res: Response) {
  try {
    const data = await supportMediaGalleryService.get(userId(req), id(req.params.id));
    return data ? res.json({ success: true, data }) : res.status(404).json({ success: false, error: 'Gallery not found.' });
  } catch (error) { return errorResponse(res, error); }
}

export async function createSupportMediaGallery(req: Request, res: Response) {
  try {
    const data = await supportMediaGalleryService.create(userId(req), {
      ...req.body,
      creationRequestKey: req.header('Idempotency-Key'),
      businessProfileId: req.body.businessProfileId ? Number(req.body.businessProfileId) : null,
      rightsCertified: req.body.rightsCertified === true,
      helpfulAutoAttach: req.body.helpfulAutoAttach === true,
    });
    return res.status(201).json({ success: true, data });
  } catch (error) { return errorResponse(res, error); }
}

export async function updateSupportMediaGallery(req: Request, res: Response) {
  try {
    const data = await supportMediaGalleryService.update(userId(req), id(req.params.id), {
      title: req.body.title,
      description: req.body.description,
      entityTags: Array.isArray(req.body.entityTags) ? req.body.entityTags : [],
      helpfulAutoAttach: req.body.helpfulAutoAttach === true,
      businessProfileId: req.body.businessProfileId === undefined ? undefined : req.body.businessProfileId ? Number(req.body.businessProfileId) : null,
      audience: req.body.audience,
      allowedChannels: req.body.allowedChannels,
      usageScopes: req.body.usageScopes,
    });
    return res.json({ success: true, data });
  } catch (error) { return errorResponse(res, error); }
}

export async function uploadSupportMediaAssets(req: Request, res: Response) {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    const metadata = JSON.parse(String(req.body.metadata || '[]')) as Array<{ name: string; description?: string; altText?: string; tags?: string[] }>;
    const data = await supportMediaGalleryService.addImages(userId(req), id(req.params.id), files, metadata);
    return res.status(201).json({ success: true, data });
  } catch (error) { return errorResponse(res, error); }
}

export async function updateSupportMediaAsset(req: Request, res: Response) {
  try {
    const data = await supportMediaGalleryService.updateAsset(userId(req), id(req.params.id), id(req.params.assetId), {
      name: req.body.name,
      description: req.body.description,
      altText: req.body.altText,
      tags: Array.isArray(req.body.tags) ? req.body.tags : [],
      sortOrder: Number.isSafeInteger(req.body.sortOrder) ? req.body.sortOrder : Number(req.body.sortOrder),
    });
    return res.json({ success: true, data });
  } catch (error) { return errorResponse(res, error); }
}

export async function replaceSupportMediaAsset(req: Request, res: Response) {
  try {
    const metadata = JSON.parse(String(req.body.metadata || '{}')) as {
      name: string; description?: string; altText?: string; tags?: string[]; sortOrder?: number;
    };
    const data = await supportMediaGalleryService.replaceAsset(
      userId(req), id(req.params.id), id(req.params.assetId), req.file as Express.Multer.File, metadata,
    );
    return res.json({ success: true, data });
  } catch (error) { return errorResponse(res, error); }
}

export async function retireSupportMediaAsset(req: Request, res: Response) {
  try {
    const data = await supportMediaGalleryService.retireAsset(userId(req), id(req.params.id), id(req.params.assetId));
    return res.json({ success: true, data });
  } catch (error) { return errorResponse(res, error); }
}

export async function retrySupportMediaScans(req: Request, res: Response) {
  try { return res.json({ success: true, data: await supportMediaGalleryService.retryScans(userId(req), id(req.params.id)) }); }
  catch (error) { return errorResponse(res, error); }
}

export async function reviewSupportMediaAsset(req: Request, res: Response) {
  try { return res.json({ success: true, data: await supportMediaGalleryService.reviewAsset(
    userId(req), id(req.params.id), id(req.params.assetId), req.body.decision, req.body.reason,
  ) }); } catch (error) { return errorResponse(res, error); }
}

export async function listUncertainMediaDeliveries(req: Request, res: Response) {
  try { return res.json({ success: true, data: await supportMediaDeliveryService.pendingReconciliation(userId(req)) }); }
  catch (error) { return errorResponse(res, error); }
}

export async function reconcileMediaDelivery(req: Request, res: Response) {
  try { return res.json({ success: true, data: await supportMediaDeliveryService.reconcile(userId(req), id(req.params.partId), req.body) }); }
  catch (error) { return errorResponse(res, error); }
}

export async function retryMediaDelivery(req: Request, res: Response) {
  try { return res.json({ success: true, data: await supportMediaDeliveryService.retryFailedPart(userId(req), id(req.params.partId)) }); }
  catch (error) { return errorResponse(res, error); }
}

export async function retireSupportMediaGallery(req: Request, res: Response) {
  try { return res.json({ success: true, data: await supportMediaGalleryService.retire(userId(req), id(req.params.id)) }); }
  catch (error) { return errorResponse(res, error); }
}

export async function downloadSupportMediaAsset(req: Request, res: Response) {
  try {
    const tenantId = userId(req);
    const result = await withTenantSupportMediaTransaction(tenantId, async (tx) => tx.execute(sql`
      SELECT derivative_storage_file_id,mime_type,name FROM support_media_assets
      WHERE id=${id(req.params.assetId)} AND user_id=${tenantId} AND retired_at IS NULL LIMIT 1
    `));
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return res.status(404).json({ success: false, error: 'Media asset not found.' });
    const file = await storageService.downloadFile(Number(row.derivative_storage_file_id), tenantId);
    if (!file) return res.status(404).json({ success: false, error: 'Media bytes not found.' });
    res.setHeader('Content-Type', String(row.mime_type));
    res.setHeader('Content-Disposition', contentDisposition(`${String(row.name || 'support-media')}.jpg`));
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(file.buffer);
  } catch (error) { return errorResponse(res, error); }
}
