import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { storageService } from '../services/StorageService.js';
import { withTenantSupportMediaTransaction } from '../services/supportMedia/SupportMediaTenantTransaction.js';
import { resolveSupportMediaSignedCapability } from '../services/supportMedia/SupportMediaSignedCapability.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { verifySupportMediaDeliveryToken } from '../services/supportMedia/SupportMediaDeliveryUrl.js';
import { logger } from '../utils/logger.js';

const DELIVERY_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Serve a published derivative to a provider using a short-lived asset-bound token. */
export async function getSupportMediaDeliveryAsset(req: Request, res: Response) {
  const assetId = Number(req.params.assetId);
  const expiresAt = Number(req.query.expires);
  const token = String(req.query.token || '');
  if (!Number.isSafeInteger(assetId) || assetId <= 0 || !Number.isSafeInteger(expiresAt) || !token) {
    return res.status(404).end();
  }

  try {
    const capability = await resolveSupportMediaSignedCapability({ assetId, expiresAt, token });
    if (!capability) return res.status(404).end();
    return await withBusinessScope({ userId: capability.userId, businessProfileId: capability.businessProfileId }, async () => {
      const loadAsset = async () => {
        const result = await withTenantSupportMediaTransaction(capability.userId, async (tx) => tx.execute(sql`
          SELECT a.user_id,a.business_profile_id,a.derivative_storage_file_id,a.mime_type,a.name,a.checksum
          FROM support_media_assets a
          JOIN company_settings p ON p.id=a.business_profile_id AND p.user_id=a.user_id AND p.archived_at IS NULL
          JOIN users owner_account ON owner_account.id=a.user_id AND owner_account.deleted_at IS NULL
          JOIN support_media_galleries g
            ON g.id=a.gallery_id AND g.user_id=a.user_id
            AND g.business_profile_id=a.business_profile_id
            AND g.status='active' AND g.audience='customer' AND g.current_published_version_id=a.gallery_version_id
          JOIN support_media_gallery_versions v
            ON v.id=a.gallery_version_id AND v.user_id=a.user_id AND v.gallery_id=a.gallery_id
            AND v.business_profile_id=a.business_profile_id
            AND v.status='published'
            AND (v.effective_at IS NULL OR v.effective_at <= NOW())
            AND (v.expires_at IS NULL OR v.expires_at > NOW())
          WHERE a.id=${assetId} AND a.publication_state='published' AND a.retired_at IS NULL
            AND a.user_id=${capability.userId} AND a.business_profile_id=${capability.businessProfileId}
            AND a.checksum=${capability.checksum}
            AND a.sensitivity IN ('public','business')
          LIMIT 1
        `));
        return result.rows[0] as Record<string, unknown> | undefined;
      };
      const asset = await loadAsset();
      if (!asset || !verifySupportMediaDeliveryToken({
        assetId,
        checksum: String(asset.checksum || ''),
        expiresAt,
        token,
      })) return res.status(404).end();

      const mimeType = String(asset.mime_type || '');
      if (!DELIVERY_IMAGE_MIME_TYPES.has(mimeType)) return res.status(404).end();
      const userId = capability.userId;
      const file = await storageService.downloadFile(Number(asset.derivative_storage_file_id), userId);
      if (!file || file.file.userId !== userId || Number(file.file.businessProfileId) !== capability.businessProfileId) return res.status(404).end();
      const current = await loadAsset();
      if (!current || current.checksum !== asset.checksum || current.mime_type !== asset.mime_type
        || Number(current.user_id) !== capability.userId || Number(current.business_profile_id) !== capability.businessProfileId
        || Number(current.derivative_storage_file_id) !== Number(asset.derivative_storage_file_id)
        || !verifySupportMediaDeliveryToken({ assetId, checksum: String(current.checksum || ''), expiresAt, token })) {
        return res.status(404).end();
      }

      const fileName = String(asset.name || 'support-image').replace(/[^\x20-\x7E]/g, '_').replace(/["\\;]/g, '_').slice(0, 150);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${fileName || 'support-image'}"`);
      res.setHeader('Content-Length', String(file.buffer.length));
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:");
      return res.send(file.buffer);
    });
  } catch (error) {
    logger.error({ err: error, assetId }, '[SupportMedia] Signed delivery failed');
    return res.status(404).end();
  }
}
