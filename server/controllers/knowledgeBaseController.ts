import { z } from 'zod';
import { businessOwnerUserId, isBusinessOwner } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
/**
 * Knowledge Base Controller
 * Handles CRUD operations for knowledge base entries including file uploads
 */

import type { Request, Response } from "express";
import { parseIdParam } from '../utils/paramParsers.js';
import { KnowledgeBaseModel } from "../models/knowledgeBase/functions";
import multer from "multer";
import path from "path";
import { logger } from '../utils/logger.js';
import { deductCreditsForKnowledgeBase } from '../services/CreditDeductionHooks.js';
import { StorageService } from '../services/StorageService.js';
import { queueRegistry, QUEUE_NAMES } from '../queues/index.js';
import { processKnowledgeBaseEntryIngestion } from '../services/KnowledgeBaseProcessingService.js';
import { db } from '../models/db.js';
import { storageFilesTable } from '../models/storageFiles/schema.js';
import { companySettings } from '../models/companySettings/schema.js';
import { and, desc, eq } from 'drizzle-orm';
import { knowledgeBaseService } from '../services/KnowledgeBaseService.js';
import { knowledgeGovernanceService } from '../services/knowledge/KnowledgeGovernanceService.js';
import { knowledgeReadinessService } from '../services/knowledge/KnowledgeReadinessService.js';

const knowledgeEditSchema = z.object({
  title:z.string().trim().min(1).max(255).optional(),description:z.string().max(500).nullable().optional(),
  content:z.string().max(10_000_000).optional(),type:z.enum(['document','qa','file','url']).optional(),
  question:z.string().trim().min(1).max(100_000).optional(),answer:z.string().trim().min(1).max(1_000_000).optional(),
  expectedUpdatedAt:z.string().datetime({offset:true}).optional(),
}).passthrough();
const qaItemSchema = z.object({ question:z.string().trim().min(1).max(100_000),
  answer:z.string().trim().min(1).max(1_000_000),title:z.string().trim().min(1).max(255).optional(),
  description:z.string().max(500).nullable().optional(),businessProfileId:z.unknown().optional(),
});

function parseOptionalBusinessProfileId(value: unknown): number | null {
  if (value === undefined || value === null || value === '' || value === 'none') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error('INVALID_BUSINESS_PROFILE');
  return id;
}

async function businessProfileBelongsToUser(profileId: number | null, userId: number): Promise<boolean> {
  if (profileId === null) return true;
  const [profile] = await db
    .select({ id: companySettings.id })
    .from(companySettings)
    .where(and(eq(companySettings.id, profileId), eq(companySettings.userId, userId)))
    .limit(1);
  return Boolean(profile);
}

function isInvalidBusinessProfile(error: unknown) {
  return error instanceof Error && error.message === 'INVALID_BUSINESS_PROFILE';
}

// Configure multer with memory storage (files go to S3/MinIO via StorageService)
const fileFilter = (
  _req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowedTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type. Only text-based PDF, DOCX, TXT, CSV, XLS, and XLSX files are supported."));
  }
};

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
}).single("file");

export async function getKnowledgeBaseEntries(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const rawProfileId = req.query.businessProfileId;
    const businessProfileId = rawProfileId === undefined
      ? undefined
      : parseOptionalBusinessProfileId(rawProfileId);
    if (businessProfileId !== undefined && !(await businessProfileBelongsToUser(businessProfileId, userId))) {
      return res.status(404).json({ success: false, error: 'Business profile not found' });
    }
    const entries = await KnowledgeBaseModel.findAll(userId, businessProfileId);
    const states = await knowledgeGovernanceService.getEntryStates(userId, entries.map((entry) => entry.id));
    const readiness = isBusinessOwner(req)
      ? await knowledgeReadinessService.entries(userId, entries.map(entry => entry.id)) : new Map();
    res.json({
      success: true,
      data: entries.map((entry) => {
        const state = states.get(entry.id);
        return {
          ...entry,
          knowledgeStatus: state?.status || 'legacy_only',
          knowledgeVersionId: state?.version_id || null,
          knowledgeVersionNo: state?.version_no || null,
          currentPublishedVersionId: state?.current_published_version_id || null,
          vectorIndexStatus: state?.vector_index_status || null,
          lexicalIndexStatus: state?.lexical_index_status || null,
          knowledgeAuthority: state?.authority || null,
          liveVersionNo: state?.live_version_no || null,
          liveStatus: state?.live_status || null,
          audience: state?.audience || null,
          accessScope: state?.access_scope || null,
          allowedChannels: state?.allowed_channels || [],
          usageScopes: state?.usage_scopes || [],
          locale: state?.locale || null,
          draftScope: state?.draft_scope || null,
          readiness: readiness.get(entry.id) || null,
        };
      }),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (isInvalidBusinessProfile(error)) {
      return res.status(400).json({ success: false, error: 'Invalid business profile' });
    }
    logger.error({ err: error }, '[KnowledgeBaseController] Error getting entries');
    res.status(500).json({ success: false, error: "Unable to retrieve your knowledge base entries. Please try again." });
  }
}

export async function getKnowledgeBaseEntry(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const entryId = parseIdParam(req.params.id);
    if (!entryId) return res.status(400).json({ success: false, error: "Invalid ID" });

    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const entry = await KnowledgeBaseModel.findById(entryId, userId);
    if (!entry) {
      return res.status(404).json({ success: false, error: "Entry not found" });
    }

    res.json({ success: true, entry });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[KnowledgeBaseController] Error getting entry');
    res.status(500).json({ success: false, error: "Unable to retrieve the knowledge base entry. Please try again." });
  }
}

export async function getKnowledgeBaseExtractedText(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const entryId = parseIdParam(req.params.id);
    if (!entryId) return res.status(400).json({ success: false, error: "Invalid ID" });

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    // This authoring preview can include blocked/raw source text. Staff library
    // access uses SupportMemberKnowledgeService and its published access rules.
    if (!isBusinessOwner(req)) {
      return res.status(403).json({ success: false, error: 'Only the business owner can inspect source text.' });
    }

    const entry = await KnowledgeBaseModel.findById(entryId, userId);
    if (!entry) {
      return res.status(404).json({ success: false, error: 'Entry not found' });
    }

    const current = await knowledgeReadinessService.extractedText(userId, entryId);
    if (current) return res.json({ success: true, entryId: entry.id, fileName: entry.fileName,
      type: entry.type, processingStatus: entry.processingStatus, ...current });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any = null;
    if (typeof entry.content === 'string') {
      try {
        parsed = JSON.parse(entry.content);
      } catch {
        parsed = null;
      }
    } else if (entry.content && typeof entry.content === 'object') {
      parsed = entry.content;
    }

    const extractedText = parsed?.extractedText || '';
    const chunks = Array.isArray(parsed?.chunks)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? parsed.chunks.map((chunk: any, index: number) => ({
          index: typeof chunk.index === 'number' ? chunk.index : index,
          text: String(chunk.text || ''),
          charStart: typeof chunk.charStart === 'number' ? chunk.charStart : 0,
          charEnd: typeof chunk.charEnd === 'number' ? chunk.charEnd : String(chunk.text || '').length,
          tokenEstimate: typeof chunk.tokenEstimate === 'number' ? chunk.tokenEstimate : Math.ceil(String(chunk.text || '').length / 4),
          hasEmbedding: null,
        }))
      : [];

    return res.json({
      success: true,
      entryId: entry.id,
      fileName: entry.fileName,
      type: entry.type,
      processingStatus: entry.processingStatus,
      extractedText,
      chunks,
      embeddingsGenerated: false,
      embeddingModel: null,
      extractionSource: 'legacy_preview',
      extractionWarnings: [...(parsed?.extractionWarnings || []), 'Legacy preview: current index readiness is unavailable. Reprocess this source and review the new version.'],
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[KnowledgeBaseController] Error getting extracted text');
    return res.status(500).json({ success: false, error: 'Unable to retrieve extracted text.' });
  }
}

export async function createKnowledgeBaseEntry(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const { title, description, content, type, businessProfileId } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, error: "Title is required" });
    }

    if (type !== undefined && type !== 'document') {
      return res.status(400).json({ success: false, error: 'Use the dedicated Q&A, file, or URL endpoint for this entry type' });
    }
    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ success: false, error: "Content is required for document type" });
    }

    const profileId = parseOptionalBusinessProfileId(businessProfileId);
    if (!(await businessProfileBelongsToUser(profileId, userId))) {
      return res.status(404).json({ success: false, error: 'Business profile not found' });
    }

    let entry = await KnowledgeBaseModel.create({
      userId,
      title,
      description: description || null,
      content: content || null,
      type: type || "document",
      processingStatus: 'processing',
      businessProfileId: profileId,
    });

    if (entry.type === 'document' && entry.content) {
      await knowledgeBaseService.indexEntry(userId, entry.id, entry.content);
      const completed = await KnowledgeBaseModel.update(entry.id, userId, { processingStatus: 'completed' });
      if (!completed) throw new Error('Knowledge-base entry disappeared before indexing completed.');
      entry = completed;
    }

    // Deduct platform credits for knowledge base upload
    await deductCreditsForKnowledgeBase(userId, { entryId: entry.id });

    res.status(201).json({ success: true, entry });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    if (isInvalidBusinessProfile(error)) {
      return res.status(400).json({ success: false, error: 'Invalid business profile' });
    }
    logger.error({ err: error }, '[KnowledgeBaseController] Error creating entry');
    res.status(500).json({ success: false, error: "Unable to create the knowledge base entry. Please try again." });
  }
}

export async function updateKnowledgeBaseEntry(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const entryId = parseIdParam(req.params.id);
    if (!entryId) return res.status(400).json({ success: false, error: "Invalid ID" });

    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const validation = knowledgeEditSchema.safeParse(req.body);
    if (!validation.success) return res.status(400).json({success:false,error:'Invalid knowledge edit',issues:validation.error.flatten()});
    const { title, description, content, type, question, answer, businessProfileId, expectedUpdatedAt } = validation.data;

    const existing = await KnowledgeBaseModel.findById(entryId, userId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Entry not found' });
    }
    const profileId = businessProfileId === undefined
      ? undefined
      : parseOptionalBusinessProfileId(businessProfileId);
    if (profileId !== undefined && !(await businessProfileBelongsToUser(profileId, userId))) {
      return res.status(404).json({ success: false, error: 'Business profile not found' });
    }

    const expected = expectedUpdatedAt ? new Date(expectedUpdatedAt) : existing.updatedAt || new Date(0);
    const nextType = type || existing.type;
    if (['file','url'].includes(existing.type) && (nextType !== existing.type || (content !== undefined && content !== existing.content))) {
      return res.status(400).json({success:false,error:'Use reprocessing to replace file or URL content'});
    }
    const nextQuestion = question ?? existing.question;
    const nextAnswer = answer ?? existing.answer;
    if (!['document', 'qa'].includes(nextType) && type !== undefined && type !== existing.type) {
      return res.status(400).json({ success: false, error: 'File and URL entry types cannot be changed through this endpoint' });
    }
    if (nextType === 'qa' && (!String(nextQuestion || '').trim() || !String(nextAnswer || '').trim())) {
      return res.status(400).json({ success: false, error: 'Question and answer are required for Q&A entries' });
    }
    const nextContent = nextType === 'qa'
      ? `Q: ${nextQuestion || ''}\nA: ${nextAnswer || ''}`
      : content ?? existing.content;
    if (nextType === 'document' && (typeof nextContent !== 'string' || !nextContent.trim())) {
      return res.status(400).json({success:false,error:'Indexed knowledge-base content cannot be empty'});
    }
    const effectiveProfileId = profileId === undefined ? existing.businessProfileId : profileId;
    const requiresIndex = ['document', 'qa'].includes(nextType) && (
      nextContent !== existing.content
      || nextType !== existing.type
      || effectiveProfileId !== existing.businessProfileId
      || (title !== undefined && title !== existing.title)
    );
    const changes = {
      title,
      description,
      content: nextContent,
      type,
      question,
      answer,
      businessProfileId: profileId,
      ...(requiresIndex ? {
        processingStatus: nextType !== existing.type || effectiveProfileId !== existing.businessProfileId
          ? 'processing'
          : 'reprocessing',
      } : {}),
    };

    if (['file','url'].includes(nextType) && ((title !== undefined && title !== existing.title)
      || effectiveProfileId !== existing.businessProfileId)) {
      const result = await knowledgeGovernanceService.updateSourceMetadata(existing,changes,expected);
      return res.json({success:true,...result,message:'Metadata saved as a draft. Review before publication.'});
    }
    const entry = await KnowledgeBaseModel.updateIfUnchanged(entryId,userId,changes,expected);

    if (!entry) {
      return res.status(409).json({success:false,code:'KNOWLEDGE_SOURCE_CHANGED',error:'This source changed. Reload before saving your edits.'});
    }

    let responseEntry = entry;
    if (requiresIndex && (entry.type === 'document' || entry.type === 'qa')) {
      const indexText = entry.type === 'qa'
        ? `Q: ${entry.question || ''}\nA: ${entry.answer || ''}`
        : entry.content || '';
      await knowledgeBaseService.indexEntry(userId, entry.id, indexText);
      const completed = await KnowledgeBaseModel.updateIfUnchanged(entry.id, userId, { processingStatus: 'completed' },entry.updatedAt || new Date(0));
      if (!completed) throw new Error('KNOWLEDGE_SOURCE_CHANGED');
      responseEntry = completed;
    }

    res.json({ success: true, entry: responseEntry });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    if (isInvalidBusinessProfile(error)) {
      return res.status(400).json({ success: false, error: 'Invalid business profile' });
    }
    if (error instanceof Error && ['KNOWLEDGE_SOURCE_CHANGED','KNOWLEDGE_SOURCE_NOT_INDEXED','KNOWLEDGE_SCHEDULE_REVIEW_REQUIRED'].includes(error.message)) {
      return res.status(409).json({success:false,code:error.message,error:'The source needs review or changed since it was loaded. Reload before saving.'});
    }
    if (error instanceof Error && error.message === 'KNOWLEDGE_METADATA_PRIVACY_REVIEW_REQUIRED') {
      return res.status(400).json({success:false,code:error.message,error:'Remove private information or instructions from the title and source URL before saving.'});
    }
    logger.error({ err: error }, '[KnowledgeBaseController] Error updating entry');
    res.status(500).json({ success: false, error: "Unable to update the knowledge base entry. Please try again." });
  }
}

export async function reprocessKnowledgeBaseFile(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const entryId = parseIdParam(req.params.id);
    if (!entryId) return res.status(400).json({ success: false, error: "Invalid ID" });

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const entry = await KnowledgeBaseModel.findById(entryId, userId);
    if (!entry) {
      return res.status(404).json({ success: false, error: 'Entry not found' });
    }

    if (entry.type === 'document' || entry.type === 'qa') {
      const { knowledgeIngestionService } = await import('../services/knowledge/KnowledgeIngestionService.js');
      const result = await knowledgeIngestionService.indexLegacyEntry(entry, { autoPublish: false });
      await KnowledgeBaseModel.update(entry.id, userId, { processingStatus: 'completed', extractionStatus: 'completed',
        indexingStatus: result.vectorIndexed ? 'completed' : 'failed' });
      return res.json({ success: true, entryId: entry.id, processingStatus: 'completed', result, message: 'Knowledge reindexed. Review the version before publication.' });
    }

    if (entry.type === 'url') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsedContent: any = null;
      try {
        parsedContent = entry.content ? JSON.parse(entry.content) : null;
      } catch {
        parsedContent = null;
      }
      const previousUrls = Array.isArray(parsedContent?.pagesScraped)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? parsedContent.pagesScraped.map((page: any) => page?.url).filter((url: unknown): url is string => typeof url === 'string')
        : [];
      const selectedUrls = Array.from(new Set([entry.sourceUrl, ...previousUrls].filter((url): url is string => Boolean(url)))).slice(0, 25);
      if (!entry.sourceUrl || selectedUrls.length === 0) {
        return res.status(400).json({ success: false, error: 'This URL entry has no source URL to reprocess' });
      }

      await KnowledgeBaseModel.update(entry.id, userId, { processingStatus: 'reprocessing' });
      await queueRegistry.addJob(QUEUE_NAMES.KNOWLEDGE_BASE, 'kb-url-crawl', {
        userId,
        entryId: entry.id,
        sourceUrl: entry.sourceUrl,
        selectedUrls,
        jobType: 'url-crawl',
        createdAt: new Date().toISOString(),
      });
      return res.json({
        success: true,
        entryId: entry.id,
        processingStatus: 'queued',
        message: 'Website reprocessing queued',
      });
    }

    if (entry.type !== 'file') {
      return res.status(400).json({ success: false, error: 'Reprocess is only supported for file and URL entries' });
    }

    const [storageFile] = await db
      .select({ id: storageFilesTable.id })
      .from(storageFilesTable)
      .where(
        and(
          eq(storageFilesTable.userId, userId),
          eq(storageFilesTable.referenceType, 'knowledge_base'),
          eq(storageFilesTable.referenceId, String(entry.id)),
          eq(storageFilesTable.isDeleted, false),
        )
      )
      .orderBy(desc(storageFilesTable.createdAt))
      .limit(1);

    if (!storageFile) {
      return res.status(404).json({ success: false, error: 'No uploaded file found for this entry' });
    }

    await KnowledgeBaseModel.update(entry.id, userId, {
      processingStatus: 'reprocessing',
    });

    await queueRegistry.addJob(
      QUEUE_NAMES.KNOWLEDGE_BASE,
      'process-knowledge-base-file',
      {
        userId,
        entryId: entry.id,
        storageFileId: storageFile.id,
        createdAt: new Date().toISOString(),
      }
    );

    return res.json({
      success: true,
      entryId: entry.id,
      processingStatus: 'queued',
      message: 'File reprocessing queued',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[KnowledgeBaseController] Error reprocessing file');
    return res.status(500).json({ success: false, error: 'Unable to reprocess file.' });
  }
}

export async function deleteKnowledgeBaseEntry(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const entryId = parseIdParam(req.params.id);
    if (!entryId) return res.status(400).json({ success: false, error: "Invalid ID" });

    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const existing = await KnowledgeBaseModel.findById(entryId, userId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Entry not found' });
    }
    const storageFiles = await db
      .select({ id: storageFilesTable.id })
      .from(storageFilesTable)
      .where(and(
        eq(storageFilesTable.userId, userId),
        eq(storageFilesTable.referenceType, 'knowledge_base'),
        eq(storageFilesTable.referenceId, String(entryId)),
        eq(storageFilesTable.isDeleted, false),
      ));

    const deleted = await knowledgeGovernanceService.deleteEntry(userId, entryId);
    if (!deleted) {
      return res.status(404).json({ success: false, error: "Entry not found" });
    }

    if (storageFiles.length > 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await StorageService.getInstance().deleteFiles(storageFiles.map((file: any) => file.id), userId);
      } catch (storageError) {
        logger.warn({ err: storageError, userId, entryId }, '[KnowledgeBaseController] Entry deleted but file cleanup needs retry');
      }
    }

    res.json({ success: true, message: "Entry deleted" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[KnowledgeBaseController] Error deleting entry');
    res.status(500).json({ success: false, error: "Unable to delete the knowledge base entry. Please try again." });
  }
}

/**
 * Upload a file to the knowledge base
 * Supports text-based PDF, DOCX, TXT, CSV, XLS, and XLSX files.
 */
export async function uploadKnowledgeBaseFile(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    const file = req.file;
    const fileExtension = path.extname(file.originalname).toLowerCase().replace('.', '');
    
    // Map file extension to type
    const typeMap: Record<string, string> = {
      pdf: "pdf",
      docx: "document",
      txt: "text",
      csv: "csv",
      xls: "spreadsheet",
      xlsx: "spreadsheet",
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const fileType = typeMap[fileExtension] || 'document';

    // Create knowledge base entry with file info
    const profileId = parseOptionalBusinessProfileId(req.body.businessProfileId);
    if (!(await businessProfileBelongsToUser(profileId, userId))) {
      return res.status(404).json({ success: false, error: 'Business profile not found' });
    }

    const entry = await KnowledgeBaseModel.create({
      userId,
      title: req.body.title || file.originalname,
      description: req.body.description || null,
      content: null,
      type: 'file',
      processingStatus: 'queued',
      fileName: file.originalname,
      fileType: file.mimetype,
      fileSize: file.size,
      businessProfileId: profileId,
    });

    // Upload file through StorageService (handles quota, tracking, backend)
    const storageService = StorageService.getInstance();
    const uploadResult = await storageService.upload(file.buffer, {
      userId,
      category: 'knowledge_base',
      originalName: file.originalname,
      mimeType: file.mimetype,
      referenceType: 'knowledge_base',
      referenceId: String(entry.id),
    }).catch(async error => {
      // No file or ingestion job exists yet. Release the logical knowledge slot
      // when storage rejects or fails this upload, so retrying cannot leak quota.
      await KnowledgeBaseModel.delete(entry.id, userId);
      throw error;
    });

    try {
      await queueRegistry.addJob(
        QUEUE_NAMES.KNOWLEDGE_BASE,
        'process-knowledge-base-file',
        {
          userId,
          entryId: entry.id,
          storageFileId: uploadResult.fileId,
          createdAt: new Date().toISOString(),
        }
      );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (queueError: any) {
      await KnowledgeBaseModel.update(entry.id, userId, { processingStatus: 'failed' });
      throw queueError;
    }

    setTimeout(async () => {
      try {
        const latest = await KnowledgeBaseModel.findById(entry.id, userId);
        if (!latest || latest.processingStatus !== 'queued') return;
        await processKnowledgeBaseEntryIngestion({
          userId,
          entryId: entry.id,
          storageFileId: uploadResult.fileId,
        });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (fallbackError: any) {
        logger.error({ err: fallbackError, entryId: entry.id }, '[KnowledgeBaseController] Queue fallback processing failed');
      }
    }, 15000).unref?.();

    // Deduct platform credits for knowledge base upload
    await deductCreditsForKnowledgeBase(userId, { entryId: entry.id });

    res.status(201).json({
      success: true,
      entry,
      file: {
        originalName: file.originalname,
        fileName: uploadResult.fileName,
        url: uploadResult.url,
        size: file.size,
        type: fileExtension,
      },
      processingStatus: 'queued',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    if (isInvalidBusinessProfile(error)) {
      return res.status(400).json({ success: false, error: 'Invalid business profile' });
    }
    logger.error({ err: error }, '[KnowledgeBaseController] Error uploading file');
    res.status(500).json({ success: false, error: "Unable to upload the file. Please check the file format and try again." });
  }
}

/**
 * Create a Q&A entry in the knowledge base
 */
export async function createQAEntry(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    // Support creating a single Q&A or multiple Q&A entries in batch
    // Body can be { question, answer, title?, description? } or { qas: [{ question, answer, title?, description? }, ...] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { qas, businessProfileId: bodyBusinessProfileId } = req.body as any;

    if (qas !== undefined && !Array.isArray(qas)) return res.status(400).json({success:false,error:'Q&A batch must be an array'});
    if (Array.isArray(qas)) {
      const parsed = z.array(qaItemSchema).min(1).max(100).safeParse(qas);
      if (!parsed.success) return res.status(400).json({success:false,error:'Every Q&A item needs a valid question and answer',issues:parsed.error.flatten()});
      const requestId = req.headers?.['idempotency-key'] || req.body.requestId;
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) {
        return res.status(400).json({success:false,code:'KNOWLEDGE_BATCH_REQUEST_ID_REQUIRED',error:'Supply a stable requestId or Idempotency-Key when creating a Q&A batch.'});
      }
      const candidates = parsed.data.map(item => ({userId,title:item.title || item.question.slice(0,100),
        description:item.description || null,content:`Q: ${item.question}\nA: ${item.answer}`,type:'qa',
        processingStatus:'queued',question:item.question,answer:item.answer,
        businessProfileId:parseOptionalBusinessProfileId(item.businessProfileId ?? bodyBusinessProfileId),
      }));
      for (const profile of new Set(candidates.map(item => item.businessProfileId))) {
        if (!(await businessProfileBelongsToUser(profile,userId))) return res.status(404).json({success:false,error:'Business profile not found'});
      }
      const entries = await KnowledgeBaseModel.createBatch(userId,requestId,candidates);
      const results: Array<{entryId:number;status:string}> = [];
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.processingStatus === 'completed') { results.push({entryId:entry.id,status:'completed'}); continue; }
        const claimed = await KnowledgeBaseModel.claimBatchItem(entry.id,userId);
        if (!claimed) { results.push({entryId:entry.id,status:'processing'}); continue; }
        try {
          await knowledgeBaseService.indexEntry(userId,entry.id,claimed.content || '');
          const completed = await KnowledgeBaseModel.updateIfUnchanged(entry.id,userId,{processingStatus:'completed'},claimed.updatedAt || new Date(0));
          if (!completed) throw new Error('KNOWLEDGE_ENTRY_NOT_FOUND');
          entries[index] = completed;
          const { deductCreditsForKnowledgeBaseItem } = await import('../services/CreditDeductionHooks.js');
          try { await deductCreditsForKnowledgeBaseItem(userId,{entryId:entry.id}); }
          catch (creditError) { logger.warn({err:creditError,entryId:entry.id,userId},'[KnowledgeBase] Non-blocking batch credit hook failed'); }
          results.push({entryId:entry.id,status:'completed'});
        } catch (error) {
          logger.warn({err:error,entryId:entry.id,userId},'[KnowledgeBase] Batch item needs indexing retry');
          await KnowledgeBaseModel.updateIfUnchanged(entry.id,userId,{processingStatus:'failed'},claimed.updatedAt || new Date(0));
          results.push({entryId:entry.id,status:'failed'});
        }
      }
      const complete = results.every(result => result.status === 'completed');
      return res.status(complete ? 201 : 207).json({success:complete,requestId,entries,results,
        ...(!complete ? {code:'KNOWLEDGE_BATCH_PARTIAL',error:'The sources were saved. Some items still need indexing. Retry the unchanged batch to resume using the same entry IDs.'} : {}),
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { title, description, question, answer } = req.body as any;

    if (!question || !answer) {
      return res.status(400).json({ success: false, error: "Question and answer are required" });
    }

    const singleValidation = qaItemSchema.safeParse({title,description,question,answer});
    if (!singleValidation.success) return res.status(400).json({success:false,error:'Invalid Q&A entry'});
    const profileId = parseOptionalBusinessProfileId(bodyBusinessProfileId);
    if (!(await businessProfileBelongsToUser(profileId, userId))) {
      return res.status(404).json({ success: false, error: 'Business profile not found' });
    }
    const entry = await KnowledgeBaseModel.create({
      userId,
      title: title || question.substring(0, 100),
      description: description || null,
      content: `Q: ${question}\nA: ${answer}`,
      type: "qa",
      processingStatus: 'processing',
      question,
      answer,
      businessProfileId: profileId,
    });
    await knowledgeBaseService.indexEntry(userId, entry.id, entry.content || '');
    const completed = await KnowledgeBaseModel.update(entry.id, userId, { processingStatus: 'completed' });
    if (!completed) throw new Error('Q&A entry disappeared before indexing completed.');

    // Deduct platform credits for KB Q&A item
    try {
      const { deductCreditsForKnowledgeBaseItem } = await import('../services/CreditDeductionHooks.js');
      await deductCreditsForKnowledgeBaseItem(userId, { entryId: entry.id });
    } catch (_creditErr) { /* non-blocking */ }

    res.status(201).json({ success: true, entry: completed });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    if (isInvalidBusinessProfile(error)) {
      return res.status(400).json({ success: false, error: 'Invalid business profile' });
    }
    if (error instanceof Error && error.message === 'KNOWLEDGE_BATCH_REQUEST_CHANGED') {
      return res.status(409).json({success:false,code:error.message,error:'This request ID already belongs to different Q&A content. Retry its original content or start a new batch.'});
    }
    logger.error({ err: error }, '[KnowledgeBaseController] Error creating Q&A entry');
    res.status(500).json({ success: false, error: "Unable to create the Q&A entry. Please try again." });
  }
}

/**
 * Crawl a URL and auto-discover sub-pages (same as setup analyze-website flow).
 * Uses WebsiteCrawlerService.crawl() for automatic subpage discovery and crawling.
 */
export async function crawlUrlForKnowledgeBase(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: "URL is required" });
    }

    // Basic URL validation
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return res.status(400).json({ success: false, error: "Only HTTP and HTTPS URLs are supported" });
      }
    } catch {
      return res.status(400).json({ success: false, error: "Invalid URL format" });
    }

    const { WebsiteCrawlerService } = await import('../services/WebsiteCrawlerService.js');
    // Use full crawler (same as setup analyze flow) to auto-discover and crawl subpages
    const crawler = new WebsiteCrawlerService({ maxPages: 12, maxContentLength: 50000, timeoutMs: 20000 });

    // Auto-crawl: fetch homepage + auto-discover and crawl subpages (same as setup analyze flow)
    const crawlResult = await crawler.crawl(url);
    const successfulPages = crawlResult.pages.filter(p => p.success);
    if (successfulPages.length === 0) {
      return res.status(400).json({ success: false, error: "Failed to fetch URL" });
    }

    const mainResult = crawlResult.pages[0];

    // Build links list from crawled pages
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const homepageUrl = parsedUrl.origin + (parsedUrl.pathname.replace(/\/$/, '') || '');
    const links: { url: string; title: string; category: string; priority: number; anchorText: string }[] = 
      successfulPages.map((p, i) => ({
        url: p.url,
        title: p.title || (i === 0 ? parsedUrl.hostname : p.url),
        category: p.category || (i === 0 ? 'homepage' : 'other'),
        priority: i === 0 ? 0 : 1,
        anchorText: p.title || p.url,
      }));

    // Auto-select all successfully crawled pages
    const aiSelectedUrls = successfulPages.map(p => p.url);

    return res.json({
      success: true,
      mainPage: {
        url: mainResult.url,
        title: mainResult.title,
      },
      links,
      aiSelectedUrls,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[KnowledgeBaseController] Error crawling URL');
    return res.status(500).json({ success: false, error: "Failed to crawl the URL. Please check the URL and try again." });
  }
}

/**
 * Create a URL entry in the knowledge base by crawling selected pages.
 */
export async function createUrlEntry(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const { title, description, sourceUrl, selectedUrls, businessProfileId } = req.body;
    if (!title || !sourceUrl) {
      return res.status(400).json({ success: false, error: "Title and source URL are required" });
    }
    if (!Array.isArray(selectedUrls) || selectedUrls.length === 0) {
      return res.status(400).json({ success: false, error: "At least one URL must be selected" });
    }
    if (selectedUrls.length > 25) {
      return res.status(400).json({ success: false, error: 'A maximum of 25 URLs can be processed at once' });
    }

    // Validate URLs
    for (const u of selectedUrls) {
      try {
        const parsed = new URL(u);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return res.status(400).json({ success: false, error: `Invalid URL protocol: ${u}` });
        }
      } catch {
        return res.status(400).json({ success: false, error: `Invalid URL: ${u}` });
      }
    }

    // Create entry in processing state
    const profileId = parseOptionalBusinessProfileId(businessProfileId);
    if (!(await businessProfileBelongsToUser(profileId, userId))) {
      return res.status(404).json({ success: false, error: 'Business profile not found' });
    }

    const entry = await KnowledgeBaseModel.create({
      userId,
      title,
      description: description || null,
      content: null,
      type: 'url',
      processingStatus: 'processing',
      sourceUrl,
      businessProfileId: profileId,
    });

    // Enqueue URL crawling to BullMQ worker
    await queueRegistry.addJob(QUEUE_NAMES.KNOWLEDGE_BASE, 'kb-url-crawl', {
      userId,
      entryId: entry.id,
      sourceUrl,
      selectedUrls,
      jobType: 'url-crawl',
      createdAt: new Date().toISOString(),
    });

    // Deduct credits
    await deductCreditsForKnowledgeBase(userId, { entryId: entry.id });

    return res.status(201).json({
      success: true,
      entry,
      message: `Crawling ${selectedUrls.length} page(s)... The content will be available shortly.`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    if (isInvalidBusinessProfile(error)) {
      return res.status(400).json({ success: false, error: 'Invalid business profile' });
    }
    logger.error({ err: error }, '[KnowledgeBaseController] Error creating URL entry');
    return res.status(500).json({ success: false, error: "Failed to create URL entry. Please try again." });
  }
}
