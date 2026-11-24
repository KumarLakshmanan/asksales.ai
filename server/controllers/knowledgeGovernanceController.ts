import { businessOwnerUserId, isBusinessOwner } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import type { Request, Response } from 'express';
import { knowledgeGovernanceService } from '../services/knowledge/KnowledgeGovernanceService.js';
import { logger } from '../utils/logger.js';
import { parseIdParam } from '../utils/paramParsers.js';
import { knowledgeGateway } from '../services/knowledge/KnowledgeGateway.js';
import { KNOWLEDGE_CHANNELS } from '../services/knowledge/KnowledgePublicationMetadata.js';
import { KNOWLEDGE_PURPOSES } from '../services/knowledge/KnowledgeRetrievalPolicy.js';
import type { KnowledgePurpose } from '../services/knowledge/types.js';
import { db } from '../models/db.js';
import { sql } from 'drizzle-orm';
import { knowledgeReadinessService } from '../services/knowledge/KnowledgeReadinessService.js';

function actor(req: Request): number {
  return Number((req as Request & { user?: { id?: number } }).user?.id || 0);
}

function governanceError(res: Response, error: unknown) {
  const capacityError = normalizeCapacityError(error);
  if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
  const code = error instanceof Error ? error.message : 'KNOWLEDGE_GOVERNANCE_FAILED';
  const notFound = code === 'KNOWLEDGE_VERSION_NOT_FOUND';
  return res.status(notFound ? 404 : 400).json({ success: false, error: code });
}

export async function listKnowledgeVersions(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  const entryId = parseIdParam(req.params.id);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!entryId) return res.status(400).json({ success: false, error: 'Invalid entry ID' });
  if (!isBusinessOwner(req)) return res.status(403).json({ success: false, error: 'Only the business owner can review source versions.' });
  try {
    const versions = await knowledgeGovernanceService.listVersions(userId, entryId);
    const readiness = await knowledgeReadinessService.versions(userId, entryId);
    return res.json({ success: true, versions: versions.map((version: Record<string, unknown>) => ({ ...version, readiness: readiness.get(Number(version.id)) || null })) });
  } catch (error) {
    logger.error({ err: error, userId, entryId }, '[KnowledgeGovernance] Version listing failed');
    return governanceError(res, error);
  }
}

export async function publishKnowledgeVersion(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  const entryId = parseIdParam(req.params.id);
  const versionId = parseIdParam(req.params.versionId);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!entryId || !versionId) return res.status(400).json({ success: false, error: 'Invalid entry or version ID' });
  try {
    const result = await knowledgeGovernanceService.publish({
      userId, actorUserId: actor(req), legacyEntryId: entryId, versionId,
      authority: String(req.body.authority || 'owner_authored'),
      effectiveAt: req.body.effectiveAt, expiresAt: req.body.expiresAt,
      reviewDueAt: req.body.reviewDueAt, supersedesVersionId: req.body.supersedesVersionId,
      allowLexicalOnly: req.body.allowLexicalOnly === true,
    });
    return res.json({ success: true, result });
  } catch (error) {
    logger.warn({ err: error, userId, entryId, versionId }, '[KnowledgeGovernance] Publication rejected');
    return governanceError(res, error);
  }
}

export async function quarantineKnowledgeVersion(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  const entryId = parseIdParam(req.params.id);
  const versionId = parseIdParam(req.params.versionId);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!entryId || !versionId) return res.status(400).json({ success: false, error: 'Invalid entry or version ID' });
  try {
    const result = await knowledgeGovernanceService.quarantine({
      userId, actorUserId: actor(req), legacyEntryId: entryId, versionId,
      reason: String(req.body.reason || ''),
    });
    return res.json({ success: true, result });
  } catch (error) {
    logger.warn({ err: error, userId, entryId, versionId }, '[KnowledgeGovernance] Quarantine failed');
    return governanceError(res, error);
  }
}

export async function updateKnowledgeDraftScope(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  const entryId = parseIdParam(req.params.id);
  const versionId = parseIdParam(req.params.versionId);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!entryId || !versionId) return res.status(400).json({ success: false, error: 'Invalid entry or version ID' });
  try {
    const result = await knowledgeGovernanceService.updateDraftScope({ userId, legacyEntryId: entryId, versionId, metadata: req.body.metadata });
    return res.json({ success: true, result });
  } catch (error) { return governanceError(res, error); }
}

export async function createKnowledgeVersionDraft(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  const entryId = parseIdParam(req.params.id);
  const versionId = parseIdParam(req.params.versionId);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!entryId || !versionId) return res.status(400).json({ success: false, error: 'Invalid entry or version ID' });
  try {
    const result = await knowledgeGovernanceService.createDraft({ userId, legacyEntryId: entryId, versionId });
    return res.json({ success: true, result });
  } catch (error) { return governanceError(res, error); }
}

export async function withdrawKnowledgeEntry(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  const entryId = parseIdParam(req.params.id);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!entryId) return res.status(400).json({ success: false, error: 'Invalid entry ID' });
  try {
    const result = await knowledgeGovernanceService.withdraw({ userId, actorUserId: actor(req), legacyEntryId: entryId, reason: String(req.body.reason || '') });
    return res.json({ success: true, result });
  } catch (error) { return governanceError(res, error); }
}

export async function testKnowledgeRetrieval(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const { question, audience = 'customer', channel = 'web', purpose = 'support_answer', locale = null, businessProfileId = null } = req.body;
  if (typeof question !== 'string' || !question.trim() || question.length > 4000
    || !['customer', 'internal'].includes(audience) || !KNOWLEDGE_CHANNELS.includes(channel)
    || !KNOWLEDGE_PURPOSES.includes(purpose as KnowledgePurpose)
    || (locale !== null && (typeof locale !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)))
    || (businessProfileId !== null && (!Number.isSafeInteger(businessProfileId) || businessProfileId <= 0))) {
    return res.status(400).json({ success: false, error: 'Invalid retrieval test settings' });
  }
  try {
    if (businessProfileId) {
      const owned = await db.execute(sql`SELECT id FROM company_settings WHERE user_id = ${userId} AND id = ${businessProfileId}`);
      if (!owned.rows.length) return res.status(404).json({ success: false, error: 'Business profile not found' });
    }
    const query = { tenantId: userId, redactedText: question.trim(), audience, channel,
      purpose, businessProfileId, risk: 'low' as const, entities: locale ? { locale } : undefined };
    const result = await knowledgeGateway.retrieve(query);
    const ownerReadiness = isBusinessOwner(req) ? await knowledgeReadinessService.retrievalDiagnostics(query) : undefined;
    return res.json({ success: true, result: { ...result, ...(ownerReadiness ? { ownerReadiness } : {}) } });
  } catch (error) { return governanceError(res, error); }
}
