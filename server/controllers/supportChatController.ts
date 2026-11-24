import { randomUUID } from 'node:crypto';
import { ConversationRequestError } from '../services/ConversationRequestCoordinator.js';
import { Request, Response } from 'express';
import * as SupportChatService from '../services/SupportChatService.js';
import { logger } from '../utils/logger.js';

function getMemberId(req: Request): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req as any).supportMember?.id ?? null;
}

/**
 * POST /api/support-portal/chat/sessions
 * Body: { ticketId?, title? }
 */
export async function createSession(req: Request, res: Response) {
  const memberId = getMemberId(req);
  if (!memberId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { ticketId, title } = req.body;
    const session = await SupportChatService.createSession(memberId, ticketId, title, req.body.clientSessionKey);
    return res.json({ success: true, data: session });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error instanceof ConversationRequestError) return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    logger.error({ err: error }, '[SupportChat] createSession failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

/**
 * GET /api/support-portal/chat/sessions
 * Query: page, limit, ticketId
 */
export async function listSessions(req: Request, res: Response) {
  const memberId = getMemberId(req);
  if (!memberId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const ticketId = req.query.ticketId ? parseInt(req.query.ticketId as string) : undefined;

    const result = await SupportChatService.listSessions(memberId, ticketId, page, limit,
      typeof req.query.search === 'string' ? req.query.search : '', req.query.archived === 'true');
    return res.json({ success: true, data: result.sessions, total: result.total, page, limit,
      hasMore: page * limit < result.total });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[SupportChat] listSessions failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

export async function archiveSession(req: Request, res: Response) {
  const memberId = getMemberId(req);
  if (!memberId) return res.status(401).json({ error: 'Unauthorized' });
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0 || typeof req.body.archived !== 'boolean') {
    return res.status(400).json({ error: 'A session ID and archived boolean are required' });
  }
  const session = await SupportChatService.archiveSession(id, memberId, req.body.archived);
  return session ? res.json({ success: true, data: session }) : res.status(404).json({ error: 'Session not found' });
}

/**
 * GET /api/support-portal/chat/sessions/:id
 */
export async function getSession(req: Request, res: Response) {
  const memberId = getMemberId(req);
  if (!memberId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const session = await SupportChatService.getSession(sessionId, memberId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    return res.json({ success: true, data: session });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[SupportChat] getSession failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

/**
 * DELETE /api/support-portal/chat/sessions/:id
 */
export async function deleteSession(req: Request, res: Response) {
  const memberId = getMemberId(req);
  if (!memberId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const deleted = await SupportChatService.deleteSession(sessionId, memberId);
    if (!deleted) return res.status(404).json({ error: 'Session not found' });

    return res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[SupportChat] deleteSession failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

/**
 * PUT /api/support-portal/chat/sessions/:id
 * Body: { title }
 */
export async function renameSession(req: Request, res: Response) {
  const memberId = getMemberId(req);
  if (!memberId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const { title } = req.body;
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'Title is required' });

    const session = await SupportChatService.renameSession(sessionId, memberId, title.trim());
    if (!session) return res.status(404).json({ error: 'Session not found' });

    return res.json({ success: true, data: session });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[SupportChat] renameSession failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

/**
 * POST /api/support-portal/chat/sessions/:id/messages
 * Body: { message, ticketContext? }
 */
export async function sendMessage(req: Request, res: Response) {
  const memberId = getMemberId(req);
  if (!memberId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const { message, ticketContext } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const result = await SupportChatService.sendMessage(sessionId, memberId, message.trim(), ticketContext, req.body.requestId || randomUUID());
    return res.json({
      success: true,
      data: {
        userMessage: result.userMsg,
        assistantMessage: result.assistantMsg,
        response: result.response,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error instanceof ConversationRequestError) return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    logger.error({ err: error }, '[SupportChat] sendMessage failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}
