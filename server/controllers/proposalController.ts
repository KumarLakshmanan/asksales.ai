import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { businessCacheKey } from '../tenancy/businessContext.js';
import { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { proposalService, ProposalWorkflowError } from '../services/ProposalService.js';
import { reminderService } from '../services/ReminderService.js';
import { idempotencyService } from '../services/IdempotencyService.js';
import crypto from 'crypto';
import { ProposalDocumentError } from '../services/ProposalDocumentService.js';
import { getBrandInfo } from '../utils/emailTemplates.js';
import { parsePositiveId } from '../utils/paramParsers.js';
import { respondToGenerationFailure } from '../services/content/ContentTextGenerationError.js';

function handleProposalError(res: Response, error: unknown, fallback: string) {
  if (error instanceof ProposalWorkflowError || error instanceof ProposalDocumentError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  if (respondToGenerationFailure(res, error, 'a proposal', logger, 'ProposalController')) return;
  logger.error({ err: error }, fallback);
  return res.status(500).json({ error: fallback });
}

function parsePublicToken(value: unknown): string | null {
  const token = String(value || '');
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

// ─── Proposals ───────────────────────────────────────────────────────────────

export const getProposals = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const allowedStatuses = new Set(['draft', 'sending', 'delivery_unknown', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'superseded']);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !allowedStatuses.has(status)) return res.status(400).json({ error: 'Invalid proposal status' });
    const contactId = req.query.contactId === undefined ? undefined : parsePositiveId(req.query.contactId);
    const page = req.query.page === undefined ? undefined : parsePositiveId(req.query.page);
    const limit = req.query.limit === undefined ? undefined : parsePositiveId(req.query.limit);
    const chatThreadId = req.query.chatThreadId === undefined
      ? undefined
      : parsePositiveId(req.query.chatThreadId);
    if (req.query.contactId !== undefined && !contactId) return res.status(400).json({ error: 'Invalid contact ID' });
    if (req.query.page !== undefined && !page) return res.status(400).json({ error: 'Invalid page' });
    if (req.query.limit !== undefined && (!limit || limit > 100)) return res.status(400).json({ error: 'Invalid limit' });
    if (req.query.chatThreadId !== undefined && !chatThreadId) return res.status(400).json({ error: 'Invalid chat thread ID' });
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 255) : undefined;
    const attention = typeof req.query.attention === 'string' ? req.query.attention : undefined;
    if (attention && !['needs_approval', 'awaiting_response', 'expiring_soon', 'needs_review', 'customer_response', 'overdue'].includes(attention)) return res.status(400).json({ error: 'Invalid attention filter' });
    const sort = typeof req.query.sort === 'string' ? req.query.sort : undefined;
    if (sort && !['updated', 'created', 'value', 'expiry'].includes(sort)) return res.status(400).json({ error: 'Invalid proposal sort' });

    const result = await proposalService.getProposals(userId, {
      status,
      contactId: contactId || undefined,
      search: search || undefined,
      page: page || undefined,
      limit: limit || undefined,
      chatThreadId: chatThreadId || undefined,
      attention: attention as 'needs_approval' | 'awaiting_response' | 'expiring_soon' | 'needs_review' | 'customer_response' | 'overdue' | undefined,
      sort: sort as 'updated' | 'created' | 'value' | 'expiry' | undefined,
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get proposals');
    return res.status(500).json({ error: 'Failed to fetch proposals' });
  }
};

export const getProposal = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposalId = parsePositiveId(req.params.id);
    if (!proposalId) return res.status(400).json({ error: 'Invalid proposal ID' });

    const proposal = await proposalService.getProposalById(userId, proposalId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    return res.json({ success: true, data: proposal });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get proposal');
    return res.status(500).json({ error: 'Failed to fetch proposal' });
  }
};

export const createProposal = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposal = await proposalService.createProposal(userId, req.body);
    return res.status(201).json({ success: true, data: proposal });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to create proposal');
  }
};

export const generateProposal = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposal = await proposalService.generateProposalFromKBAndProfile(userId, req.body);
    return res.status(201).json({ success: true, data: proposal });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to generate proposal');
  }
};

export const suggestProposalDraft = async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    return res.json({ success: true, data: await proposalService.suggestProposalDraft(userId, req.body) });
  } catch (error) { return handleProposalError(res, error, 'Unable to suggest proposal changes'); }
};

export const proposalBrand = async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    // ?proposalId previews the brand saved on that proposal; without it, the
    // brand a new proposal would get (the current default).
    const proposalId = req.query.proposalId === undefined ? null : parsePositiveId(req.query.proposalId);
    const proposal = proposalId ? await proposalService.getProposalById(userId, proposalId) : null;
    if (proposalId && !proposal) return res.status(404).json({ error: 'Proposal not found' });
    const brand = await getBrandInfo(userId, proposal?.brandToolkitId);
    return res.json({ success: true, data: { companyName: brand.companyName, logoUrl: brand.logoUrl, primaryColor: brand.primaryColor } });
  } catch (error) { return handleProposalError(res, error, 'Unable to load proposal branding'); }
};

export const updateProposal = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposalId = parsePositiveId(req.params.id);
    if (!proposalId) return res.status(400).json({ error: 'Invalid proposal ID' });

    const proposal = await proposalService.updateProposal(userId, proposalId, req.body);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    return res.json({ success: true, data: proposal });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to update proposal');
  }
};

export const deleteProposal = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposalId = parsePositiveId(req.params.id);
    if (!proposalId) return res.status(400).json({ error: 'Invalid proposal ID' });

    const deleted = await proposalService.deleteProposal(userId, proposalId);
    if (!deleted) return res.status(404).json({ error: 'Proposal not found' });
    return res.json({ success: true });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to delete proposal');
  }
};

// ─── Line Items ──────────────────────────────────────────────────────────────

export const updateLineItems = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposalId = parsePositiveId(req.params.id);
    if (!proposalId) return res.status(400).json({ error: 'Invalid proposal ID' });

    // Verify ownership
    const proposal = await proposalService.getProposalById(userId, proposalId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    const result = await proposalService.updateLineItems(userId, proposalId, req.body.lineItems || []);
    if (!result) return res.status(404).json({ error: 'Proposal not found' });
    return res.json({ success: true, data: result });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to update line items');
  }
};

// ─── Comments ────────────────────────────────────────────────────────────────

export const getComments = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposalId = parsePositiveId(req.params.id);
    if (!proposalId) return res.status(400).json({ error: 'Invalid proposal ID' });

    // Verify ownership
    const proposal = await proposalService.getProposalById(userId, proposalId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    const comments = await proposalService.getComments(proposalId);
    return res.json({ success: true, data: comments });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get comments');
    return res.status(500).json({ error: 'Failed to fetch comments' });
  }
};

export const addComment = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposalId = parsePositiveId(req.params.id);
    if (!proposalId) return res.status(400).json({ error: 'Invalid proposal ID' });

    const comment = await proposalService.addComment(userId, proposalId, req.body);
    return res.status(201).json({ success: true, data: comment });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to add comment');
  }
};

// ─── Templates ───────────────────────────────────────────────────────────────

export const getTemplates = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const templates = await proposalService.getTemplates(userId);
    return res.json({ success: true, data: templates });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get templates');
    return res.status(500).json({ error: 'Failed to fetch templates' });
  }
};

export const createTemplate = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const template = await proposalService.createTemplate(userId, req.body);
    return res.status(201).json({ success: true, data: template });
  } catch (error) {
    logger.error({ err: error }, 'Failed to create template');
    return res.status(500).json({ error: 'Failed to create template' });
  }
};

export const importTemplateDocument = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: 'DOCX file is required' });

    const allowedMimeTypes = new Set([
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/octet-stream',
      'application/zip',
    ]);
    const hasZipSignature = file.buffer.length >= 4
      && file.buffer[0] === 0x50
      && file.buffer[1] === 0x4b
      && [0x03, 0x05, 0x07].includes(file.buffer[2]);
    const isDocx = file.originalname.toLowerCase().endsWith('.docx')
      && allowedMimeTypes.has(file.mimetype)
      && hasZipSignature;

    if (!isDocx) {
      return res.status(400).json({ error: 'Only DOCX files are supported for proposal templates' });
    }

    const template = await proposalService.importTemplateFromDocx(userId, {
      fileName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      description: typeof req.body?.description === 'string' ? req.body.description : undefined,
      includeKnowledgeBase: req.body?.includeKnowledgeBase !== 'false',
      includeBusinessProfile: req.body?.includeBusinessProfile !== 'false',
    });

    return res.status(201).json({ success: true, data: template });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to import proposal template document');
  }
};

export const deleteTemplate = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const templateId = parsePositiveId(req.params.id);
    if (!templateId) return res.status(400).json({ error: 'Invalid template ID' });

    const deleted = await proposalService.deleteTemplate(userId, templateId);
    if (!deleted) return res.status(404).json({ error: 'Template not found' });
    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete template');
    return res.status(500).json({ error: 'Failed to delete template' });
  }
};

export const updateTemplate = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const templateId = parsePositiveId(req.params.id);
    if (!templateId) return res.status(400).json({ error: 'Invalid template ID' });

    const template = await proposalService.updateTemplate(userId, templateId, req.body);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    return res.json({ success: true, data: template });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update template');
    return res.status(500).json({ error: 'Failed to update template' });
  }
};

// ─── Status Actions ──────────────────────────────────────────────────────────

export const sendProposal = async (req: Request, res: Response) => {
  let claimedIdempotencyKey: string | null = null;
  let sideEffectStarted = false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposalId = parsePositiveId(req.params.id);
    if (!proposalId) return res.status(400).json({ error: 'Invalid proposal ID' });

    const bodyIdempotencyKey = req.body?.idempotencyKey;
    const requestedKey = req.get('idempotency-key') || bodyIdempotencyKey;
    if (requestedKey && requestedKey.length > 200) {
      return res.status(400).json({ error: 'Idempotency key must be 200 characters or fewer' });
    }

    const recipientName = req.body.recipientName || '';
    const recipientEmail = req.body.recipientEmail || '';

    const requestFingerprint = crypto.createHash('sha256')
      .update(JSON.stringify({ userId, proposalId, recipientName, recipientEmail }))
      .digest('hex');
    const keyFingerprint = requestedKey
      ? crypto.createHash('sha256').update(`${userId}:${requestedKey}`).digest('hex')
      : requestFingerprint;

    claimedIdempotencyKey = businessCacheKey(`proposal-send:${userId}:${keyFingerprint}`);
    const claim = await idempotencyService.checkAndStore(claimedIdempotencyKey, {
      ttlSeconds: requestedKey ? 24 * 60 * 60 : 2 * 60,
    });

    if (claim.status === 'duplicate') {
      if (claim.previousResponse) {
        try {
          const previous = JSON.parse(claim.previousResponse);
          return res.status(previous.statusCode || 200).json(previous.body || previous);
        } catch {
          logger.warn({ idempotencyKey: claimedIdempotencyKey }, '[ProposalController] Ignoring malformed cached send response');
        }
      }
      return res.status(202).json({
        success: true,
        pending: true,
        message: 'This proposal is already being sent.',
      });
    }

    sideEffectStarted = true;
    const result = await proposalService.sendProposal(userId, proposalId, {
      name: recipientName,
      email: recipientEmail,
    });

    if (!result) {
      if (claimedIdempotencyKey) await idempotencyService.forget(claimedIdempotencyKey);
      return res.status(404).json({ error: 'Proposal not found' });
    }

    const responseBody = { success: true, data: result };
    await idempotencyService.storeResponse(claimedIdempotencyKey, JSON.stringify({
      statusCode: 200,
      body: responseBody,
    }));

    return res.json(responseBody);
  } catch (error) {
    if (claimedIdempotencyKey) {
      try {
        // Workflow errors are definitive (validation, invalid state, or an
        // explicit provider failure that was rolled back), so a corrected
        // retry may claim the key again. Unknown exceptions after the send
        // begins remain cached to avoid a possible duplicate delivery.
        if (error instanceof ProposalWorkflowError) {
          await idempotencyService.forget(claimedIdempotencyKey);
        } else if (sideEffectStarted) {
          await idempotencyService.storeResponse(claimedIdempotencyKey, JSON.stringify({
            statusCode: 500,
            body: { error: 'The send result could not be confirmed. Check proposal history before retrying.' },
          }));
        } else {
          await idempotencyService.forget(claimedIdempotencyKey);
        }
      } catch (idempotencyError) {
        logger.warn({ err: idempotencyError }, '[ProposalController] Unable to finalize send idempotency state');
      }
    }
    return handleProposalError(res, error, 'Failed to send proposal');
  }
};

export const getPublicProposal = async (req: Request, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    const token = parsePublicToken(req.params.token);
    if (!token) return res.status(400).json({ error: 'Invalid proposal link' });
    const proposal = await proposalService.getPublicProposal(token);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    return res.json({ success: true, data: proposal });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to open proposal');
  }
};

export const markPublicProposalViewed = async (req: Request, res: Response) => {
  try {
    const token = parsePublicToken(req.params.token);
    if (!token) return res.status(400).json({ error: 'Invalid proposal link' });
    const result = await proposalService.markPublicProposalViewed(token);
    if (!result) return res.status(404).json({ error: 'Proposal not found' });
    return res.json({ success: true, data: result });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to update proposal view');
  }
};

export const acceptPublicProposal = async (req: Request, res: Response) => {
  try {
    const token = parsePublicToken(req.params.token);
    if (!token) return res.status(400).json({ error: 'Invalid proposal link' });
    const result = await proposalService.respondToPublicProposal(token, 'accept', req.body);
    if (!result) return res.status(404).json({ error: 'Proposal not found' });
    return res.json({ success: true, data: result });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to accept proposal');
  }
};

export const rejectPublicProposal = async (req: Request, res: Response) => {
  try {
    const token = parsePublicToken(req.params.token);
    if (!token) return res.status(400).json({ error: 'Invalid proposal link' });
    const result = await proposalService.respondToPublicProposal(token, 'reject', req.body);
    if (!result) return res.status(404).json({ error: 'Proposal not found' });
    return res.json({ success: true, data: result });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to decline proposal');
  }
};

export const acceptProposal = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposalId = parsePositiveId(req.params.id);
    if (!proposalId) return res.status(400).json({ error: 'Invalid proposal ID' });

    const proposal = await proposalService.acceptProposal(userId, proposalId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    return res.json({ success: true, data: proposal });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to accept proposal');
  }
};

export const rejectProposal = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposalId = parsePositiveId(req.params.id);
    if (!proposalId) return res.status(400).json({ error: 'Invalid proposal ID' });

    const proposal = await proposalService.rejectProposal(userId, proposalId, req.body.reason);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    return res.json({ success: true, data: proposal });
  } catch (error) {
    return handleProposalError(res, error, 'Failed to reject proposal');
  }
};

// ─── Comments Update ─────────────────────────────────────────────────────────

export const updateComment = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const commentId = parsePositiveId(req.params.commentId);
    if (!commentId) return res.status(400).json({ error: 'Invalid comment ID' });

    const comment = await proposalService.updateComment(userId, commentId, req.body);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    return res.json({ success: true, data: comment });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update comment');
    return res.status(500).json({ error: 'Failed to update comment' });
  }
};

// ─── Reminder Update ─────────────────────────────────────────────────────────

export const updateProposalReminder = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const reminderId = parsePositiveId(req.params.reminderId);
    if (!reminderId) return res.status(400).json({ error: 'Invalid reminder ID' });

    const reminder = await reminderService.updateProposalReminder(userId, reminderId, req.body);
    if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
    return res.json({ success: true, data: reminder });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update proposal reminder');
    return res.status(500).json({ error: 'Failed to update reminder' });
  }
};

export const deleteProposalReminder = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const reminderId = parsePositiveId(req.params.reminderId);
    if (!reminderId) return res.status(400).json({ error: 'Invalid reminder ID' });
    const deleted = await reminderService.deleteProposalReminder(userId, reminderId);
    if (!deleted) return res.status(404).json({ error: 'Reminder not found' });
    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete proposal reminder');
    return res.status(500).json({ error: 'Failed to delete reminder' });
  }
};

// ─── Reminders ───────────────────────────────────────────────────────────────

export const getProposalReminders = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposalId = parsePositiveId(req.params.id);
    if (!proposalId) return res.status(400).json({ error: 'Invalid proposal ID' });

    const reminders = await reminderService.getProposalReminders(userId, proposalId);
    return res.json({ success: true, data: reminders });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get proposal reminders');
    return res.status(500).json({ error: 'Failed to fetch reminders' });
  }
};

export const createProposalReminder = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const proposalId = parsePositiveId(req.params.id);
    if (!proposalId) return res.status(400).json({ error: 'Invalid proposal ID' });

    const proposal = await proposalService.getProposalById(userId, proposalId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    if (['accepted','rejected','expired'].includes(proposal.status) || (proposal.validUntil && proposal.validUntil.getTime() < Date.now())) return res.status(409).json({ error: 'Completed or expired proposals cannot have new reminders' });
    const reminder = await reminderService.createProposalReminder(userId, proposalId, req.body);
    return res.status(201).json({ success: true, data: reminder });
  } catch (error) {
    logger.error({ err: error }, 'Failed to create proposal reminder');
    return res.status(500).json({ error: 'Failed to create reminder' });
  }
};

// ─── Analytics ───────────────────────────────────────────────────────────────

export const getProposalAnalytics = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const analytics = await proposalService.getAnalytics(userId);
    return res.json({ success: true, data: analytics });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get proposal analytics');
    return res.status(500).json({ error: 'Failed to fetch analytics' });
  }
};
