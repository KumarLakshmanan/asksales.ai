import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response, NextFunction } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { getChatThreadById } from '../models/chatThreads/functions.js';
import { conversationRequests, ConversationRequestError } from '../services/ConversationRequestCoordinator.js';

export function conversationTurnHandler(surface: 'campaign' | 'support_owner' | 'support_member', action: 'list' | 'stop' | 'reconcile') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid conversation ID' });
      let ownerId = surface === 'support_member' ? 0 : businessOwnerUserId(req);
      if (surface === 'campaign') {
        const thread = await getChatThreadById(id);
        if (!ownerId || thread?.userId !== ownerId) return res.status(404).json({ error: 'Conversation not found' });
      } else {
        const memberId = (req as Request & { supportMember?: { id: number } }).supportMember?.id;
        if (surface === 'support_member' ? !memberId : !ownerId) return res.status(401).json({ error: 'Unauthorized' });
        const session = await db.execute(sql`SELECT m.user_id FROM support_chat_sessions s JOIN team_members m ON m.id=s.member_id
          WHERE s.id=${id} AND (${surface === 'support_member'} AND m.id=${memberId || 0} OR ${surface === 'support_owner'} AND m.user_id=${ownerId || 0})`);
        if (!session.rows.length) return res.status(404).json({ error: 'Conversation not found' });
        ownerId = Number(session.rows[0].user_id);
      }
      const kind = surface === 'campaign' ? 'campaign' : 'support_advisory';
      const data = action === 'list' ? await conversationRequests.list(ownerId!, kind, id)
        : action === 'stop' ? await conversationRequests.cancel(ownerId!, kind, id, req.body.requestId)
          : await conversationRequests.reconcile(ownerId!, kind, id, req.body.requestId, String(req.body.note || ''));
      return res.json({ success: true, data });
    } catch (error) {
      if (error instanceof ConversationRequestError) return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
      next(error);
    }
  };
}
