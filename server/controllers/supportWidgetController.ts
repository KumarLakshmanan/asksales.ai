import { normalizeWidgetSettings, widgetSettingsError, widgetColorForeground, widgetRequestOrigin } from '../../shared/supportWidgetSettings.js';
import { SUPPORT_WIDGET_CLOSE_MESSAGE, SUPPORT_WIDGET_HOST_PARAMETER } from '../../shared/supportWidgetEmbed.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { widgetCommitEnvelope, finishWidgetCommit } from '../services/agents/orchestration/WidgetCommitRecovery.js';
import { validConversationRequestId } from '../services/ConversationRequestCoordinator.js';
import { Request, Response } from 'express';
import { db } from '../models/db.js';
import { supportChatSessionsTable } from '../models/supportChatSessions/schema.js';
import { supportChatMessagesTable } from '../models/supportChatMessages/schema.js';
import { teamMembersTable } from '../models/teamMembers/schema.js';
import { supportTeamsTable } from '../models/supportTeams/schema.js';
import { leadsTable } from '../models/leads/schema.js';
import { supportTicketsTable } from '../models/supportTickets/schema.js';
import { supportTicketMessagesTable } from '../models/supportTicketMessages/schema.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { agentRouter } from '../services/agents/AgentRouter.js';
import { privacyVaultService, redactPiiWithStableTokens } from '../services/agents/orchestration/PrivacyVaultService.js';
import crypto from 'crypto';
import { getBusinessProfileContextByUserId } from '../models/companySettings/functions.js';
import type { AgentResult } from '../services/agents/BaseOutreachAgent.js';
import type { AssistantProvenance } from '../../shared/outreachAssistants.js';
import { contentDisposition } from '../utils/contentDisposition.js';
import type { ApprovedSupportDocument } from '../services/supportDocuments/ApprovedSupportDocuments.js';
import { downloadWidgetDocument, loadApprovedWidgetDocument, publicWidgetMessage } from '../services/supportDocuments/SupportWidgetDocuments.js';
import { supportConversationTurnsEnabled, currentSupportTurn, assertSupportTurnFresh, sealSupportTurn, SupersededSupportTurn, supportTurnDeliveryMetadata, supportOwnershipSnapshot } from '../services/agents/orchestration/SupportConversationTurn.js';
import { assistantProvenanceCurrent, withPublishedAssistant } from '../services/assistants/AssistantFreshness.js';

function parseWidgetSessionId(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null;
}

/**
 * Resolves a widget token to the owner userId and a member ID for session association.
 */
async function resolveWidgetToken(token: string) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;

  const [team] = await db.select({
    id: supportTeamsTable.id,
    userId: supportTeamsTable.userId,
    name: supportTeamsTable.name,
    widgetSettings: supportTeamsTable.widgetSettings,
  }).from(supportTeamsTable)
    .where(and(
      eq(supportTeamsTable.widgetToken, token),
      eq(supportTeamsTable.isActive, true),
    ))
    .limit(1);

  if (!team) return null;

  const [member] = await db.select({ id: teamMembersTable.id })
    .from(teamMembersTable)
    .leftJoin(supportTicketsTable, and(
      eq(supportTicketsTable.assignedMemberId, teamMembersTable.id),
      inArray(supportTicketsTable.status, ['open', 'in_progress']),
    ))
    .where(and(
      eq(teamMembersTable.teamId, team.id),
      eq(teamMembersTable.isActive, true),
    ))
    .groupBy(teamMembersTable.id)
    .orderBy(sql`COUNT(${supportTicketsTable.id}) ASC`, teamMembersTable.id)
    .limit(1);

  return { teamId: team.id, userId: team.userId, teamName: team.name, widgetSettings: normalizeWidgetSettings(team.widgetSettings), memberId: member?.id ?? null };
}

/**
 * POST /api/support-widget/chat
 * Public endpoint: visitor chats with the support AI via widget token.
 * Body: { token, message, sessionId?, visitorName?, visitorEmail?, visitorPhone? }
 */
export async function widgetChat(req: Request, res: Response) {
  try {
    const {
      token, message, sessionId: existingSessionId, sessionToken, requestId,
      visitorName, visitorEmail, visitorPhone,
    } = req.body;

    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) {
      return res.status(401).json({ error: 'A valid widget token is required' });
    }
    if (typeof message !== 'string' || !message.trim() || message.trim().length > 10_000) {
      return res.status(400).json({ error: 'Message must be between 1 and 10,000 characters' });
    }
    let sessionId = existingSessionId == null ? null : parseWidgetSessionId(existingSessionId);
    if (existingSessionId != null && sessionId === null) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }
    if (
      (requestId !== undefined && (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 128))
      || (visitorName !== undefined && (typeof visitorName !== 'string' || visitorName.length > 120))
      || (visitorEmail !== undefined && (typeof visitorEmail !== 'string' || visitorEmail.length > 254))
      || (visitorPhone !== undefined && (typeof visitorPhone !== 'string' || visitorPhone.length > 50))
    ) {
      return res.status(400).json({ error: 'Invalid widget visitor details' });
    }

    const resolved = await resolveWidgetToken(token);
    if (!resolved) return res.status(401).json({ error: 'Invalid widget token' });

    if (!resolved.memberId) {
      return res.status(400).json({ error: 'Support team has no members configured' });
    }

    const { userId, memberId } = resolved;
    const rawInboundText = message.trim();
    const inboundPreview = redactPiiWithStableTokens(rawInboundText);
    let sessionPublicToken = typeof sessionToken === 'string' ? sessionToken : null;

    if (req.body.clientSessionKey != null && !validConversationRequestId(req.body.clientSessionKey)) return res.status(400).json({ error: 'Invalid session identity' });
    const initialKey = req.body.clientSessionKey || requestId;
    const clientSessionKey = initialKey ? `widget:${userId}:${resolved.teamId}:${initialKey}` : null;
    // Create or validate session
    if (!sessionId) {
      const safeTitleSource = inboundPreview.redactedText || 'Support conversation';
      const title = safeTitleSource.length > 60 ? safeTitleSource.substring(0, 57) + '...' : safeTitleSource;
      const redactedName = visitorName?.trim()
        ? redactPiiWithStableTokens(`My name is ${visitorName.trim()}`).redactedText.replace(/^My name is\s+/i, '')
        : undefined;

      const metadata: Record<string, unknown> = {
        source: 'widget',
        widgetOrigin: widgetRequestOrigin(req.get('origin')),
        visitorName: redactedName,
        visitorEmail: visitorEmail?.trim() ? redactPiiWithStableTokens(visitorEmail.trim()).redactedText : undefined,
        visitorPhone: visitorPhone?.trim() ? redactPiiWithStableTokens(visitorPhone.trim()).redactedText : undefined,
      };

      sessionPublicToken = crypto.randomBytes(32).toString('base64url');
      const [createdSession] = await db.insert(supportChatSessionsTable).values({
        memberId, clientSessionKey,
        title,
        leadId: null,
        metadata,
        publicToken: sessionPublicToken,
        // M16 — 24h widget chat session expiry
        sessionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }).onConflictDoNothing().returning();
      const session = createdSession || (clientSessionKey ? (await db.select().from(supportChatSessionsTable)
        .where(eq(supportChatSessionsTable.clientSessionKey, clientSessionKey)).limit(1))[0] : null);
      if (!session || (session.sessionExpiresAt && new Date(session.sessionExpiresAt).getTime() <= Date.now())) return res.status(401).json({ error: 'This session has expired.' });
      sessionPublicToken = session.publicToken!;
      sessionId = session.id;

      const rawProfile = [
        visitorName?.trim() ? `My name is ${visitorName.trim()}` : '',
        visitorEmail?.trim() ? `Email: ${visitorEmail.trim()}` : '',
        visitorPhone?.trim() ? `Phone: ${visitorPhone.trim()}` : '',
      ].filter(Boolean).join('\n');
      if (rawProfile) {
        const protectedProfile = await privacyVaultService.protectInbound({
          userId,
          conversationId: -session.id,
          channel: 'web',
          rawText: rawProfile,
          providerMessageId: `widget-profile:${session.id}`,
          entityType: 'widget_profile',
          entityId: session.id,
        });
        if (protectedProfile.vaultId) {
          await db.update(supportChatSessionsTable).set({
            metadata: { ...metadata, profilePrivacyVaultId: protectedProfile.vaultId },
          }).where(eq(supportChatSessionsTable.id, session.id));
        }
      }
    } else {
      const [session] = await db.select({
        id: supportChatSessionsTable.id,
        leadId: supportChatSessionsTable.leadId,
        metadata: supportChatSessionsTable.metadata,
        memberId: supportChatSessionsTable.memberId,
        publicToken: supportChatSessionsTable.publicToken,
        sessionExpiresAt: supportChatSessionsTable.sessionExpiresAt,
      })
        .from(supportChatSessionsTable)
        .where(eq(supportChatSessionsTable.id, sessionId));
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!sessionPublicToken || !session.publicToken || sessionPublicToken !== session.publicToken) {
        return res.status(403).json({ error: 'Invalid session credential' });
      }
      const [sessionMember] = await db.select({ teamId: teamMembersTable.teamId })
        .from(teamMembersTable).where(and(
          eq(teamMembersTable.id, session.memberId),
          eq(teamMembersTable.isActive, true),
        )).limit(1);
      if (sessionMember?.teamId !== resolved.teamId) {
        return res.status(403).json({ error: 'Session does not belong to this widget' });
      }
      if (session.sessionExpiresAt && session.sessionExpiresAt < new Date()) {
        return res.status(440).json({ error: 'Session expired. Please start a new conversation.', code: 'SESSION_EXPIRED' });
      }
    }

    // Check if this session already has a lead or visitor details collected
    const [currentSession] = await db.select({
      leadId: supportChatSessionsTable.leadId,
      ticketId: supportChatSessionsTable.ticketId,
      metadata: supportChatSessionsTable.metadata,
    }).from(supportChatSessionsTable)
      .where(eq(supportChatSessionsTable.id, sessionId!))
      .limit(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guestName = (currentSession?.metadata as any)?.visitorName || 'Guest';
    const stableRequestId = typeof requestId === 'string' ? requestId : crypto.randomUUID();
    const userRequestId = `${stableRequestId}:user`;
    const assistantRequestId = `${stableRequestId}:assistant`;
    let [userMsg] = await db.insert(supportChatMessagesTable).values({
      sessionId,
      role: 'user',
      requestId: userRequestId,
      content: inboundPreview.redactedText,
      processingStatus: 'processing',
      processingStartedAt: new Date(),
      processingExpiresAt: new Date(Date.now() + 2 * 60 * 1000),
      metadata: { piiProtected: inboundPreview.tokenCount > 0, piiTypes: inboundPreview.piiTypes, requestInputHash: crypto.createHash('sha256').update(message.trim()).digest('hex') },
    }).onConflictDoNothing().returning();

    if (!userMsg) {
      const existing = await db.select().from(supportChatMessagesTable).where(and(
        eq(supportChatMessagesTable.sessionId, sessionId!),
        inArray(supportChatMessagesTable.requestId, [userRequestId, assistantRequestId]),
      )).orderBy(supportChatMessagesTable.createdAt);
      const existingUser = existing.find((item: typeof existing[number]) => item.requestId === userRequestId);
      const savedHash = (existingUser?.metadata as Record<string, unknown> | undefined)?.requestInputHash;
      if (existingUser && (savedHash ? savedHash !== crypto.createHash('sha256').update(message.trim()).digest('hex') : existingUser.content !== inboundPreview.redactedText)) {
        return res.status(409).json({ success: false, error: 'This message identity was already used for different content.', code: 'request_conflict' });
      }
      const existingAssistant = existing.find((item: typeof existing[number]) => item.requestId === assistantRequestId);
      if (!existingAssistant && existingUser?.processingStatus === 'completed') {
        return res.status(202).json({ success: true, data: {
          sessionId, sessionToken: sessionPublicToken, userMessage: publicWidgetMessage(existingUser!),
          assistantMessage: null, processingStatus: 'completed',
        } });
      }
      if (!existingAssistant) {
        const [reclaimed] = existingUser
          ? await db.update(supportChatMessagesTable).set({
              processingStatus: 'processing',
              processingStartedAt: new Date(),
              processingExpiresAt: new Date(Date.now() + 2 * 60 * 1000),
            }).where(and(
              eq(supportChatMessagesTable.id, existingUser.id),
              sql`${supportChatMessagesTable.processingExpiresAt} < NOW()`,
            )).returning()
          : [];
        if (!reclaimed) {
          return res.status(409).json({ error: 'This message is still being processed. Retry shortly.' });
        }
        userMsg = reclaimed;
      } else {
        if (['cancelled','superseded'].includes(existingAssistant.processingStatus)) return res.status(409).json({ success: false, error: 'This reply was stopped. Please send a new message.', code: 'cancelled' });
        if (existingAssistant.processingStatus !== 'completed' || existingUser?.processingStatus !== 'completed') {
          if (existingAssistant.processingStatus === 'committing') await finishWidgetCommit(userId, existingAssistant.id);
          else return res.status(409).json({ success: false, error: 'The saved reply requires recovery before it can be shown.', code: 'reconciliation_required' });
          const refreshed = await db.select().from(supportChatMessagesTable).where(and(
            eq(supportChatMessagesTable.sessionId, sessionId!),
            inArray(supportChatMessagesTable.id, [existingAssistant.id, existingUser!.id]),
          ));
          const committed = refreshed.find((item: typeof existingAssistant) => item.id === existingAssistant.id);
          const committedUser = refreshed.find((item: typeof existingAssistant) => item.id === existingUser!.id);
          if (committed?.processingStatus !== 'completed' || committedUser?.processingStatus !== 'completed') return res.status(409).json({ success: false, error: 'The reply is still being committed.', code: 'committing' });
          Object.assign(existingAssistant, committed);
          Object.assign(existingUser!, committedUser);
        }
        return res.json({
          success: true,
          data: {
            sessionId,
            sessionToken: sessionPublicToken,
            userMessage: publicWidgetMessage(existingUser!),
            assistantMessage: publicWidgetMessage(existingAssistant),
            response: {
              answer: existingAssistant.content,
              confidence: existingAssistant.confidence || 0,
              sources: [],
            },
          },
        });
      }
    }
    const { registerSupportTurnInput } = await import('../services/agents/orchestration/SupportConversationTurn.js');
    await registerSupportTurnInput('process_support_widget_turn', { userId, sessionId: sessionId!, widgetMessageId: userMsg.id,
      inboundText: inboundPreview.redactedText }, false);
    const protectedInbound = await privacyVaultService.protectInbound({
      userId,
      conversationId: -sessionId!,
      channel: 'web',
      rawText: rawInboundText,
      providerMessageId: `widget:${sessionId}:${stableRequestId}`,
      entityType: 'widget_message',
      entityId: userMsg.id,
    });
    if (supportConversationTurnsEnabled('web')) {
      const { jobDispatcher } = await import('../queues/JobDispatcher.js');
      await jobDispatcher.dispatch('process_support_widget_turn', {
        userId, sessionId: sessionId!, widgetMessageId: userMsg.id,
        inboundText: protectedInbound.redactedText,
        privacyPreprotected: { vaultId: protectedInbound.vaultId, tokenCount: protectedInbound.tokenCount, piiTypes: protectedInbound.piiTypes },
      });
      return res.status(202).json({ success: true, data: {
        sessionId, sessionToken: sessionPublicToken, userMessage: publicWidgetMessage(userMsg),
        assistantMessage: null, processingStatus: 'queued',
      } });
    }
    const result = await generateWidgetReply({ userId, sessionId: sessionId!, sessionPublicToken: sessionPublicToken!,
      userMsg, protectedInbound, guestName, currentSession, stableRequestId, assistantRequestId });
    return res.json(result);
  } catch (error) {
    logger.error({ err: error }, '[SupportWidget] chat failed');
    return res.status(500).json({ error: 'Failed to process message' });
  }
}

/** Shared adapter: legacy HTTP and coordinated worker delivery use identical
 * authorization, attachment, handoff, persistence and effect-commit logic. */
export async function generateWidgetReply(input: {
  userId: number; sessionId: number; sessionPublicToken: string;
  userMsg: typeof supportChatMessagesTable.$inferSelect;
  protectedInbound: { redactedText: string; vaultId: number | null; tokenCount: number; piiTypes: string[] };
  guestName: string;
  currentSession: { leadId: number | null; ticketId: number | null; metadata: unknown } | undefined;
  stableRequestId: string; assistantRequestId: string;
}) {
  const { userId, sessionId, sessionPublicToken, userMsg, protectedInbound, guestName,
    currentSession, stableRequestId, assistantRequestId } = input;
  let answer = "We couldn't complete that request. Please try again in a moment.";
  let confidence = 0;
  let deliveryOutcome = 'error';
  let deferredAgentDecision: AgentResult | null = null;
  let notificationAssistant: AssistantProvenance | undefined;
  let linkedTicketId = Number(currentSession?.ticketId || 0);
  let sources: Array<{
    title: string;
    excerpt: string;
    similarity: number;
    sourceId: number | null;
    citation: string;
  }> = [];
  let media: Array<{ assetId: number; name: string; caption?: string; altText: string; order: number }> = [];
  let choices: Array<{ id: string; label: string; shortLabel: string }> = [];
  let documents: ApprovedSupportDocument[] = [];

  try {
    const agentResult = await agentRouter.handle({
      userId,
      conversationId: -sessionId!,
      channel: 'web',
      phoneNumberId: null,
      inboundText: protectedInbound.redactedText,
      leadId: Number(currentSession?.leadId || 0) || null,
      leadName: guestName,
      leadCompany: null,
      recipientPhone: sessionPublicToken,
      rawMessageId: currentSupportTurn() ? `turn:${currentSupportTurn()!.id}` : `widget:${sessionId}:${stableRequestId}`,
      metadata: {
        conversationKind: 'support_widget',
        widgetSession: { id: sessionId!, token: sessionPublicToken! },
        deliveryDeferred: true,
        widgetMessageId: userMsg.id,
        privacyPreprotected: {
          piiTypes: protectedInbound.piiTypes,
          tokenCount: protectedInbound.tokenCount,
          vaultId: protectedInbound.vaultId,
        },
      },
    });
    deliveryOutcome = agentResult?.deliveryOutcome || 'error';
    if (deliveryOutcome === 'no_op') {
      await db.update(supportChatMessagesTable).set({ processingStatus: 'completed', processingExpiresAt: null })
        .where(inArray(supportChatMessagesTable.id, currentSupportTurn()?.messageIds || [userMsg.id]));
      return { success: true, data: { sessionId, sessionToken: sessionPublicToken,
        userMessage: publicWidgetMessage({ ...userMsg, processingStatus: 'completed' }),
        assistantMessage: null, response: { answer: '', confidence: 0, sources: [], media: [], choices: [] } } };
    }
    if (deliveryOutcome === 'ready_for_channel_delivery' && agentResult?.replyText) {
      if (!await assistantProvenanceCurrent(agentResult.deferredEffectContext?.assistantProvenance)) throw new SupersededSupportTurn();
      deferredAgentDecision = agentResult;
      answer = agentResult.replyText;
      confidence = agentResult.confidence ?? 0;
      sources = (agentResult.kbSourcesUsed || []).map((source) => ({
        title: source.title,
        excerpt: source.excerpt,
        similarity: source.similarity,
        sourceId: source.sourceId,
        citation: source.citation,
      }));
      media = (agentResult.verifiedMedia || []).map((item, order) => ({
        assetId: item.assetId,
        name: item.name,
        caption: item.caption,
        altText: item.altText,
        order,
      }));
      choices = (agentResult.choiceManifest?.options || []).map((option) => ({
        id: option.id,
        label: option.label,
        shortLabel: option.shortLabel,
      }));
      if (agentResult.approvedDocument) {
        if (agentResult.approvedDocument.userId !== userId || !await withPublishedAssistant(agentResult.deferredEffectContext?.assistantProvenance,
          ()=>loadApprovedWidgetDocument(agentResult.approvedDocument!))) {
          throw new Error('The selected document is no longer available.');
        }
        documents = [agentResult.approvedDocument];
      }
    }
    if (deliveryOutcome === 'pending_approval') {
      notificationAssistant = agentResult?.provenance?.assistant as AssistantProvenance | undefined;
      answer = 'That reply needs review before I can share it. You can ask another question here.';
      confidence = 0;
    }
    if (deliveryOutcome === 'human_handoff' || deliveryOutcome === 'no_op') {
      notificationAssistant = agentResult?.provenance?.assistant as AssistantProvenance | undefined;
      const handoff = await db.execute(sql`
        SELECT support_ticket_id
        FROM handoff_queue
        WHERE user_id = ${userId}
          AND conversation_id = ${-sessionId!}
          AND status IN ('waiting', 'assigned', 'in_progress')
        ORDER BY created_at DESC
        LIMIT 1
      `);
      linkedTicketId = Number((handoff.rows[0] as { support_ticket_id?: number } | undefined)?.support_ticket_id || 0);
      if (linkedTicketId) {
        await db.update(supportChatSessionsTable)
          .set({ ticketId: linkedTicketId, updatedAt: new Date() })
          .where(eq(supportChatSessionsTable.id, sessionId!));
        answer = deliveryOutcome === 'human_handoff'
          ? "I've connected you with our support team. A human representative will reply here shortly."
          : 'Your conversation is already with our support team. They will reply here shortly.';
      } else {
        deliveryOutcome = 'error';
        answer = "We couldn't create a human handoff. Please try again or contact support through another channel.";
      }
    }
  } catch (error) {
    if (error instanceof SupersededSupportTurn) throw error;
    if (deferredAgentDecision?.approvedDocument && !documents.length) {
      deferredAgentDecision = null; deliveryOutcome = 'error'; choices = []; media = []; confidence = 0; sources = [];
      answer = 'That document is no longer available to download. Please ask our team for the current version.';
    }
    logger.error({ err: error }, '[SupportWidget] Agent dispatch failed');
  }

  if (linkedTicketId) {
    await db.transaction(async (tx: typeof db) => {
      await tx.insert(supportTicketMessagesTable).values({
        ticketId: linkedTicketId,
        userId: null,
        direction: 'inbound',
        content: userMsg.content,
        isInternal: false,
      });
      await tx.update(supportTicketsTable).set({
        totalMessages: sql`${supportTicketsTable.totalMessages} + 1`,
        unreadCount: sql`${supportTicketsTable.unreadCount} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(supportTicketsTable.id, linkedTicketId),
        eq(supportTicketsTable.userId, userId),
      ));
    });
    // The inbound support-message insert above creates the canonical durable
    // customer_replied notification event in the same transaction.
  }

  // Sources are populated only from the exact chunks used by the canonical
  // KnowledgeRetrievalStage. Never run a second post-hoc search and label it
  // as evidence for an already-generated answer.
  if (deliveryOutcome !== 'ready_for_channel_delivery') sources = [];

  await assertSupportTurnFresh();
  if (deferredAgentDecision && !await assistantProvenanceCurrent(deferredAgentDecision.deferredEffectContext?.assistantProvenance)) throw new SupersededSupportTurn();
  await sealSupportTurn();
  // The encrypted decision is attached atomically to the pending reply. It is
  // hidden from customer history until its idempotent effects are committed.
  if (deferredAgentDecision) {
    deferredAgentDecision.mediaDeliverySucceeded = !deferredAgentDecision.mediaDeliveryAssertionRequired
      || Boolean(deferredAgentDecision.verifiedMedia?.length);
  }
  const commitOwnership = await supportOwnershipSnapshot(userId, -sessionId, 'web');
  const [assistantMsg] = await db.transaction(async (tx: typeof db) => {
    if (deferredAgentDecision && !await assistantProvenanceCurrent(deferredAgentDecision.deferredEffectContext?.assistantProvenance,tx)) throw new SupersededSupportTurn();
    const [message] = await tx.insert(supportChatMessagesTable).values({
      sessionId, role: 'assistant', requestId: assistantRequestId, content: answer, sources, confidence,
      processingStatus: 'committing', metadata: { media, choices, documents,
        ...(deferredAgentDecision?.choiceManifest?.fieldKey === 'support.handoffConsent'
          ? {handoffChoice:deferredAgentDecision.choiceManifest} : {}), ...supportTurnDeliveryMetadata(),
        assistant:deferredAgentDecision?.deferredEffectContext?.assistantProvenance ?? notificationAssistant },
    }).returning();
    if (deferredAgentDecision && documents.length) deferredAgentDecision.widgetDocumentReceipt = {
      sessionId, messageId: message.id, documentId: documents[0].id,
    };
    await tx.update(supportChatMessagesTable).set({ deferredCommit: widgetCommitEnvelope(userId, {
      sessionId, userMessageIds: currentSupportTurn()?.messageIds || [userMsg.id],
      inboundId: `widget:${sessionId}:${stableRequestId}`, decision: deferredAgentDecision, assistantProvenance: notificationAssistant, ownership: commitOwnership,
      supportTurn: currentSupportTurn() ? { scopeKey: currentSupportTurn()!.scopeKey, id: currentSupportTurn()!.id, revision: currentSupportTurn()!.revision } : undefined,
    }) }).where(eq(supportChatMessagesTable.id, message.id));
    return [message];
  });
  if (!await finishWidgetCommit(userId, assistantMsg.id)) {
    const [current]=await db.select({status:supportChatMessagesTable.processingStatus}).from(supportChatMessagesTable).where(eq(supportChatMessagesTable.id,assistantMsg.id));
    if (current?.status==='superseded') throw new SupersededSupportTurn();
    throw new Error('The widget reply is awaiting commit recovery.');
  }
  assistantMsg.processingStatus = 'completed';
  // Update session timestamp
  await db.update(supportChatSessionsTable)
    .set({ updatedAt: new Date() })
    .where(eq(supportChatSessionsTable.id, sessionId!));

  return ({
    success: true,
    data: {
      sessionId,
      sessionToken: sessionPublicToken,
      userMessage: publicWidgetMessage(userMsg),
      assistantMessage: publicWidgetMessage(assistantMsg),
      // Retrieval evidence stays in the operator record. Only the governed
      // answer and separately approved attachments are customer-facing.
      response: { answer, confidence, sources: [], media, choices },
    },
  });
}

/** Loads a credentialed widget session history, including async processing state. */
export async function getWidgetSessionMessages(req: Request, res: Response) {
  try {
    const token = req.query.token as string;
    const sessionToken = req.query.sessionToken as string;
    const sessionId = parseWidgetSessionId(req.params.sessionId);

    if (!token) return res.status(401).json({ error: 'Widget token is required' });
    if (!sessionToken) return res.status(401).json({ error: 'Session credential is required' });
    if (sessionId === null) return res.status(400).json({ error: 'Invalid session ID' });

    const resolved = await resolveWidgetToken(token);
    if (!resolved) return res.status(401).json({ error: 'Invalid widget token' });

    // Verify session belongs to a member of this team
    const [session] = await db.select({
      id: supportChatSessionsTable.id,
      memberId: supportChatSessionsTable.memberId,
      publicToken: supportChatSessionsTable.publicToken,
      sessionExpiresAt: supportChatSessionsTable.sessionExpiresAt,
      ticketId: supportChatSessionsTable.ticketId,
      metadata: supportChatSessionsTable.metadata,
    }).from(supportChatSessionsTable)
      .where(eq(supportChatSessionsTable.id, sessionId))
      .limit(1);

    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.publicToken || session.publicToken !== sessionToken) {
      return res.status(403).json({ error: 'Invalid session credential' });
    }
    if (session.sessionExpiresAt && session.sessionExpiresAt <= new Date()) {
      return res.status(440).json({ error: 'Session expired. Please start a new conversation.', code: 'SESSION_EXPIRED' });
    }

    // Verify the session's member belongs to the same team
    const [member] = await db.select({ teamId: teamMembersTable.teamId })
      .from(teamMembersTable)
      .where(and(
        eq(teamMembersTable.id, session.memberId),
        eq(teamMembersTable.isActive, true),
      ))
      .limit(1);

    if (!member || member.teamId !== resolved.teamId) {
      return res.status(403).json({ error: 'Session does not belong to this widget' });
    }

    const messages = await db.select({
      id: supportChatMessagesTable.id,
      role: supportChatMessagesTable.role,
      content: supportChatMessagesTable.content,
      sources: supportChatMessagesTable.sources,
      confidence: supportChatMessagesTable.confidence,
      metadata: supportChatMessagesTable.metadata,
      createdAt: supportChatMessagesTable.createdAt,
      processingStatus: supportChatMessagesTable.processingStatus,
    }).from(supportChatMessagesTable)
      .where(eq(supportChatMessagesTable.sessionId, sessionId))
      .orderBy(supportChatMessagesTable.createdAt);

    let handoff: string | null = null;
    if (session.ticketId) {
      const [ticket] = await db.select({ status: supportTicketsTable.status }).from(supportTicketsTable)
        .where(and(eq(supportTicketsTable.id, session.ticketId), eq(supportTicketsTable.userId, resolved.userId))).limit(1);
      handoff = ticket && ['open', 'in_progress'].includes(ticket.status || '') ? 'requested' : null;
    }
    return res.json({ success: true, session: { expiresAt: session.sessionExpiresAt, handoff, customerFeedback: (session.metadata as Record<string, unknown> | null)?.customerFeedback || null }, data: messages.filter((message: { role: string; processingStatus: string }) => message.role !== 'assistant' || message.processingStatus === 'completed').map(publicWidgetMessage) });
  } catch (error) {
    logger.error({ err: error }, '[SupportWidget] getWidgetSessionMessages failed');
    return res.status(500).json({ error: 'Failed to load messages' });
  }
}

/** Serve only media that was actually attached to an assistant message in this
 * widget session. The storage file itself remains private and tenant-scoped. */
export async function getWidgetSessionDocument(req: Request, res: Response) {
  try {
    const resolved = await resolveWidgetToken(String(req.body?.token || ''));
    if (!resolved) return res.status(401).json({ error: 'Invalid widget token' });
    const file = await downloadWidgetDocument({ userId: resolved.userId, teamId: resolved.teamId,
      sessionId: Number(req.params.sessionId), messageId: Number(req.params.messageId), documentId: Number(req.params.documentId),
      sessionToken: typeof req.body?.sessionToken === 'string' ? req.body.sessionToken : '' });
    if (!file) return res.status(404).json({ error: 'This PDF is unavailable or your chat session has expired.' });
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',contentDisposition(`${file.title}.pdf`));
    res.setHeader('Cache-Control','private, no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");
    return res.send(file.buffer);
  } catch { return res.status(503).json({ error: 'The PDF could not be downloaded. Please try again.' }); }
}

export async function getWidgetSessionMedia(req: Request, res: Response) {
  try {
    const token = String(req.query.token || '');
    const sessionToken = String(req.query.sessionToken || '');
    const sessionId = Number(req.params.sessionId);
    const assetId = Number(req.params.assetId);
    if (!sessionToken || !/^[1-9]\d*$/.test(req.params.sessionId) || !/^[1-9]\d*$/.test(req.params.assetId)
      || !Number.isSafeInteger(sessionId) || !Number.isSafeInteger(assetId)) {
      return res.status(401).json({ error: 'A valid widget session credential is required.' });
    }
    const resolved = token ? await resolveWidgetToken(token) : null;
    if (!resolved) return res.status(401).json({ error: 'A valid widget session credential is required.' });
    // The canonical widget pipeline uses the tenant's current business profile
    // and the web channel. Never accept profile/audience scope from query input.
    const profile = await getBusinessProfileContextByUserId(resolved.userId);
    const { withTenantSupportMediaTransaction } = await import('../services/supportMedia/SupportMediaTenantTransaction.js');
    const { publishedMediaAssetAccess } = await import('../services/supportMedia/SupportMediaAccess.js');
    const record = await withTenantSupportMediaTransaction(resolved.userId, async (tx) => tx.execute(sql`
      SELECT a.derivative_storage_file_id, a.mime_type, a.name
      FROM support_media_assets a
      JOIN support_media_galleries g ON g.id = a.gallery_id
      JOIN support_media_gallery_versions v ON v.id = a.gallery_version_id
      WHERE a.id = ${assetId}
        AND ${publishedMediaAssetAccess({ tenantId: resolved.userId, businessProfileId: profile?.id ?? null,
          audience: 'customer', purpose: 'support_answer', channel: 'web' })}
        AND EXISTS (
          SELECT 1 FROM support_chat_sessions session
          JOIN team_members member ON member.id = session.member_id
          JOIN support_teams team ON team.id = member.team_id AND team.user_id = member.user_id
          WHERE session.id = ${sessionId} AND session.public_token = ${sessionToken}
            AND (session.session_expires_at IS NULL OR session.session_expires_at > NOW())
            AND member.user_id = ${resolved.userId} AND member.team_id = ${resolved.teamId}
            AND member.is_active = TRUE AND team.is_active = TRUE AND team.widget_token = ${token}
            AND EXISTS (
              SELECT 1 FROM support_chat_messages message
              WHERE message.session_id = session.id AND message.role = 'assistant' AND message.processing_status='completed'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(message.metadata->'media') = 'array' THEN message.metadata->'media' ELSE '[]'::jsonb END
                ) item WHERE item->>'assetId' = ${String(assetId)})
            )
        )
      LIMIT 1
    `));
    const asset = record.rows[0] as Record<string, unknown> | undefined;
    if (!asset) return res.status(404).json({ error: 'The media is not available to this session.' });
    const { storageService } = await import('../services/StorageService.js');
    const file = await storageService.downloadFile(Number(asset.derivative_storage_file_id), resolved.userId);
    if (!file) return res.status(404).json({ error: 'The media bytes are unavailable.' });
    res.setHeader('Content-Type', String(asset.mime_type));
    res.setHeader('Content-Disposition', contentDisposition(`${String(asset.name || 'support-media')}.jpg`));
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(file.buffer);
  } catch (error) {
    logger.error({ err: error }, '[SupportWidget] getWidgetSessionMedia failed');
    return res.status(500).json({ error: 'Media could not be loaded.' });
  }
}

/**
 * GET /api/support-widget/config?token=XXX
 * Returns widget configuration (team name, branding) for rendering.
 */
export async function getWidgetConfig(req: Request, res: Response) {
  try {
    const token = req.query.token as string;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const resolved = await resolveWidgetToken(token);
    if (!resolved) return res.status(401).json({ error: 'Invalid widget token' });

    const companyProfile = await getBusinessProfileContextByUserId(resolved.userId);

    return res.json({
      success: true,
      data: {
        teamName: resolved.teamName,
        businessProfileName: companyProfile?.companyName || resolved.teamName,
        ...resolved.widgetSettings,
        displayName: resolved.widgetSettings.displayName || companyProfile?.companyName || resolved.teamName,
      },
    });
  } catch (error) {
    logger.error({ err: error }, '[SupportWidget] getConfig failed');
    return res.status(500).json({ error: 'Failed to load widget config' });
  }
}

/**
 * GET /api/support-widget/embed.js?token=XXX
 * Serves the embeddable JavaScript widget script.
 */
export async function getEmbedScript(req: Request, res: Response) {
  try {
    const token = req.query.token as string;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const resolved = await resolveWidgetToken(token);
    if (!resolved) return res.status(401).json({ error: 'Invalid widget token' });

    // Determine the base URL for the widget page
    // In production: API = api.asksales.ai, Client = asksales.ai
    const configuredClientUrl = process.env.CLIENT_URL
      || process.env.NEXT_PUBLIC_API_URL?.replace('api.', '')
      || 'https://asksales.ai';
    let clientBaseUrl: string;
    try {
      const parsedClientUrl = new URL(configuredClientUrl);
      if (!['http:', 'https:'].includes(parsedClientUrl.protocol)) {
        throw new Error('Unsupported client URL protocol');
      }
      clientBaseUrl = parsedClientUrl.origin;
    } catch {
      logger.error({ configuredClientUrl }, '[SupportWidget] CLIENT_URL is invalid');
      return res.status(503).json({ error: 'Support widget is not configured' });
    }

    const script = `
(function() {
  if (window.__supportWidgetLoaded) return;
  window.__supportWidgetLoaded = true;

  var token = ${JSON.stringify(token)};
  var loader = document.currentScript;
  if (loader && loader.src) {
    var endpoint = new URL('/api/support-widget/installed', loader.src);
    fetch(endpoint.toString(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, origin: window.location.origin }), credentials: 'omit', mode: 'cors' }).catch(function() {});
  }
  var position = ${JSON.stringify(resolved.widgetSettings.launcherPosition)};
  var widgetUrl = ${JSON.stringify(clientBaseUrl)} + '/support-widget/' + encodeURIComponent(token)
    + '?' + ${JSON.stringify(SUPPORT_WIDGET_HOST_PARAMETER)} + '=' + encodeURIComponent(window.location.origin);
  var widgetOrigin = new URL(widgetUrl).origin;

  // Styles
  var style = document.createElement('style');
  style.textContent = \`
    #support-widget-fab {
      position: fixed;
      bottom: 24px;
      ${resolved.widgetSettings.launcherPosition}: 24px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: ${resolved.widgetSettings.primaryColor};
      color: ${widgetColorForeground(resolved.widgetSettings.primaryColor)};
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(99,102,241,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999998;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #support-widget-fab:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 20px rgba(99,102,241,0.5);
    }
    #support-widget-fab svg {
      width: 28px;
      height: 28px;
    }
    #support-widget-container {
      position: fixed;
      bottom: 92px;
      ${resolved.widgetSettings.launcherPosition}: 24px;
      width: 400px;
      height: 600px;
      max-height: calc(100dvh - 120px);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      z-index: 999999;
      display: none;
      border: 1px solid #e5e7eb;
    }
    #support-widget-container.open {
      display: block;
    }
    #support-widget-container iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
    @media (max-width: 480px) {
      #support-widget-container {
        width: calc(100vw - 16px);
        height: calc(100dvh - 100px);
        ${resolved.widgetSettings.launcherPosition}: 8px;
        bottom: 80px;
        border-radius: 12px;
      }
    }
  \`;
  document.head.appendChild(style);

  // FAB
  var fab = document.createElement('button');
  fab.id = 'support-widget-fab';
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Open support chat');
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', 'support-widget-container');
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
  document.body.appendChild(fab);

  // Container with iframe
  var container = document.createElement('div');
  container.id = 'support-widget-container';
  var frame = document.createElement('iframe');
  frame.src = widgetUrl;
  frame.title = ${JSON.stringify((resolved.widgetSettings.displayName || resolved.teamName) + ' support chat')};
  frame.allow = 'clipboard-write';
  container.appendChild(frame);
  document.body.appendChild(container);

  var isOpen = false;
  fab.addEventListener('click', function() {
    isOpen = !isOpen;
    container.classList.toggle('open', isOpen);
    fab.setAttribute('aria-expanded', String(isOpen));
    fab.setAttribute('aria-label', isOpen ? 'Close support chat' : 'Open support chat');
    if (isOpen) frame.focus();
    fab.innerHTML = isOpen
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape' && isOpen) { fab.click(); fab.focus(); }
  });
  window.addEventListener('message', function(event) {
    if (!isOpen || event.origin !== widgetOrigin || event.source !== frame.contentWindow
      || !event.data || event.data.type !== ${JSON.stringify(SUPPORT_WIDGET_CLOSE_MESSAGE)}) return;
    fab.click();
    fab.focus();
  });
})();
`;

    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(script);
  } catch (error) {
    logger.error({ err: error }, '[SupportWidget] getEmbedScript failed');
    res.setHeader('Content-Type', 'application/javascript');
    return res.send('console.error("Support widget: failed to load");');
  }
}

/**
 * POST /api/support-widget/generate-token
 * Generates a widget token for the owner's first team (authenticated).
 */
export async function generateWidgetToken(req: Request, res: Response) {
  const userId = businessOwnerUserId(req); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const requestedTeamId = req.body?.teamId;
    if (
      requestedTeamId !== undefined
      && (!Number.isSafeInteger(Number(requestedTeamId)) || Number(requestedTeamId) <= 0)
    ) {
      return res.status(400).json({ error: 'Invalid team ID' });
    }
    const [team] = requestedTeamId !== undefined
      ? await db.select().from(supportTeamsTable).where(and(
          eq(supportTeamsTable.id, Number(requestedTeamId)),
          eq(supportTeamsTable.userId, userId),
          eq(supportTeamsTable.isActive, true),
        )).limit(1)
      : await db.select().from(supportTeamsTable).where(and(
          eq(supportTeamsTable.userId, userId),
          eq(supportTeamsTable.isActive, true),
        )).limit(1);
    if (!team) {
      return res.status(requestedTeamId !== undefined ? 404 : 400).json({
        error: requestedTeamId !== undefined ? 'Active support team not found' : 'No active support teams found',
      });
    }

    const [member] = await db.select({ id: teamMembersTable.id }).from(teamMembersTable)
      .where(and(eq(teamMembersTable.teamId, team.id), eq(teamMembersTable.userId, userId), eq(teamMembersTable.isActive, true)))
      .limit(1);
    if (!member) {
      return res.status(400).json({ error: 'Add an active member to this support team before generating a widget key.' });
    }

    const newToken = crypto.randomBytes(32).toString('hex');
    await db.update(supportTeamsTable)
      .set({ widgetToken: newToken, widgetInstallation: null, updatedAt: new Date() })
      .where(eq(supportTeamsTable.id, team.id));

    return res.json({ success: true, data: { token: newToken, teamId: team.id, teamName: team.name } });
  } catch (error) {
    logger.error({ err: error }, '[SupportWidget] generateToken failed');
    return res.status(500).json({ error: 'Failed to generate token' });
  }
}

/**
 * GET /api/support-widget/token
 * Gets the current widget token for the owner's teams (authenticated).
 */
export async function getWidgetToken(req: Request, res: Response) {
  const userId = businessOwnerUserId(req); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const teams = await db.select({
      id: supportTeamsTable.id,
      name: supportTeamsTable.name,
      widgetToken: supportTeamsTable.widgetToken,
      widgetSettings: supportTeamsTable.widgetSettings,
      widgetInstallation: supportTeamsTable.widgetInstallation,
    }).from(supportTeamsTable)
      .where(and(eq(supportTeamsTable.userId, userId), eq(supportTeamsTable.isActive, true)));

    return res.json({
      success: true,
      data: teams.map((t: Pick<typeof supportTeamsTable.$inferSelect, 'id' | 'name' | 'widgetToken' | 'widgetSettings' | 'widgetInstallation'>) => ({
        teamId: t.id,
        teamName: t.name,
        token: t.widgetToken,
        settings: normalizeWidgetSettings(t.widgetSettings),
        installation: t.widgetInstallation,
      })),
    });
  } catch (error) {
    logger.error({ err: error }, '[SupportWidget] getToken failed');
    return res.status(500).json({ error: 'Failed to get widget tokens' });
  }
}

/** Save appearance only for an active team owned by the scoped dashboard user. */
export async function updateWidgetSettings(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  const teamId = Number(req.params.teamId);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isSafeInteger(teamId) || teamId <= 0) return res.status(400).json({ error: 'Invalid team ID' });
  const validation = widgetSettingsError(req.body);
  if (validation) return res.status(400).json({ error: validation });
  const settings = normalizeWidgetSettings(req.body);
  settings.displayName = settings.displayName.trim();
  settings.greeting = settings.greeting.trim();
  try {
    const [team] = await db.update(supportTeamsTable).set({ widgetSettings: settings, updatedAt: new Date() })
      .where(and(eq(supportTeamsTable.id, teamId), eq(supportTeamsTable.userId, userId), eq(supportTeamsTable.isActive, true))).returning({ id: supportTeamsTable.id });
    if (!team) return res.status(404).json({ error: 'Active support team not found' });
    return res.json({ success: true, data: settings });
  } catch (error) { logger.error({ err: error }, '[SupportWidget] save settings failed'); return res.status(500).json({ error: 'Could not save widget settings' }); }
}

/** The loader calls this from the host website. Never fetch customer URLs server-side. */
export async function recordWidgetInstallation(req: Request, res: Response) {
  const origin = widgetRequestOrigin(req.get('origin'));
  if (!origin || req.body?.origin !== origin) return res.status(400).json({ error: 'A matching website origin is required' });
  try {
  const resolved = await resolveWidgetToken(String(req.body?.token || ''));
  if (!resolved) return res.status(401).json({ error: 'Invalid widget token' });
  const installation = { hostname: new URL(origin).hostname, origin, lastSeenAt: new Date().toISOString() };
  await db.update(supportTeamsTable).set({ widgetInstallation: installation })
    .where(eq(supportTeamsTable.id, resolved.teamId));
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ success: true });
  } catch (error) { logger.error({ err: error }, '[SupportWidget] installation signal failed'); return res.status(500).json({ error: 'Could not record installation signal' }); }
}

/** Token rotation/revocation also removes the installation signal for the old key. */
export async function revokeWidgetToken(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  const teamId = Number(req.params.teamId);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isSafeInteger(teamId) || teamId <= 0) return res.status(400).json({ error: 'Invalid team ID' });
  try {
  const [team] = await db.update(supportTeamsTable).set({ widgetToken: null, widgetInstallation: null, updatedAt: new Date() })
    .where(and(eq(supportTeamsTable.id, teamId), eq(supportTeamsTable.userId, userId), eq(supportTeamsTable.isActive, true))).returning({ id: supportTeamsTable.id });
  return team ? res.json({ success: true, data: { teamId } }) : res.status(404).json({ error: 'Active support team not found' });
  } catch (error) { logger.error({ err: error }, '[SupportWidget] revoke token failed'); return res.status(500).json({ error: 'Could not revoke the widget key' }); }
}

export async function submitWidgetFeedback(req: Request, res: Response) {
  const { token, sessionToken, rating, comment } = req.body || {};
  const sessionId = Number(req.params.sessionId);
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || typeof sessionToken !== 'string' || sessionToken.length > 512)
    return res.status(400).json({ error: 'A valid session credential is required' });
  if (!['helpful', 'not_helpful'].includes(rating) || (comment !== undefined && (typeof comment !== 'string' || comment.length > 1000)))
    return res.status(400).json({ error: 'Choose helpful or not helpful, with an optional comment of up to 1,000 characters' });
  const origin = widgetRequestOrigin(req.get('origin'));
  if (!origin) return res.status(403).json({ error: 'Invalid widget origin' });
  try {
    const resolved = await resolveWidgetToken(token);
    if (!resolved) return res.status(401).json({ error: 'Invalid widget token' });
    const [session] = await db.select({ publicToken: supportChatSessionsTable.publicToken, expiresAt: supportChatSessionsTable.sessionExpiresAt,
      metadata: supportChatSessionsTable.metadata }).from(supportChatSessionsTable)
      .innerJoin(teamMembersTable, eq(teamMembersTable.id, supportChatSessionsTable.memberId))
      .where(and(eq(supportChatSessionsTable.id, sessionId), eq(teamMembersTable.teamId, resolved.teamId), eq(teamMembersTable.isActive, true))).limit(1);
    if (!session || !session.publicToken || session.publicToken !== sessionToken) return res.status(403).json({ error: 'Session does not belong to this widget' });
    if (!session.expiresAt || session.expiresAt <= new Date()) return res.status(440).json({ code: 'SESSION_EXPIRED', error: 'This conversation has expired. Start a new chat.' });
    const metadata = session.metadata as Record<string, unknown> | null;
    const expectedOrigin = metadata?.widgetOrigin || (process.env.CLIENT_URL ? new URL(process.env.CLIENT_URL).origin : null);
    if (!expectedOrigin || expectedOrigin !== origin) return res.status(403).json({ error: 'Session origin does not match' });
    const customerFeedback = { rating, ...(comment?.trim() ? { comment: redactPiiWithStableTokens(comment.trim()).redactedText } : {}), ratedAt: new Date().toISOString() };
    const [saved] = await db.update(supportChatSessionsTable).set({ metadata: sql`COALESCE(${supportChatSessionsTable.metadata}, '{}'::jsonb) || ${JSON.stringify({ customerFeedback })}::jsonb`, updatedAt: new Date() })
      .where(and(eq(supportChatSessionsTable.id, sessionId), eq(supportChatSessionsTable.publicToken, sessionToken), sql`${supportChatSessionsTable.sessionExpiresAt} > NOW()`)).returning({ id: supportChatSessionsTable.id });
    if (!saved) return res.status(440).json({ code: 'SESSION_EXPIRED', error: 'This conversation has expired. Start a new chat.' });
    return res.json({ success: true, data: customerFeedback });
  } catch (error) { logger.error({ err: error }, '[SupportWidget] feedback failed'); return res.status(500).json({ error: 'Could not save feedback. Try again.' }); }
}

// H10 — Public confirm-email endpoint for widget-created leads
export async function confirmWidgetLeadEmail(req: Request, res: Response) {
  try {
    const token = String(req.query.token || '').trim();
    if (!token || token.length < 32) {
      return res.status(400).send('Invalid confirmation link');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [lead] = await db.select({ id: leadsTable.id, emailConfirmedAt: (leadsTable as any).emailConfirmedAt })
      .from(leadsTable)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .where(eq((leadsTable as any).confirmationToken, token));
    if (!lead) {
      return res.status(404).send('Confirmation link not found or already used');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(lead as any).emailConfirmedAt) {
      await db.update(leadsTable)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set({ emailConfirmedAt: new Date(), confirmationToken: null } as any)
        .where(eq(leadsTable.id, lead.id));
    }
    return res.status(200).send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Email confirmed</h2><p>Thanks! You can close this tab.</p></body></html>');
  } catch (error) {
    logger.error({ err: error }, '[SupportWidget] confirmWidgetLeadEmail failed');
    return res.status(500).send('Confirmation failed');
  }
}
