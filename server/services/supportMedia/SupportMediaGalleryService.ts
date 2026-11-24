import { readFile } from 'node:fs/promises';
import { businessAuditActor } from '../../tenancy/businessContext.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { storageService } from '../StorageService.js';
import { withTenantSupportMediaTransaction } from './SupportMediaTenantTransaction.js';
import { scanSupportMedia } from './SupportMediaSafetyService.js';
import { validateSupportMediaMetadata } from './SupportMediaSafetyService.js';
import { embeddingService } from '../embeddings/EmbeddingService.js';
import { GalleryCreationConflict } from './GalleryCreationConflict.js';
import { resultRows as rows } from '../../utils/queryRows.js';

export interface CreateGalleryInput {
  creationRequestKey?: string;
  title: string;
  description?: string;
  businessProfileId?: number | null;
  audience?: 'customer' | 'internal';
  usageScopes?: string[];
  allowedChannels?: string[];
  locale?: string;
  productScope?: Record<string, unknown>;
  entityTags?: string[];
  helpfulAutoAttach?: boolean;
  rightsCertified: boolean;
  certification: { lawfulAuthority: boolean; customerUsePermitted: boolean; accuracyConfirmed: boolean };
}

function canonicalCreationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCreationValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalCreationValue(item)]));
  return value;
}

export interface UpdateGalleryInput {
  title: string;
  description?: string;
  entityTags?: string[];
  helpfulAutoAttach?: boolean;
  businessProfileId?: number | null;
  audience?: 'customer' | 'internal';
  allowedChannels?: string[];
  usageScopes?: string[];
}

export interface UpdateAssetInput {
  name: string;
  description?: string;
  altText?: string;
  tags?: string[];
  sortOrder?: number;
}

function cleanList(value: string[] | undefined, max = 30) {
  return [...new Set((value || []).map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, max);
}

function gallerySnapshot(gallery: Record<string, unknown>) {
  return Object.fromEntries(['title', 'description', 'business_profile_id', 'audience', 'usage_scopes',
    'allowed_channels', 'locale', 'product_scope', 'entity_tags', 'helpful_auto_attach'].map((key) => [key, gallery[key]]));
}

function validateGalleryScope(input: Partial<CreateGalleryInput>) {
  if (input.audience !== undefined && !['customer', 'internal'].includes(input.audience)) throw new Error('Choose customer or internal audience.');
  const channels = ['web', 'whatsapp', 'instagram', 'facebook', 'email'];
  const scopes = ['support_answer', 'outreach_reply', 'hotel_policy', 'internal_assist'];
  for (const [values, allowed] of [[input.allowedChannels, channels], [input.usageScopes, scopes]] as const) {
    if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !allowed.includes(value)))) {
      throw new Error('Choose supported media channels and usage scopes.');
    }
  }
  if (input.businessProfileId != null && (!Number.isSafeInteger(input.businessProfileId) || input.businessProfileId <= 0)) {
    throw new Error('Choose a valid business profile.');
  }
}

export function mediaUploadFingerprint(file: Pick<Express.Multer.File, 'buffer'>, metadata: unknown): string {
  return crypto.createHash('sha256').update(file.buffer).update(JSON.stringify(metadata)).digest('hex');
}

/**
 * Drizzle's raw SQL parameter encoder treats a JavaScript array as a PostgreSQL
 * composite record. Build text[] values from a JSON parameter so every element
 * remains parameterized while PostgreSQL receives the column's actual type.
 */
function textArrayExpression(value: string[] | undefined, max = 30) {
  return sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(cleanList(value, max))}::jsonb))`;
}

async function indexMediaAsset(userId: number, assetId: number, searchText: string): Promise<void> {
  try {
    const descriptor = await withTenantSupportMediaTransaction(userId, async (tx) => rows(await tx.execute(sql`
      SELECT iv.id,iv.provider,iv.model,iv.dimensions
      FROM knowledge_runtime_settings rs JOIN knowledge_index_versions iv ON iv.id=rs.active_index_version_id
      WHERE rs.id=1 AND iv.state='active' LIMIT 1
    `))[0]);
    if (!descriptor) return;
    const generated = await embeddingService.generateEmbedding({
      text: searchText,
      provider: String(descriptor.provider) as 'openai' | 'gemini',
      model: String(descriptor.model),
      userId,
    });
    if (generated.dimensions !== Number(descriptor.dimensions) || generated.vector.some((value) => !Number.isFinite(value))) return;
    const vectorLiteral = `[${generated.vector.join(',')}]`;
    const contentHash = crypto.createHash('sha256').update(searchText).digest('hex');
    await withTenantSupportMediaTransaction(userId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO support_media_asset_embeddings(user_id,asset_id,index_version_id,provider,model,dimensions,content_hash,embedding)
        VALUES (${userId},${assetId},${Number(descriptor.id)},${generated.provider},${generated.model},${generated.dimensions},${contentHash},
          ${sql.raw(`'${vectorLiteral}'::vector`)})
        ON CONFLICT (asset_id,index_version_id) DO UPDATE SET provider=EXCLUDED.provider,model=EXCLUDED.model,
          dimensions=EXCLUDED.dimensions,content_hash=EXCLUDED.content_hash,embedding=EXCLUDED.embedding,created_at=NOW()
      `);
    });
  } catch {
    // Lexical search remains available. Nightly index repair can retry this asset.
  }
}

export class SupportMediaGalleryService {
  async list(userId: number) {
    return withTenantSupportMediaTransaction(userId, async (tx) => rows(await tx.execute(sql`
      SELECT g.*, v.status AS version_status, v.version_no, v.metadata_snapshot,
             COUNT(a.id)::INTEGER AS asset_count,
             COUNT(a.id) FILTER (WHERE a.publication_state = 'published')::INTEGER AS published_asset_count
      FROM support_media_galleries g
      LEFT JOIN support_media_gallery_versions v ON v.id =
        (SELECT id FROM support_media_gallery_versions WHERE gallery_id = g.id ORDER BY version_no DESC LIMIT 1)
      LEFT JOIN support_media_assets a ON a.gallery_version_id = v.id AND a.retired_at IS NULL
      WHERE g.user_id = ${userId} AND g.status = 'active'
      GROUP BY g.id, v.id
      ORDER BY g.updated_at DESC
    `)).map((gallery) => ({ ...gallery, ...(gallery.metadata_snapshot as Record<string, unknown> || {}) })));
  }

  async get(userId: number, galleryId: number): Promise<(Record<string, unknown> & { assets: Record<string, unknown>[] }) | null> {
    return withTenantSupportMediaTransaction(userId, async (tx) => {
      const gallery = rows(await tx.execute(sql`
        SELECT g.*, v.id AS version_id, v.version_no, v.status AS version_status,
               v.rights_certified, v.certification, v.scan_results, v.metadata_snapshot
        FROM support_media_galleries g
        LEFT JOIN LATERAL (
          SELECT * FROM support_media_gallery_versions WHERE gallery_id = g.id ORDER BY version_no DESC LIMIT 1
        ) v ON TRUE
        WHERE g.user_id = ${userId} AND g.id = ${galleryId} AND g.status = 'active'
      `))[0];
      if (!gallery) return null;
      const assets = rows(await tx.execute(sql`
        SELECT id, evidence_id, name, owner_description, alt_text, sort_order, width, height,
               mime_type, size_bytes, owner_tags, internal_tags, publication_state, scan_results
        FROM support_media_assets
        WHERE user_id = ${userId} AND gallery_version_id = ${Number(gallery.version_id)} AND retired_at IS NULL
        ORDER BY sort_order, id
      `));
      return { ...gallery, ...(gallery.metadata_snapshot as Record<string, unknown> || {}), assets };
    });
  }

  async create(userId: number, input: CreateGalleryInput) {
    validateGalleryScope(input);
    const title = input.title?.trim().slice(0, 180);
    if (!title) throw new Error('A gallery title is required.');
    if (!input.rightsCertified || !input.certification?.lawfulAuthority
      || !input.certification?.customerUsePermitted || !input.certification?.accuracyConfirmed) {
      throw new Error('Owner certification is required before images can be published.');
    }
    const metadataSafety = validateSupportMediaMetadata([title, input.description, ...(input.entityTags || [])].filter(Boolean).join('\n'));
    if (!metadataSafety.safe) throw new Error(`Gallery metadata failed privacy or integrity checks: ${metadataSafety.reasons.join(', ')}.`);
    const requestKey = input.creationRequestKey;
    if (requestKey !== undefined && !/^[A-Za-z0-9_-]{16,100}$/.test(requestKey)) throw new Error('Invalid gallery creation request identity.');
    const scope = requestKey ? requireBusinessScope() : undefined;
    const actorId = requestKey ? businessAuditActor(userId) : undefined;
    const requestHash = requestKey ? crypto.createHash('sha256').update(JSON.stringify(canonicalCreationValue({
      title, description: input.description?.trim().slice(0, 4000) || null,
      businessProfileId: input.businessProfileId || scope!.businessProfileId,
      audience: input.audience || 'customer', usageScopes: cleanList(input.usageScopes?.length ? input.usageScopes : ['support_answer'], 30),
      allowedChannels: cleanList(input.allowedChannels, 30), locale: input.locale?.trim().slice(0, 24) || null,
      productScope: input.productScope || {}, entityTags: cleanList(input.entityTags, 30),
      helpfulAutoAttach: input.helpfulAutoAttach === true, certification: input.certification,
    }))).digest('hex') : undefined;
    return withTenantSupportMediaTransaction(userId, async (tx) => {
      if (requestKey) {
        // Serialize the parent receipt and its first version in the same transaction.
        const identity = `${userId}:${scope!.businessProfileId}:${actorId}:${requestKey}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity},0))`);
        const existing = rows(await tx.execute(sql`SELECT * FROM support_media_galleries WHERE user_id=${userId}
          AND business_profile_id=${scope!.businessProfileId} AND creation_actor_user_id=${actorId!}
          AND creation_request_key=${requestKey} LIMIT 1`))[0];
        if (existing) {
          if (existing.creation_request_hash !== requestHash) throw new GalleryCreationConflict('This creation request already has different gallery details. Resolve the saved draft before starting another.');
          if (existing.status !== 'active') throw new GalleryCreationConflict('The gallery for this creation request was retired. Start a new gallery explicitly.');
          const version = rows(await tx.execute(sql`SELECT * FROM support_media_gallery_versions WHERE gallery_id=${Number(existing.id)}
            AND user_id=${userId} ORDER BY version_no LIMIT 1`))[0];
          return { ...existing, version };
        }
      }
      if (input.businessProfileId) {
        const profile = rows(await tx.execute(sql`SELECT id FROM company_settings WHERE id=${input.businessProfileId} AND user_id=${userId} LIMIT 1`))[0];
        if (!profile) throw new Error('The selected business profile is not available to this tenant.');
      }
      const gallery = rows(await tx.execute(sql`
        INSERT INTO support_media_galleries(
          user_id, business_profile_id, title, description, audience, usage_scopes,
          allowed_channels, locale, product_scope, entity_tags, helpful_auto_attach, owner_user_id
          ${requestKey ? sql`,creation_request_key,creation_request_hash,creation_actor_user_id` : sql``}
        ) VALUES (
          ${userId}, ${input.businessProfileId || null}, ${title}, ${input.description?.trim().slice(0, 4000) || null},
          ${input.audience || 'customer'}, ${textArrayExpression(input.usageScopes?.length ? input.usageScopes : ['support_answer'])},
          ${textArrayExpression(input.allowedChannels)}, ${input.locale?.trim().slice(0, 24) || null},
          ${JSON.stringify(input.productScope || {})}::jsonb, ${textArrayExpression(input.entityTags)}, ${input.helpfulAutoAttach === true}, ${userId}
          ${requestKey ? sql`,${requestKey},${requestHash!},${actorId!}` : sql``}
        ) RETURNING *
      `))[0];
      const checksum = crypto.createHash('sha256').update(JSON.stringify({ ...input, title, userId })).digest('hex');
      const version = rows(await tx.execute(sql`
        INSERT INTO support_media_gallery_versions(
          gallery_id, user_id, version_no, status, content_checksum, rights_certified, certification, metadata_snapshot
        ) VALUES (${Number(gallery.id)}, ${userId}, 1, 'draft', ${checksum}, TRUE, ${JSON.stringify(input.certification)}::jsonb, ${JSON.stringify(gallerySnapshot(gallery))}::jsonb)
        RETURNING *
      `))[0];
      return { ...gallery, version };
    });
  }

  private async editableVersion(userId: number, galleryId: number): Promise<Record<string, unknown>> {
    return withTenantSupportMediaTransaction(userId, async (tx) => {
      const current = rows(await tx.execute(sql`
        SELECT g.*, v.id AS version_id, v.version_no, v.status AS version_status,
               v.rights_certified, v.certification, v.metadata_snapshot
        FROM support_media_galleries g
        JOIN LATERAL (SELECT * FROM support_media_gallery_versions WHERE gallery_id=g.id ORDER BY version_no DESC LIMIT 1) v ON TRUE
        WHERE g.user_id=${userId} AND g.id=${galleryId} AND g.status='active'
        FOR UPDATE OF g
      `))[0];
      if (!current) throw new Error('Gallery not found.');
      if (current.version_status !== 'published') return { ...current, ...(current.metadata_snapshot as Record<string, unknown> || {}) };
      const nextNo = Number(current.version_no) + 1;
      const checksum = crypto.createHash('sha256').update(`${galleryId}:${nextNo}:${Date.now()}`).digest('hex');
      const version = rows(await tx.execute(sql`
        INSERT INTO support_media_gallery_versions(
          gallery_id,user_id,version_no,status,content_checksum,rights_certified,certification,supersedes_version_id,metadata_snapshot
        ) VALUES (${galleryId},${userId},${nextNo},'draft',${checksum},${Boolean(current.rights_certified)},
                  ${JSON.stringify(current.certification || {})}::jsonb,${Number(current.version_id)},${JSON.stringify(current.metadata_snapshot || {})}::jsonb) RETURNING *
      `))[0];
      await tx.execute(sql`
        INSERT INTO support_media_assets(
          user_id,gallery_id,gallery_version_id,storage_file_id,derivative_storage_file_id,evidence_id,
          name,owner_description,alt_text,sort_order,width,height,mime_type,size_bytes,checksum,sensitivity,
          owner_tags,internal_tags,search_text,publication_state,scan_results
        ) SELECT user_id,gallery_id,${Number(version.id)},storage_file_id,derivative_storage_file_id,
          CONCAT('media:',gallery_id,':',${Number(version.id)}::bigint,':',id),name,owner_description,alt_text,sort_order,
          width,height,mime_type,size_bytes,checksum,sensitivity,owner_tags,internal_tags,search_text,publication_state,scan_results
        FROM support_media_assets WHERE gallery_version_id=${Number(current.version_id)} AND retired_at IS NULL
      `);
      await tx.execute(sql`INSERT INTO support_media_asset_embeddings(user_id,asset_id,index_version_id,provider,model,dimensions,content_hash,embedding)
        SELECT e.user_id,copied.id,e.index_version_id,e.provider,e.model,e.dimensions,e.content_hash,e.embedding
        FROM support_media_asset_embeddings e JOIN support_media_assets original ON original.id=e.asset_id
        JOIN support_media_assets copied ON copied.gallery_version_id=${Number(version.id)} AND copied.user_id=e.user_id
          AND copied.evidence_id=CONCAT('media:',${galleryId}::bigint,':',${Number(version.id)}::bigint,':',original.id)
        WHERE e.user_id=${userId} AND original.gallery_version_id=${Number(current.version_id)} ON CONFLICT DO NOTHING`);
      return { ...current, ...(current.metadata_snapshot as Record<string, unknown> || {}), version_id: version.id, version_no: nextNo, version_status: 'draft' };
    });
  }

  private async editableAsset(userId: number, galleryId: number, assetId: number) {
    const source = await withTenantSupportMediaTransaction(userId, async (tx) => rows(await tx.execute(sql`
      SELECT a.* FROM support_media_galleries g
      JOIN LATERAL (
        SELECT id FROM support_media_gallery_versions WHERE gallery_id=g.id ORDER BY version_no DESC LIMIT 1
      ) v ON TRUE
      JOIN support_media_assets a ON a.gallery_version_id=v.id
      WHERE g.user_id=${userId} AND g.id=${galleryId} AND g.status='active'
        AND a.id=${assetId} AND a.user_id=${userId} AND a.retired_at IS NULL
      LIMIT 1
    `))[0]);
    if (!source) throw new Error('Media asset not found.');

    const version = await this.editableVersion(userId, galleryId);
    if (Number(source.gallery_version_id) === Number(version.version_id)) return { version, asset: source };

    const copied = await withTenantSupportMediaTransaction(userId, async (tx) => rows(await tx.execute(sql`
      SELECT * FROM support_media_assets
      WHERE user_id=${userId} AND gallery_id=${galleryId} AND gallery_version_id=${Number(version.version_id)}
        AND evidence_id=${`media:${galleryId}:${version.version_id}:${assetId}`} AND retired_at IS NULL
      LIMIT 1
    `))[0]);
    if (!copied) throw new Error('Editable media asset was not created.');
    return { version, asset: copied };
  }

  async update(userId: number, galleryId: number, input: UpdateGalleryInput) {
    validateGalleryScope(input);
    const title = input.title?.trim().slice(0, 180);
    if (!title) throw new Error('A gallery title is required.');
    const description = input.description?.trim().slice(0, 4000) || null;
    const entityTags = cleanList(input.entityTags);
    const metadataSafety = validateSupportMediaMetadata([title, description, ...entityTags].filter(Boolean).join('\n'));
    if (!metadataSafety.safe) throw new Error(`Gallery metadata failed privacy or integrity checks: ${metadataSafety.reasons.join(', ')}.`);

    const version = await this.editableVersion(userId, galleryId);
    const assets = await withTenantSupportMediaTransaction(userId, async (tx) => {
      const profileId = input.businessProfileId == null ? requireBusinessScope().businessProfileId : input.businessProfileId;
      if (profileId && !rows(await tx.execute(sql`SELECT id FROM company_settings WHERE id=${Number(profileId)} AND user_id=${userId}`))[0]) {
        throw new Error('The selected business profile is not available to this tenant.');
      }
      const snapshot = { ...(version.metadata_snapshot as Record<string, unknown> || {}), title, description,
        entity_tags: entityTags, helpful_auto_attach: input.helpfulAutoAttach === true,
        business_profile_id: profileId || null, audience: input.audience || version.audience,
        allowed_channels: input.allowedChannels === undefined ? version.allowed_channels : cleanList(input.allowedChannels),
        usage_scopes: input.usageScopes === undefined ? version.usage_scopes : cleanList(input.usageScopes) };
      await tx.execute(sql`
        UPDATE support_media_gallery_versions SET metadata_snapshot=${JSON.stringify(snapshot)}::jsonb
        WHERE id=${Number(version.version_id)} AND user_id=${userId}
      `);
      const activeAssets = rows(await tx.execute(sql`
        SELECT id,name,owner_description,owner_tags,publication_state FROM support_media_assets
        WHERE user_id=${userId} AND gallery_id=${galleryId} AND gallery_version_id=${Number(version.version_id)} AND retired_at IS NULL
      `));
      for (const asset of activeAssets) {
        const searchText = [title, description, String(asset.name), asset.owner_description,
          ...((asset.owner_tags as string[] | undefined) || [])].filter(Boolean).join('\n').slice(0, 10_000);
        await tx.execute(sql`UPDATE support_media_assets SET search_text=${searchText},updated_at=NOW()
          WHERE id=${Number(asset.id)} AND user_id=${userId}`);
        asset.search_text = searchText;
      }
      return activeAssets;
    });
    for (const asset of assets) {
      if (asset.publication_state === 'published') await indexMediaAsset(userId, Number(asset.id), String(asset.search_text));
    }
    await this.reconcileVersion(userId, galleryId, Number(version.version_id));
    return this.get(userId, galleryId);
  }

  async updateAsset(userId: number, galleryId: number, assetId: number, input: UpdateAssetInput) {
    const { version, asset } = await this.editableAsset(userId, galleryId, assetId);
    const name = input.name?.trim().slice(0, 180);
    if (!name) throw new Error('An image name is required.');
    const description = input.description?.trim().slice(0, 2000) || null;
    const altText = (input.altText?.trim() || description || name).slice(0, 500);
    const ownerTags = cleanList(input.tags);
    const sortOrder = Number.isSafeInteger(input.sortOrder) ? Math.max(0, Math.min(49, Number(input.sortOrder))) : Number(asset.sort_order);
    const metadataSafety = validateSupportMediaMetadata([name, description, altText, ...ownerTags].filter(Boolean).join('\n'));
    if (!metadataSafety.safe) throw new Error(`Image metadata failed privacy or integrity checks: ${metadataSafety.reasons.join(', ')}.`);
    const searchText = [version.title, version.description, name, description, ...ownerTags].filter(Boolean).join('\n').slice(0, 10_000);

    await withTenantSupportMediaTransaction(userId, async (tx) => {
      await tx.execute(sql`
        UPDATE support_media_assets SET name=${name},owner_description=${description},alt_text=${altText},
          sort_order=${sortOrder},owner_tags=${textArrayExpression(ownerTags)},search_text=${searchText},updated_at=NOW()
        WHERE id=${Number(asset.id)} AND user_id=${userId} AND gallery_id=${galleryId} AND retired_at IS NULL
      `);
      await tx.execute(sql`DELETE FROM support_media_asset_embeddings WHERE asset_id=${Number(asset.id)} AND user_id=${userId}`);
    });
    if (asset.publication_state === 'published') await indexMediaAsset(userId, Number(asset.id), searchText);
    await this.reconcileVersion(userId, galleryId, Number(version.version_id));
    return this.get(userId, galleryId);
  }

  async replaceAsset(userId: number, galleryId: number, assetId: number, file: Express.Multer.File, input: UpdateAssetInput) {
    if (!file) throw new Error('Choose an image to replace this asset.');
    const { version, asset } = await this.editableAsset(userId, galleryId, assetId);
    const name = input.name?.trim().slice(0, 180);
    if (!name) throw new Error('An image name is required.');
    const description = input.description?.trim().slice(0, 2000) || null;
    const altText = (input.altText?.trim() || description || name).slice(0, 500);
    const ownerTags = cleanList(input.tags);
    const sortOrder = Number.isSafeInteger(input.sortOrder) ? Math.max(0, Math.min(49, Number(input.sortOrder))) : Number(asset.sort_order);
    const metadataSafety = validateSupportMediaMetadata([name, description, altText, ...ownerTags].filter(Boolean).join('\n'));
    if (!metadataSafety.safe) throw new Error(`Image metadata failed privacy or integrity checks: ${metadataSafety.reasons.join(', ')}.`);

    if (!file.buffer && file.path) file.buffer = await readFile(file.path);
    const scan = await scanSupportMedia({ buffer: file.buffer, mimeType: file.mimetype, fileName: file.originalname });
    let original: Awaited<ReturnType<typeof storageService.upload>> | undefined;
    let derivative: Awaited<ReturnType<typeof storageService.upload>> | undefined;
    try {
      original = await storageService.upload(scan.normalized, {
        userId, category: 'support_media', originalName: file.originalname.replace(/\.[^.]+$/, '.jpg'), mimeType: scan.mimeType,
        referenceType: 'support_media_gallery_version', referenceId: String(version.version_id),
        metadata: { role: 'normalized_original', galleryId, versionId: version.version_id, replacesAssetId: assetId },
      });
      derivative = await storageService.upload(scan.derivative, {
        userId, category: 'support_media', originalName: `${name}-delivery.jpg`, mimeType: scan.mimeType,
        referenceType: 'support_media_gallery_version', referenceId: String(version.version_id),
        metadata: { role: 'delivery_derivative', galleryId, versionId: version.version_id, replacesAssetId: assetId },
      });
      const searchText = [version.title, version.description, name, description, ...ownerTags].filter(Boolean).join('\n').slice(0, 10_000);
      await withTenantSupportMediaTransaction(userId, async (tx) => {
        await tx.execute(sql`
          UPDATE support_media_assets SET storage_file_id=${original!.fileId},derivative_storage_file_id=${derivative!.fileId},
            name=${name},owner_description=${description},alt_text=${altText},sort_order=${sortOrder},width=${scan.width},height=${scan.height},
            mime_type=${scan.mimeType},size_bytes=${derivative!.fileSizeBytes},checksum=${scan.checksum},owner_tags=${textArrayExpression(ownerTags)},
            internal_tags=${textArrayExpression(scan.internalTags)},search_text=${searchText},publication_state=${scan.status},
            scan_results=${JSON.stringify(scan.scanResults)}::jsonb,updated_at=NOW()
          WHERE id=${Number(asset.id)} AND user_id=${userId} AND gallery_id=${galleryId} AND retired_at IS NULL
        `);
        await tx.execute(sql`DELETE FROM support_media_asset_embeddings WHERE asset_id=${Number(asset.id)} AND user_id=${userId}`);
      });
      if (scan.status === 'published') await indexMediaAsset(userId, Number(asset.id), searchText);
    } catch (error) {
      if (derivative?.fileId) await storageService.deleteFile(derivative.fileId, userId).catch(() => false);
      if (original?.fileId) await storageService.deleteFile(original.fileId, userId).catch(() => false);
      throw error;
    }
    await this.reconcileVersion(userId, galleryId, Number(version.version_id));
    return this.get(userId, galleryId);
  }

  async retireAsset(userId: number, galleryId: number, assetId: number) {
    const { version, asset } = await this.editableAsset(userId, galleryId, assetId);
    const count = await withTenantSupportMediaTransaction(userId, async (tx) => rows(await tx.execute(sql`
      SELECT COUNT(*)::INTEGER AS count FROM support_media_assets
      WHERE user_id=${userId} AND gallery_id=${galleryId} AND gallery_version_id=${Number(version.version_id)} AND retired_at IS NULL
    `))[0]);
    if (Number(count.count) <= 1) throw new Error('A gallery must retain at least one image. Delete the gallery instead.');
    await withTenantSupportMediaTransaction(userId, async (tx) => {
      await tx.execute(sql`UPDATE support_media_assets SET publication_state='retired',retired_at=NOW(),updated_at=NOW()
        WHERE id=${Number(asset.id)} AND user_id=${userId} AND gallery_id=${galleryId} AND retired_at IS NULL`);
      await tx.execute(sql`DELETE FROM support_media_asset_embeddings WHERE asset_id=${Number(asset.id)} AND user_id=${userId}`);
    });
    await this.reconcileVersion(userId, galleryId, Number(version.version_id));
    return this.get(userId, galleryId);
  }

  async addImages(userId: number, galleryId: number, files: Express.Multer.File[], metadata: Array<{
    name: string; description?: string; altText?: string; tags?: string[];
  }>) {
    if (!files.length || files.length > 50) throw new Error('Upload between 1 and 50 images.');
    if (metadata.length !== files.length) throw new Error('Every image requires matching metadata.');
    const version = await this.editableVersion(userId, galleryId);
    const added: Record<string, unknown>[] = [];
    const outcomes: Array<{ index: number; fileName: string; status: 'uploaded' | 'existing' | 'failed'; assetId?: number; error?: string }> = [];
    for (let index = 0; index < files.length; index++) {
      const file = { ...files[index], buffer: files[index].buffer || await readFile(files[index].path) };
      const item = metadata[index];
      let original: Awaited<ReturnType<typeof storageService.upload>> | undefined;
      let derivative: Awaited<ReturnType<typeof storageService.upload>> | undefined;
      let persisted = false;
      try {
      const name = item.name?.trim().slice(0, 180);
      if (!name) throw new Error(`Image ${index + 1} requires a name.`);
      const metadataSafety = validateSupportMediaMetadata([name, item.description, item.altText, ...(item.tags || [])].filter(Boolean).join('\n'));
      if (!metadataSafety.safe) throw new Error(`Image ${index + 1} metadata failed privacy or integrity checks: ${metadataSafety.reasons.join(', ')}.`);
      const fingerprint = mediaUploadFingerprint(file, item);
      let reused = false;
      const asset = await withTenantSupportMediaTransaction(userId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId},${galleryId})`);
      const existing = rows(await tx.execute(sql`SELECT * FROM support_media_assets WHERE user_id=${userId}
        AND gallery_version_id=${Number(version.version_id)} AND retired_at IS NULL AND scan_results->>'uploadFingerprint'=${fingerprint} LIMIT 1`))[0];
      if (existing) { reused = true; return existing; }
      const current = rows(await tx.execute(sql`SELECT COUNT(*)::integer AS count FROM support_media_assets
        WHERE user_id=${userId} AND gallery_version_id=${Number(version.version_id)} AND retired_at IS NULL`))[0];
      if (Number(current.count) >= 50) throw new Error('A gallery may contain at most 50 images.');
      const scan = await scanSupportMedia({ buffer: file.buffer, mimeType: file.mimetype, fileName: file.originalname });
      original = await storageService.upload(scan.normalized, {
        userId, category: 'support_media', originalName: file.originalname.replace(/\.[^.]+$/, '.jpg'), mimeType: scan.mimeType,
        referenceType: 'support_media_gallery_version', referenceId: String(version.version_id),
        metadata: { role: 'normalized_original', galleryId, versionId: version.version_id },
      });
      derivative = await storageService.upload(scan.derivative, {
        userId, category: 'support_media', originalName: `${name}-delivery.jpg`, mimeType: scan.mimeType,
        referenceType: 'support_media_gallery_version', referenceId: String(version.version_id),
        metadata: { role: 'delivery_derivative', galleryId, versionId: version.version_id },
      });
      const ownerTags = cleanList(item.tags);
      const searchText = [version.title, version.description, name, item.description, ...ownerTags].filter(Boolean).join('\n').slice(0, 10_000);
        const inserted = rows(await tx.execute(sql`
          INSERT INTO support_media_assets(
            user_id,gallery_id,gallery_version_id,storage_file_id,derivative_storage_file_id,evidence_id,
            name,owner_description,alt_text,sort_order,width,height,mime_type,size_bytes,checksum,
            owner_tags,internal_tags,search_text,publication_state,scan_results
          ) VALUES (
            ${userId},${galleryId},${Number(version.version_id)},${original.fileId},${derivative.fileId},
            ${`media:${galleryId}:${version.version_id}:${crypto.randomUUID()}`},${name},${item.description?.trim().slice(0, 2000) || null},
            ${(item.altText?.trim() || item.description?.trim() || name).slice(0, 500)},${Number(current.count)},
            ${scan.width},${scan.height},${scan.mimeType},${derivative.fileSizeBytes},${scan.checksum},
            ${textArrayExpression(ownerTags)},${textArrayExpression(scan.internalTags)},${searchText},${scan.status},${JSON.stringify({ ...scan.scanResults, uploadFingerprint: fingerprint })}::jsonb
          ) RETURNING *
        `));
        return inserted[0];
      });
      persisted = true;
      added.push(asset);
      outcomes.push({ index, fileName: file.originalname, status: reused ? 'existing' : 'uploaded', assetId: Number(asset.id) });
      if (asset.publication_state === 'published') await indexMediaAsset(userId, Number(asset.id), String(asset.search_text));
      } catch (error) {
        if (!persisted) {
          if (derivative?.fileId) await storageService.deleteFile(derivative.fileId, userId).catch(() => false);
          if (original?.fileId) await storageService.deleteFile(original.fileId, userId).catch(() => false);
        }
        outcomes.push({ index, fileName: file.originalname, status: 'failed', error: error instanceof Error ? error.message : 'Upload failed.' });
      }
    }
    await this.reconcileVersion(userId, galleryId, Number(version.version_id));
    return { versionId: Number(version.version_id), assets: added, outcomes };
  }

  async reviewAsset(userId: number, galleryId: number, assetId: number, decision: 'approve' | 'reject', reason: string) {
    if (!['approve', 'reject'].includes(decision) || !reason?.trim() || reason.length > 2000) {
      throw new Error('A review decision and a reason of up to 2000 characters are required.');
    }
    const versionId = await withTenantSupportMediaTransaction(userId, async (tx) => {
      const asset = rows(await tx.execute(sql`SELECT a.* FROM support_media_assets a JOIN support_media_galleries g ON g.id=a.gallery_id
        WHERE a.id=${assetId} AND a.user_id=${userId} AND g.user_id=${userId} AND g.id=${galleryId} AND g.status='active'
        AND a.gallery_version_id=(SELECT id FROM support_media_gallery_versions WHERE gallery_id=g.id ORDER BY version_no DESC LIMIT 1)
        AND a.retired_at IS NULL FOR UPDATE OF a`))[0];
      if (!asset) throw new Error('Media asset not found.');
      if (asset.publication_state !== 'ready_for_review') throw new Error('Only images waiting for review may receive an owner decision.');
      // Known unsafe content remains quarantined; manual approval only resolves unavailable scanners.
      const scan = asset.scan_results as Record<string, unknown>;
      if (decision === 'approve' && (scan.hasFace || scan.likelyChild || scan.unsafe || scan.hasSecrets || scan.hasInstructionInjection
        || scan.unsafeTags || (Array.isArray(scan.piiTypes) && scan.piiTypes.length))) throw new Error('This image requires replacement; known sensitive content cannot be approved.');
      await tx.execute(sql`INSERT INTO support_media_review_audits(user_id,asset_id,decision,reason)
        VALUES(${userId},${assetId},${decision},${reason.trim()})`);
      await tx.execute(sql`UPDATE support_media_assets SET publication_state=${decision === 'approve' ? 'published' : 'quarantined'},
        scan_results=scan_results || ${JSON.stringify({ ownerReview: { decision, reason: reason.trim(), userId:businessAuditActor(userId), reviewedAt: new Date().toISOString() } })}::jsonb, updated_at=NOW()
        WHERE id=${assetId} AND user_id=${userId}`);
      return Number(asset.gallery_version_id);
    });
    await this.reconcileVersion(userId, galleryId, versionId);
    if (decision === 'approve') {
      const asset = await withTenantSupportMediaTransaction(userId, async (tx) => rows(await tx.execute(sql`SELECT search_text FROM support_media_assets WHERE id=${assetId} AND user_id=${userId}`))[0]);
      if (asset) await indexMediaAsset(userId, assetId, String(asset.search_text));
    }
    return this.get(userId, galleryId);
  }

  async reconcileVersion(userId: number, galleryId: number, versionId: number) {
    return withTenantSupportMediaTransaction(userId, async (tx) => {
      const active = rows(await tx.execute(sql`SELECT id FROM support_media_galleries WHERE user_id=${userId} AND id=${galleryId}
        AND status='active' AND ${versionId}=(SELECT id FROM support_media_gallery_versions WHERE gallery_id=${galleryId} ORDER BY version_no DESC LIMIT 1)
        FOR UPDATE`))[0];
      if (!active) throw new Error('The gallery changed while processing. Reload the latest version before retrying.');
      const counts = rows(await tx.execute(sql`
        SELECT COUNT(*)::INTEGER AS total,
          COUNT(*) FILTER (WHERE publication_state='published')::INTEGER AS published,
          COUNT(*) FILTER (WHERE publication_state='quarantined')::INTEGER AS quarantined,
          COUNT(*) FILTER (WHERE publication_state='failed')::INTEGER AS failed,
          COUNT(*) FILTER (WHERE publication_state='ready_for_review')::INTEGER AS review
        FROM support_media_assets WHERE user_id=${userId} AND gallery_version_id=${versionId} AND retired_at IS NULL
      `))[0];
      const total = Number(counts.total);
      const status = Number(counts.quarantined) > 0 ? 'quarantined'
        : Number(counts.failed) > 0 ? 'failed'
          : Number(counts.review) > 0 ? 'ready_for_review'
            : total > 0 && Number(counts.published) === total ? 'published' : 'draft';
      await tx.execute(sql`
        UPDATE support_media_gallery_versions SET status=${status}, scan_results=${JSON.stringify(counts)}::jsonb,
          published_at=CASE WHEN ${status}='published' THEN NOW() ELSE published_at END,
          reviewed_at=CASE WHEN ${status}='published' THEN NOW() ELSE reviewed_at END,
          reviewed_by=CASE WHEN ${status}='published' THEN ${businessAuditActor(userId)} ELSE reviewed_by END
        WHERE id=${versionId} AND gallery_id=${galleryId} AND user_id=${userId}
      `);
      if (status === 'published') {
        await tx.execute(sql`UPDATE support_media_galleries g SET current_published_version_id=${versionId},updated_at=NOW(),
          title=COALESCE(v.metadata_snapshot->>'title',g.title),description=v.metadata_snapshot->>'description',
          business_profile_id=(v.metadata_snapshot->>'business_profile_id')::integer,
          audience=COALESCE(v.metadata_snapshot->>'audience',g.audience),
          allowed_channels=ARRAY(SELECT jsonb_array_elements_text(COALESCE(v.metadata_snapshot->'allowed_channels','[]'::jsonb))),
          usage_scopes=ARRAY(SELECT jsonb_array_elements_text(COALESCE(v.metadata_snapshot->'usage_scopes','["support_answer"]'::jsonb))),
          entity_tags=ARRAY(SELECT jsonb_array_elements_text(COALESCE(v.metadata_snapshot->'entity_tags','[]'::jsonb))),
          helpful_auto_attach=COALESCE((v.metadata_snapshot->>'helpful_auto_attach')::boolean,g.helpful_auto_attach)
          FROM support_media_gallery_versions v WHERE g.id=${galleryId} AND g.user_id=${userId} AND v.id=${versionId} AND v.user_id=g.user_id`);
      }
      return { status, ...counts };
    });
  }

  async retire(userId: number, galleryId: number) {
    return withTenantSupportMediaTransaction(userId, async (tx) => {
      await tx.execute(sql`UPDATE support_media_galleries SET status='retired',updated_at=NOW() WHERE id=${galleryId} AND user_id=${userId}`);
      await tx.execute(sql`UPDATE support_media_gallery_versions SET status='retired' WHERE gallery_id=${galleryId} AND user_id=${userId} AND status='published'`);
      await tx.execute(sql`UPDATE support_media_assets SET publication_state='retired',retired_at=NOW(),updated_at=NOW() WHERE gallery_id=${galleryId} AND user_id=${userId} AND retired_at IS NULL`);
      return { retired: true };
    });
  }

  async retryScans(userId: number, galleryId: number) {
    const gallery = await this.get(userId, galleryId);
    if (!gallery) throw new Error('Gallery not found.');
    const assets = (gallery.assets as Record<string, unknown>[]).filter((asset) =>
      ['ready_for_review', 'failed'].includes(String(asset.publication_state)));
    for (const asset of assets) {
      const record = await withTenantSupportMediaTransaction(userId, async (tx) => rows(await tx.execute(sql`
        SELECT storage_file_id,name,checksum,gallery_version_id FROM support_media_assets
        WHERE id=${Number(asset.id)} AND user_id=${userId} AND gallery_id=${galleryId}
          AND gallery_version_id=${Number(gallery.version_id)} AND retired_at IS NULL
          AND publication_state IN ('ready_for_review','failed')
      `))[0]);
      if (!record) continue;
      const stored = await storageService.downloadFile(Number(record.storage_file_id), userId);
      if (!stored) continue;
      try {
        const scan = await scanSupportMedia({ buffer: stored.buffer, mimeType: 'image/jpeg', fileName: String(record.name) });
        // Slow scans must never approve replacement bytes or undo an owner decision.
        const updated = await withTenantSupportMediaTransaction(userId, async (tx) => rows(await tx.execute(sql`
          UPDATE support_media_assets SET publication_state=${scan.status},scan_results=scan_results || ${JSON.stringify(scan.scanResults)}::jsonb,
            internal_tags=${textArrayExpression(scan.internalTags)},updated_at=NOW()
          WHERE id=${Number(asset.id)} AND user_id=${userId} AND gallery_id=${galleryId}
            AND gallery_version_id=${Number(record.gallery_version_id)} AND storage_file_id=${Number(record.storage_file_id)}
            AND checksum=${String(record.checksum)} AND retired_at IS NULL AND publication_state IN ('ready_for_review','failed')
          RETURNING id
        `)));
        if (updated.length && scan.status === 'published') {
          const refreshed = await withTenantSupportMediaTransaction(userId, async (tx) => rows(await tx.execute(sql`
            SELECT search_text FROM support_media_assets WHERE id=${Number(asset.id)} AND user_id=${userId}
          `))[0]);
          if (refreshed?.search_text) await indexMediaAsset(userId, Number(asset.id), String(refreshed.search_text));
        }
      } catch (error) {
        await withTenantSupportMediaTransaction(userId, async (tx) => {
          await tx.execute(sql`UPDATE support_media_assets SET publication_state='failed',scan_results=scan_results || ${JSON.stringify({ error: error instanceof Error ? error.message : 'Scan failed' })}::jsonb,updated_at=NOW()
            WHERE id=${Number(asset.id)} AND user_id=${userId} AND gallery_id=${galleryId}
              AND gallery_version_id=${Number(record.gallery_version_id)} AND storage_file_id=${Number(record.storage_file_id)}
              AND checksum=${String(record.checksum)} AND retired_at IS NULL AND publication_state IN ('ready_for_review','failed')`);
        });
      }
    }
    return this.reconcileVersion(userId, galleryId, Number((gallery as Record<string, unknown>).version_id));
  }
}

export const supportMediaGalleryService = new SupportMediaGalleryService();
