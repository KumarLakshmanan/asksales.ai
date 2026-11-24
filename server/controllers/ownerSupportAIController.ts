import { businessOwnerUserId, currentBusinessScope } from '../tenancy/businessContext.js';
import { randomUUID } from 'node:crypto';
import { supportConversationContext } from '../services/agents/orchestration/SupportConversationMemory.js';
import { conversationRequests, validConversationRequestId, ConversationRequestError } from '../services/ConversationRequestCoordinator.js';
import { Request, Response } from 'express';
import { db } from '../models/db.js';
import { supportChatSessionsTable } from '../models/supportChatSessions/schema.js';
import type { SupportChatSession } from '../models/supportChatSessions/schema.js';
import { supportChatMessagesTable } from '../models/supportChatMessages/schema.js';
import { teamMembersTable } from '../models/teamMembers/schema.js';
import { supportTeamsTable } from '../models/supportTeams/schema.js';
import { leadsTable } from '../models/leads/schema.js';
import { eq, desc, sql, inArray, and } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { formatMessageForChannel } from '../utils/messageFormatter.js';
import { agentRouter } from '../services/agents/AgentRouter.js';
import { requireSupportChatAssistant } from '../services/SupportChatRouting.js';
import { redactPiiWithStableTokens } from '../services/agents/orchestration/PrivacyVaultService.js';
import { presentPublishedQuote } from '../services/knowledge/KnowledgeQuoteFormatting.js';
import { prepareSupportChatAttachments, retainSupportChatAttachments } from '../services/SupportChatAttachments.js';
import { parseSupportReportQuery, parseSupportQualityQuery, parseStaffFeedback, SupportReportValidationError, supportAIReport, supportAIQuality, saveSupportStaffFeedback, supportSessionDetail } from '../services/supportReporting/SupportAIReportingService.js';
/**
 * GET /api/support/ai/sessions
 * Lists all support AI chat sessions for the owner (across all their team members).
 */
export async function listOwnerSupportSessions(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (req.query.source !== undefined && !['all', 'widget', 'internal'].includes(req.query.source as string)) {
      return res.status(400).json({ error: 'Invalid source' });
    }
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 30));
    const offset = (page - 1) * limit;

    // Find all team members belonging to this owner's teams
    const teams = await db.select({ id: supportTeamsTable.id })
      .from(supportTeamsTable)
      .where(and(eq(supportTeamsTable.userId, userId), ...(currentBusinessScope() ? [eq(supportTeamsTable.businessProfileId, currentBusinessScope()!.businessProfileId)] : [])));
    const teamIds = teams.map((t: { id: number }) => t.id);

    if (teamIds.length === 0) {
      return res.json({ success: true, data: [], total: 0, page, limit });
    }

    const members = await db.select({ id: teamMembersTable.id, name: teamMembersTable.name })
      .from(teamMembersTable)
      .where(inArray(teamMembersTable.teamId, teamIds));
    const memberIds = members.map((m: { id: number; name: string }) => m.id);
    const memberMap = new Map(members.map((m: { id: number; name: string }) => [m.id, m.name]));

    if (memberIds.length === 0) {
      return res.json({ success: true, data: [], total: 0, page, limit });
    }

    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 200) : '';
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const filters = and(inArray(supportChatSessionsTable.memberId, memberIds),
      ...(currentBusinessScope() ? [eq(supportChatSessionsTable.businessProfileId, currentBusinessScope()!.businessProfileId)] : []),
      sql`COALESCE(${supportChatSessionsTable.metadata}->>'archived', 'false') = ${req.query.archived === 'true' ? 'true' : 'false'}`,
      ...(req.query.source === 'widget' ? [sql`${supportChatSessionsTable.metadata}->>'source' = 'widget'`] : []),
      ...(req.query.source === 'internal' ? [sql`COALESCE(${supportChatSessionsTable.metadata}->>'source', '') <> 'widget'`] : []),
      ...(search ? [sql`(COALESCE(${supportChatSessionsTable.title},'') ILIKE ${pattern} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM support_chat_messages sm WHERE sm.session_id=${supportChatSessionsTable.id}
          ${currentBusinessScope() ? sql`AND sm.business_profile_id=${currentBusinessScope()!.businessProfileId}` : sql``}
          AND sm.content ILIKE ${pattern} ESCAPE '\\'))`] : []));
    const sessions = await db.select().from(supportChatSessionsTable)
      .where(filters)
      .orderBy(desc(supportChatSessionsTable.updatedAt), desc(supportChatSessionsTable.id))
      .limit(limit)
      .offset(offset);

    const countResult = await db.select({ count: sql<number>`count(*)::int` })
      .from(supportChatSessionsTable)
      .where(filters);

    const sessionsWithMemberName = sessions.map((s: SupportChatSession) => ({
      ...s,
      memberName: memberMap.get(s.memberId) || 'Unknown',
    }));

    return res.json({ success: true, data: sessionsWithMemberName, total: countResult[0]?.count ?? 0, page, limit,
      hasMore: offset + sessions.length < (countResult[0]?.count ?? 0) });
  } catch (error) {
    logger.error({ err: error }, '[OwnerSupportAI] listSessions failed');
    return res.status(500).json({ error: 'Failed to load sessions' });
  }
}

/**
 * GET /api/support/ai/sessions/:id
 * Gets a single session with messages (owner must own the team).
 */
export async function getOwnerSupportSession(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const sessionId = Number(req.params.id);
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return res.status(400).json({ error: 'Invalid session ID' });
  try {
    const data = await supportSessionDetail(userId, sessionId);
    return data ? res.json({ success: true, data }) : res.status(404).json({ error: 'Session not found' });
  } catch (error) {
    logger.error({ err: error }, '[OwnerSupportAI] getSession failed');
    return res.status(500).json({ error: 'Failed to load session' });
  }
}

/**
 * POST /api/support/ai/chat
 * Owner directly chats with support AI using their own KB.
 * Body: { message, sessionId? }
 */
export async function ownerSupportChat(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { message, sessionId: existingSessionId, channel } = req.body;
    if (req.body.requestId != null && !validConversationRequestId(req.body.requestId)) return res.status(400).json({ error: 'Invalid message identity' });
    if (req.body.clientSessionKey != null && !validConversationRequestId(req.body.clientSessionKey)) return res.status(400).json({ error: 'Invalid session identity' });
    req.body.requestId ||= randomUUID();
    const clientSessionKey = req.body.clientSessionKey ? `user:${req.user!.id}:${req.body.clientSessionKey}` : `user:${req.user!.id}:${req.body.requestId}`;
    const mode = req.body.mode === 'preview' ? 'preview' : 'advisory';
    let preparedAttachments;
    try { preparedAttachments = await prepareSupportChatAttachments(userId, req.body.attachments); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid attachments' }); }
    const { attachments } = preparedAttachments;
    let { referenceContext, referenceEvidence } = preparedAttachments;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (existingSessionId != null && (!Number.isSafeInteger(Number(existingSessionId)) || Number(existingSessionId) <= 0)) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }
    if (channel != null && !['web', 'whatsapp', 'instagram', 'facebook', 'email'].includes(channel)) {
      return res.status(400).json({ error: 'Invalid channel' });
    }

    await requireSupportChatAssistant({
      userId, conversationId: -1_000_000_000, channel: channel || 'web',
      senderIdentifier: `owner:${userId}`, inboundText: '',
      metadata: {
        executionMode: mode, conversationKind: 'owner_support',
        simulationAssistantId: req.body.assistantId,
        simulationRevision: req.body.assistantRevision === 'draft' ? 'draft' : 'published',
      },
    });

    // Find or verify a team member to associate the session with
    let teamId: number;
    const teams = await db.select({ id: supportTeamsTable.id })
      .from(supportTeamsTable)
      .where(eq(supportTeamsTable.userId, userId))
      .limit(1);

    if (teams.length === 0) {
      // Auto-create a default support team for the owner to prevent blocking
      const [newTeam] = await db.insert(supportTeamsTable).values({
        userId,
        name: 'Default Support Team',
        description: 'Auto-created support team for testing AI chat',
      }).returning();
      teamId = newTeam.id;
    } else {
      teamId = teams[0].id;
    }

    const members = await db.select({ id: teamMembersTable.id })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.teamId, teamId))
      .limit(1);

    let memberId: number;
    if (members.length === 0) {
      // Auto-create a default member for the team
      const [newMember] = await db.insert(teamMembersTable).values({
        teamId,
        userId,
        name: 'Support Agent',
        // Session-only member: no shared login address across workspaces.
        email: null,
        role: 'member',
      }).returning();
      memberId = newMember.id;
    } else {
      memberId = members[0].id;
    }

    let sessionId = existingSessionId ? parseInt(existingSessionId) : null;

    // Create session if needed
    if (!sessionId) {
      const [createdSession] = await db.insert(supportChatSessionsTable).values({
        memberId, clientSessionKey,
        title: redactPiiWithStableTokens(message.trim()).redactedText.slice(0, 60),
        metadata: { channel, mode },
      }).onConflictDoNothing().returning();
      const session = createdSession || (clientSessionKey ? (await db.select().from(supportChatSessionsTable)
        .where(eq(supportChatSessionsTable.clientSessionKey, clientSessionKey)).limit(1))[0] : null);
      if (!session) throw new Error('Unable to resolve support session');
      sessionId = session.id;
    } else {
      // Verify session exists and belongs to owner's team
      const [session] = await db.select().from(supportChatSessionsTable)
        .where(eq(supportChatSessionsTable.id, sessionId));
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const ownerMembership = await db.execute(sql`
        SELECT tm.id FROM team_members tm
        JOIN support_teams st ON st.id = tm.team_id
        WHERE tm.id = ${session.memberId} AND st.user_id = ${userId}
        LIMIT 1
      `);
      if (ownerMembership.rows.length === 0) return res.status(403).json({ error: 'Session does not belong to this workspace' });
      
      // Update session channel in metadata
      const currentMeta = session.metadata || {};
      await db.update(supportChatSessionsTable)
        .set({ metadata: { ...currentMeta, channel, mode } })
        .where(eq(supportChatSessionsTable.id, sessionId));
    }

    const generate = async () => {
    await retainSupportChatAttachments(userId, sessionId!, attachments.map(file => file.id));
    // Save user message
    const [userMsg] = await db.insert(supportChatMessagesTable).values({
      sessionId: sessionId!,
      role: 'user',
      requestId: req.body.requestId ? `${req.body.requestId}:user` : undefined,
      content: redactPiiWithStableTokens(message.trim(), { userId, conversationId: -1_000_000_000 - sessionId! }).redactedText,
      metadata: { channel, attachments },
    }).returning();

    // Build context
    const recentMessages = await db.select({
      id: supportChatMessagesTable.id,
      role: supportChatMessagesTable.role,
      content: supportChatMessagesTable.content,
      metadata: supportChatMessagesTable.metadata,
    }).from(supportChatMessagesTable)
      .where(eq(supportChatMessagesTable.sessionId, sessionId!))
      .orderBy(desc(supportChatMessagesTable.createdAt))
      .limit(80);

    const chronological = recentMessages.reverse();
    const { messages: memoryHistory, memory } = supportConversationContext(chronological.slice(0, -1));
    const conversationHistory = [...memoryHistory, chronological[chronological.length - 1]];
    await db.update(supportChatSessionsTable).set({ summary: JSON.stringify(memory) }).where(eq(supportChatSessionsTable.id, sessionId!));
    const recentAttachmentIds = [...new Set(chronological.slice().reverse()
      .flatMap((item: { role: string; metadata: any }) => item.role === 'user' && Array.isArray(item.metadata?.attachments)
        ? item.metadata.attachments.map((file: { id?: string }) => file.id).filter(Boolean) : []))].slice(0, 5);
    if (recentAttachmentIds.length) {
      // Reload server-owned extraction every turn; expired/deleted uploads cannot
      // survive as trusted cached evidence inside chat history.
      try {
        const recent = await prepareSupportChatAttachments(userId, recentAttachmentIds.map(id => ({ id })));
        referenceContext = recent.referenceContext; referenceEvidence = recent.referenceEvidence;
      } catch {
        referenceContext += '\nEarlier attachments are unavailable or expired. Ask the user to upload them again; do not infer their contents.';
      }
    }

    // Resolve visitor/guest name
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sessionMeta: any = {};
    if (sessionId) {
      const [session] = await db.select().from(supportChatSessionsTable)
        .where(eq(supportChatSessionsTable.id, sessionId));
      if (session) {
        sessionMeta = session.metadata || {};
      }
    }
    const guestName = req.body.visitorName || sessionMeta.visitorName || 'Guest';

    let answer = "I'm having trouble generating a response right now. Please try again.";
    let confidence = 0;
    let sources: Array<{ sourceId?: number; citation?: string; title: string; excerpt: string; similarity: number }> = [];
    let provenance: Record<string, unknown> = {};
    let mediaAttachments: Array<Record<string, unknown>> = [];

    try {
      const agentResult = await agentRouter.handle({
        userId,
        conversationId: -1_000_000_000 - sessionId!,
        channel: channel || 'web',
        phoneNumberId: null,
        inboundText: message.trim(),
        leadId: null,
        leadName: guestName,
        leadCompany: null,
        recipientPhone: `owner:${userId}`,
        rawMessageId: `owner-support:${userMsg.id}`,
        metadata: {
          executionMode: mode,
          conversationKind: 'owner_support',
          simulationAssistantId:req.body.assistantId,
          simulationRevision:req.body.assistantRevision === 'draft' ? 'draft' : 'published',
          platformInstructions: mode === 'preview'
            ? 'Simulate the published customer journey. Follow its collection and capability steps. Read-only public tools are available; write actions are suppressed. Never claim a booking, payment or human handoff happened in this preview.'
            : 'Answer the workspace owner using published knowledge and enabled read-only tools. For live hotel availability or pricing questions, use the read-only availability tool and return its verified public booking link when supplied. This is internal support assistance. Do not start customer intake or ask for contact details. Do not perform writes or external actions. Return Markdown with the requested headings and lists; the application converts it to the selected channel format. Include all requested published options and their qualifications.',
          supportSessionId: sessionId,
          referenceContext,
          referenceEvidence,
          conversationHistory: conversationHistory.slice(0, -1),
        },
      });
      provenance = agentResult?.provenance || {};
      mediaAttachments = (agentResult?.verifiedMedia || []).map(media => ({
        assetId: media.assetId, originalName: media.name, mimeType: media.mimeType,
        url: `/api/settings/media-galleries/assets/${media.assetId}/content`, altText: media.altText,
      }));
      if (agentResult?.answerVerification?.mayDeliver === false) {
        answer = 'I do not have enough approved information to verify that. Please check an authorized source.';
      } else if (agentResult?.deliveryOutcome === 'auto_sent' && agentResult.replyText) {
        answer = agentResult.replyText;
        if (agentResult.answerVerification?.reason === 'verbatim_published_evidence') {
          answer = presentPublishedQuote(answer, message);
        }
        confidence = agentResult.confidence ?? 0;
        sources = (agentResult.kbSourcesUsed || []).map((source) => ({
          sourceId: source.sourceId,
          citation: source.citation,
          title: source.title,
          sourceUrl: source.sourceUrl,
          excerpt: source.excerpt,
          similarity: source.similarity,
        }));
      } else if (agentResult?.deliveryOutcome === 'human_handoff' || agentResult?.deliveryOutcome === 'pending_approval') {
        answer = 'This request needs human review before a response can be used.';
      }
    } catch (error) {
      if (error instanceof ConversationRequestError) throw error;
      logger.error({ err: error }, '[OwnerSupportAI] Agent dispatch failed');
    }

    // Save assistant message
    let formattedAnswer = answer;
    if (channel && channel !== 'web') {
      formattedAnswer = formatMessageForChannel(answer, channel);
    }

    const answerParts = formattedAnswer.includes("|||")
      ? formattedAnswer.split("|||").map((p) => p.trim()).filter((p) => p.length > 0)
      : [formattedAnswer];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assistantMessages: any[] = [];
    for (const [index, part] of answerParts.entries()) {
      const [msg] = await db.insert(supportChatMessagesTable).values({
        sessionId: sessionId!,
        role: 'assistant',
        requestId: req.body.requestId ? `${req.body.requestId}:assistant:${index}` : undefined,
        content: part,
        sources: sources,
        confidence,
        metadata: { channel, mode, provenance, attachments: mediaAttachments },
      }).returning();
      assistantMessages.push(msg);
    }

    // Update session timestamp
    await db.update(supportChatSessionsTable)
      .set({ updatedAt: new Date() })
      .where(eq(supportChatSessionsTable.id, sessionId!));

    return ({
      success: true,
      data: {
        sessionId,
        userMessage: userMsg,
        assistantMessage: assistantMessages[assistantMessages.length - 1],
        assistantMessages,
        response: { answer, confidence, sources },
      },
    });
    };
    const response = req.body.requestId ? await conversationRequests.run({ userId, kind: 'support_advisory', conversationId: sessionId!,
      requestId: req.body.requestId, input: { message, channel, mode, attachments: attachments.map(file => file.id) } }, generate) : await generate();
    return res.json(response);
  } catch (error) {
    if (error instanceof ConversationRequestError) return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    logger.error({ err: error }, '[OwnerSupportAI] chat failed');
    return res.status(500).json({ error: 'Failed to process message. Please try again.' });
  }
}

/**
 * DELETE /api/support/ai/sessions/:id
 */
export async function deleteOwnerSupportSession(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const [session] = await db.select().from(supportChatSessionsTable)
      .where(eq(supportChatSessionsTable.id, sessionId));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Verify the session's member belongs to owner's team
    const [member] = await db.select({ teamId: teamMembersTable.teamId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, session.memberId));
    if (!member) return res.status(404).json({ error: 'Session not found' });

    const [team] = await db.select({ userId: supportTeamsTable.userId })
      .from(supportTeamsTable)
      .where(eq(supportTeamsTable.id, member.teamId));
    if (!team || team.userId !== userId) return res.status(403).json({ error: 'Access denied' });

    await db.delete(supportChatSessionsTable).where(eq(supportChatSessionsTable.id, sessionId));
    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, '[OwnerSupportAI] deleteSession failed');
    return res.status(500).json({ error: 'Failed to delete session' });
  }
}

export async function archiveOwnerSupportSession(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  const id = Number(req.params.id);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { archived, title } = req.body ?? {};
  if (!Number.isSafeInteger(id) || id <= 0 || (archived === undefined && title === undefined)
    || (archived !== undefined && typeof archived !== 'boolean')
    || (title !== undefined && (typeof title !== 'string' || !title.trim() || title.trim().length > 255))) {
    return res.status(400).json({ error: 'A valid session ID and title (1–255 characters) or archived boolean are required' });
  }
  try {
    const result = await db.execute(sql`UPDATE support_chat_sessions s
      SET metadata = (CASE WHEN jsonb_typeof(s.metadata)='object' THEN s.metadata ELSE '{}'::jsonb END) || ${JSON.stringify(archived === undefined ? {} : { archived })}::jsonb,
          title = CASE WHEN ${title !== undefined} THEN ${title !== undefined ? redactPiiWithStableTokens(title.trim()).redactedText : null} ELSE s.title END,
          updated_at = NOW()
      FROM team_members m JOIN support_teams t ON t.id = m.team_id
      WHERE s.id = ${id} AND s.member_id = m.id AND t.user_id = ${userId}
        ${currentBusinessScope() ? sql`AND s.business_profile_id=${currentBusinessScope()!.businessProfileId} AND m.business_profile_id=${currentBusinessScope()!.businessProfileId} AND t.business_profile_id=${currentBusinessScope()!.businessProfileId}` : sql``}
      RETURNING s.id,s.title,s.metadata->'archived' AS archived`);
    return result.rows.length ? res.json({ success: true, data: result.rows[0] })
      : res.status(404).json({ error: 'Session not found' });
  } catch (error) {
    logger.error({ err: error }, '[OwnerSupportAI] updateSession failed');
    return res.status(500).json({ error: 'Failed to update session' });
  }
}

/**
 * GET /api/support/ai/sessions/by-lead/:leadId
 * Returns support chat sessions linked to a specific lead, with message counts.
 * Owner must own the lead.
 */
export async function getSupportSessionsByLead(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const leadId = parseInt(req.params.leadId);
    if (isNaN(leadId)) return res.status(400).json({ error: 'Invalid lead ID' });

    // Verify the lead belongs to this user
    const [lead] = await db.select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // Get sessions linked to this lead
    const sessions = await db.select().from(supportChatSessionsTable)
      .where(eq(supportChatSessionsTable.leadId, leadId))
      .orderBy(desc(supportChatSessionsTable.updatedAt));

    // Get message counts for each session
    const sessionsWithCounts = await Promise.all(
      sessions.map(async (s: SupportChatSession) => {
        const [countRow] = await db.select({ count: sql<number>`count(*)::int` })
          .from(supportChatMessagesTable)
          .where(eq(supportChatMessagesTable.sessionId, s.id));
        
        // Get last message preview
        const [lastMsg] = await db.select({
          content: supportChatMessagesTable.content,
          role: supportChatMessagesTable.role,
          createdAt: supportChatMessagesTable.createdAt,
        }).from(supportChatMessagesTable)
          .where(eq(supportChatMessagesTable.sessionId, s.id))
          .orderBy(desc(supportChatMessagesTable.createdAt))
          .limit(1);

        // Get member name
        const [member] = await db.select({ name: teamMembersTable.name })
          .from(teamMembersTable)
          .where(eq(teamMembersTable.id, s.memberId));

        return {
          ...s,
          messageCount: countRow?.count ?? 0,
          lastMessage: lastMsg ? { content: lastMsg.content, role: lastMsg.role, createdAt: lastMsg.createdAt } : null,
          memberName: member?.name || 'Unknown',
        };
      })
    );

    return res.json({ success: true, data: sessionsWithCounts });
  } catch (error) {
    logger.error({ err: error }, '[OwnerSupportAI] getSupportSessionsByLead failed');
    return res.status(500).json({ error: 'Failed to load support sessions' });
  }
}

/**
 * GET /api/support/ai/sessions/:sessionId/messages
 * Returns all messages for a support session (for embedding in lead detail view).
 * Owner must own the team that the session belongs to.
 */
export async function getSupportSessionMessages(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const sessionId = Number(req.params.sessionId);
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return res.status(400).json({ error: 'Invalid session ID' });
  try {
    const data = await supportSessionDetail(userId, sessionId);
    return data ? res.json({ success: true, data: data.messages }) : res.status(404).json({ error: 'Session not found' });
  } catch (error) {
    logger.error({ err: error }, '[OwnerSupportAI] getSupportSessionMessages failed');
    return res.status(500).json({ error: 'Failed to load messages' });
  }
}

/**
 * GET /api/support/ai/report
 * Returns widget conversation stats and leads generated from support widget.
 */
export async function getSupportAIReport(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const query = parseSupportReportQuery(req.query);
    return res.json({ success: true, data: await supportAIReport(userId, query) });
  } catch (error) {
    if (error instanceof SupportReportValidationError) return res.status(400).json({ error: error.message });
    logger.error({ err: error }, '[OwnerSupportAI] getSupportAIReport failed');
    return res.status(500).json({ error: 'Failed to load report' });
  }
}

export async function getSupportAIQuality(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.json({ success: true, data: await supportAIQuality(userId, parseSupportQualityQuery(req.query)) });
  } catch (error) {
    if (error instanceof SupportReportValidationError) return res.status(400).json({ error: error.message });
    logger.error({ err: error }, '[OwnerSupportAI] getSupportAIQuality failed');
    return res.status(500).json({ error: 'Failed to load answer quality' });
  }
}

export async function updateSupportMessageFeedback(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const messageId = Number(req.params.messageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'Invalid message ID' });
  try {
    const feedback = parseStaffFeedback(req.body);
    // Free-text staff notes follow the same storage redaction policy as chat.
    if (feedback.notes) feedback.notes = redactPiiWithStableTokens(feedback.notes).redactedText;
    const data = await saveSupportStaffFeedback(userId, req.user!.id, messageId, feedback);
    return data ? res.json({ success: true, data }) : res.status(404).json({ error: 'Assistant message not found' });
  } catch (error) {
    if (error instanceof SupportReportValidationError) return res.status(400).json({ error: error.message });
    logger.error({ err: error }, '[OwnerSupportAI] updateMessageFeedback failed');
    return res.status(500).json({ error: 'Failed to save answer feedback' });
  }
}
