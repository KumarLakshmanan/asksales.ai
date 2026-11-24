import { supportConversationContext } from './agents/orchestration/SupportConversationMemory.js';
import { conversationRequests, ConversationRequestError, validConversationRequestId } from './ConversationRequestCoordinator.js';
import { db } from '../models/db.js';
import { supportChatSessionsTable } from '../models/supportChatSessions/schema.js';
import { supportChatMessagesTable } from '../models/supportChatMessages/schema.js';
import { supportTeamsTable } from '../models/supportTeams/schema.js';
import { teamMembersTable } from '../models/teamMembers/schema.js';
import { supportTicketsTable } from '../models/supportTickets/schema.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { eq, desc, and, sql, ilike } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { redactPiiWithStableTokens } from './agents/orchestration/PrivacyVaultService.js';
import { INTERNAL_SUPPORT_ASSIST_SCOPE } from './agents/pipeline/InternalSupportAssistScope.js';
import { agentRouter } from './agents/AgentRouter.js';
import { requireSupportChatAssistant } from './SupportChatRouting.js';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SupportChatResponse {
  answer: string;
  confidence: number;
  sources: { sourceId: number; citation: string; title: string; sourceUrl?: string; excerpt: string; similarity: number }[];
  mode: 'advisory';
  deliveryAllowed: false;
  canonicalCustomerPipeline: 'ChannelGateway';
}

/**
 * Resolves the owner userId for a support member by tracing through team → user.
 */
async function getOwnerUserId(memberId: number): Promise<number | null> {
  const rows = await db
    .select({ userId: supportTeamsTable.userId })
    .from(teamMembersTable)
    .innerJoin(supportTeamsTable, eq(teamMembersTable.teamId, supportTeamsTable.id))
    .where(eq(teamMembersTable.id, memberId))
    .limit(1);
  return rows[0]?.userId ?? null;
}


/**
 * Creates a new chat session for a support member.
 */
export async function createSession(memberId: number, ticketId?: number, title?: string, clientSessionKey?: string) {
  if (clientSessionKey != null && !validConversationRequestId(clientSessionKey)) throw new ConversationRequestError('invalid_session_id', 'Invalid session identity.', 400);
  const scopedKey = clientSessionKey ? `member:${memberId}:${ticketId || 0}:${clientSessionKey}` : null;
  if (ticketId) {
    const [authorized] = await db.select({ id: supportTicketsTable.id })
      .from(supportTicketsTable)
      .innerJoin(teamMembersTable, eq(teamMembersTable.id, memberId))
      .where(and(
        eq(supportTicketsTable.id, ticketId),
        eq(supportTicketsTable.userId, teamMembersTable.userId),
        sql`(${supportTicketsTable.assignedMemberId} = ${memberId} OR ${supportTicketsTable.teamId} = ${teamMembersTable.teamId})`,
      ))
      .limit(1);
    if (!authorized) throw new Error('Ticket is outside this support member’s authorized scope.');
  }
  const [session] = await db.insert(supportChatSessionsTable).values({
    memberId, clientSessionKey: scopedKey,
    ticketId: ticketId ?? null,
    title: redactPiiWithStableTokens(title || 'New Chat').redactedText,
  }).onConflictDoNothing().returning();
  if (session) return session;
  const existing = scopedKey ? (await db.select().from(supportChatSessionsTable).where(and(eq(supportChatSessionsTable.memberId, memberId), eq(supportChatSessionsTable.clientSessionKey, scopedKey))).limit(1))[0] : undefined;
  if (!existing) throw new Error('Unable to create chat session.');
  return existing;
}

/**
 * Lists chat sessions for a member, optionally filtered by ticketId.
 */
export async function listSessions(memberId: number, ticketId?: number, page = 1, limit = 20, search = '', archived = false) {
  const offset = (page - 1) * limit;
  const conditions = [eq(supportChatSessionsTable.memberId, memberId)];
  if (ticketId) conditions.push(eq(supportChatSessionsTable.ticketId, ticketId));
  conditions.push(sql`COALESCE(${supportChatSessionsTable.metadata}->>'archived', 'false') = ${String(archived)}`);
  if (search.trim()) conditions.push(ilike(supportChatSessionsTable.title, `%${search.trim().slice(0, 200)}%`));

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const [sessions, countResult] = await Promise.all([
    db.select().from(supportChatSessionsTable)
      .where(where!)
      .orderBy(desc(supportChatSessionsTable.updatedAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(supportChatSessionsTable).where(where!),
  ]);

  return { sessions, total: countResult[0]?.count ?? 0 };
}

export async function archiveSession(sessionId: number, memberId: number, archived: boolean) {
  const [updated] = await db.update(supportChatSessionsTable).set({
    metadata: sql`COALESCE(${supportChatSessionsTable.metadata}, '{}'::jsonb) || ${JSON.stringify({ archived })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(eq(supportChatSessionsTable.id, sessionId), eq(supportChatSessionsTable.memberId, memberId))).returning();
  return updated ?? null;
}

/**
 * Gets a single session with its messages.
 */
export async function getSession(sessionId: number, memberId: number) {
  const [session] = await db.select().from(supportChatSessionsTable)
    .where(and(eq(supportChatSessionsTable.id, sessionId), eq(supportChatSessionsTable.memberId, memberId)));
  if (!session) return null;

  const messages = await db.select().from(supportChatMessagesTable)
    .where(eq(supportChatMessagesTable.sessionId, sessionId))
    .orderBy(supportChatMessagesTable.createdAt);

  return { ...session, messages };
}

/**
 * Deletes a chat session and all its messages.
 */
export async function deleteSession(sessionId: number, memberId: number) {
  const [session] = await db.select({ id: supportChatSessionsTable.id })
    .from(supportChatSessionsTable)
    .where(and(eq(supportChatSessionsTable.id, sessionId), eq(supportChatSessionsTable.memberId, memberId)));
  if (!session) return false;

  await db.delete(supportChatSessionsTable).where(eq(supportChatSessionsTable.id, sessionId));
  return true;
}

/**
 * Renames a chat session.
 */
export async function renameSession(sessionId: number, memberId: number, title: string) {
  const [updated] = await db.update(supportChatSessionsTable)
    .set({ title: redactPiiWithStableTokens(title).redactedText.slice(0, 255), updatedAt: new Date() })
    .where(and(eq(supportChatSessionsTable.id, sessionId), eq(supportChatSessionsTable.memberId, memberId)))
    .returning();
  return updated ?? null;
}

/**
 * Builds conversation history from stored messages for LLM context.
 */
async function buildConversationContext(sessionId: number, maxMessages = 80): Promise<ChatMessage[]> {
  const messages = await db.select({
    id: supportChatMessagesTable.id,
    role: supportChatMessagesTable.role,
    content: supportChatMessagesTable.content,
  }).from(supportChatMessagesTable)
    .where(eq(supportChatMessagesTable.sessionId, sessionId))
    .orderBy(desc(supportChatMessagesTable.createdAt))
    .limit(maxMessages);

  const chronological = messages.reverse();
  const { messages: history, memory } = supportConversationContext(chronological.slice(0, -1));
  await db.update(supportChatSessionsTable).set({ summary: JSON.stringify(memory) }).where(eq(supportChatSessionsTable.id, sessionId));
  const latest = chronological[chronological.length - 1];
  return latest ? [...history, { role: latest.role as ChatMessage['role'], content: latest.content }] : history;
}

/**
 * Sends a message in a chat session and returns the AI response.
 * Uses knowledge base RAG for context.
 */
export async function sendMessage(
  sessionId: number,
  memberId: number,
  userMessage: string,
  // Client ticket context is intentionally ignored; verified context is loaded
  // from the authorized session ticket below.
  _ticketContext?: { ticketNumber: string; subject: string; description: string; status: string; priority: string },
  requestId?: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ userMsg: any; assistantMsg: any; response: SupportChatResponse }> {
  // Verify session belongs to member
  const [session] = await db.select().from(supportChatSessionsTable)
    .where(and(eq(supportChatSessionsTable.id, sessionId), eq(supportChatSessionsTable.memberId, memberId)));
  if (!session) throw new Error('Session not found');

  const ownerUserId = await getOwnerUserId(memberId);
  if (!ownerUserId) throw new Error('Unable to resolve knowledge base owner');
  await requireSupportChatAssistant({
    userId: ownerUserId, conversationId: -1_000_000_000 - sessionId, channel: 'web',
    senderIdentifier: `support-member:${memberId}`, inboundText: '',
    metadata: { executionMode: 'advisory', conversationKind: 'support_member', staffSupportSessionId: sessionId },
  });
  const generate = async () => {
  const privacyScope = { userId: ownerUserId, conversationId: -1_000_000_000 - sessionId };
  const protectedUserMessage = redactPiiWithStableTokens(userMessage, privacyScope).redactedText;

  // Internal assistance does not need raw customer PII. Persist and model only
  // the protected representation so this surface cannot bypass the support vault.
  const [userMsg] = await db.insert(supportChatMessagesTable).values({
    sessionId,
    role: 'user',
    requestId: requestId ? `${requestId}:user` : undefined,
    content: protectedUserMessage,
    metadata: { piiProtected: protectedUserMessage !== userMessage },
  }).returning();

  // Resolve owner userId for the account-level active agent.
  const conversationHistory = await buildConversationContext(sessionId, 80);

  const [verifiedTicketContext] = session.ticketId
    ? await db.select({
        ticketNumber: supportTicketsTable.ticketNumber,
        subject: supportTicketsTable.subject,
        description: supportTicketsTable.description,
        status: supportTicketsTable.status,
        priority: supportTicketsTable.priority,
      }).from(supportTicketsTable)
        .innerJoin(teamMembersTable, eq(teamMembersTable.id, memberId))
        .where(and(
          eq(supportTicketsTable.id, session.ticketId),
          eq(supportTicketsTable.userId, ownerUserId),
          sql`(${supportTicketsTable.assignedMemberId} = ${memberId} OR ${supportTicketsTable.teamId} = ${teamMembersTable.teamId})`,
        ))
        .limit(1)
    : [];
  const protectedTicketContext = verifiedTicketContext ? {
      ticketNumber: redactPiiWithStableTokens(verifiedTicketContext.ticketNumber || '').redactedText,
      subject: redactPiiWithStableTokens(verifiedTicketContext.subject || '').redactedText,
      description: redactPiiWithStableTokens(verifiedTicketContext.description || '').redactedText,
      status: redactPiiWithStableTokens(verifiedTicketContext.status || '').redactedText,
      priority: redactPiiWithStableTokens(verifiedTicketContext.priority || '').redactedText,
    } : null;
  let answer = "I'm having trouble generating a response right now. Please try again.";
  let confidence = 0;
  let sources: SupportChatResponse['sources'] = [];
  let provenance: Record<string, unknown> = {};
  try {
    const generated = await agentRouter.handle({
      userId: ownerUserId,
      conversationId: -1_000_000_000 - sessionId,
      channel: 'web',
      inboundText: protectedUserMessage,
      recipientPhone: `support-member:${memberId}`,
      rawMessageId: `support-member:${userMsg.id}`,
      metadata: {
        executionMode: 'advisory',
        conversationKind: 'support_member',
        staffSupportSessionId:sessionId,
        conversationHistory: conversationHistory.slice(0, -1),
        ticketContext: protectedTicketContext,
        platformInstructions: 'This is an internal advisory surface for an authenticated human support member, not a customer conversation. Answer the member\'s question using authorized evidence. Do not ask the member for their name or contact information, qualify them as a lead, or start a booking or customer intake flow. Produce a customer-facing draft only when the member requests one and label it as a draft. Use Markdown paragraphs, never the customer-channel ||| message separator. Do not claim that you delivered a message or performed an external action.',
      },
    });
    provenance = generated?.provenance || {};
    if (generated?.answerVerification?.mayDeliver === false) {
      // Advisory mode permits displaying guidance without customer delivery,
      // but it must not turn an evidence-rejected draft into trusted staff advice.
      answer = 'I do not have enough approved information to verify that. Please check an authorized source before advising the customer.';
    } else if (generated?.replyText && generated.deliveryOutcome === 'auto_sent') {
      // Advisory answers render as one Markdown message, unlike customer-channel
      // deliveries whose separate bubbles are processed by DeliveryStage.
      answer = generated.replyText.split(/\s*\|\|\|\s*/).filter(Boolean).join('\n\n');
      confidence = generated.confidence ?? 0;
      sources = (generated.kbSourcesUsed || []).map((source) => ({
        sourceId: source.sourceId, citation: source.citation, title: source.title,
        sourceUrl: source.sourceUrl,
        excerpt: source.excerpt, similarity: source.similarity,
      }));
    } else if (generated?.deliveryOutcome === 'human_handoff' || generated?.deliveryOutcome === 'pending_approval') {
      answer = 'This draft requires human review before it can be used.';
    }
  } catch (error) {
    if (error instanceof ConversationRequestError) throw error;
    logger.error({ err: error }, '[SupportChatService] Configured advisory generation failed');
  }

  // Save assistant message
  const [assistantMsg] = await db.insert(supportChatMessagesTable).values({
    sessionId,
    role: 'assistant',
    requestId: requestId ? `${requestId}:assistant` : undefined,
    content: answer,
    metadata: { provenance },
    sources: sources,
    confidence,
  }).returning();

  // Update session title if this is the first user message
  const msgCount = await db.select({ count: sql<number>`count(*)::int` })
    .from(supportChatMessagesTable)
    .where(eq(supportChatMessagesTable.sessionId, sessionId));
  if ((msgCount[0]?.count ?? 0) <= 2) {
    const autoTitle = protectedUserMessage.length > 60 ? protectedUserMessage.substring(0, 57) + '...' : protectedUserMessage;
    await db.update(supportChatSessionsTable)
      .set({ title: autoTitle, updatedAt: new Date() })
      .where(eq(supportChatSessionsTable.id, sessionId));
  } else {
    await db.update(supportChatSessionsTable)
      .set({ updatedAt: new Date() })
      .where(eq(supportChatSessionsTable.id, sessionId));
  }

  return {
    userMsg,
    assistantMsg,
    response: {
      answer,
      confidence,
      sources,
      ...INTERNAL_SUPPORT_ASSIST_SCOPE,
    },
  };
  };
  return requestId ? conversationRequests.run({ userId: ownerUserId, kind: 'support_advisory', conversationId: sessionId,
    requestId, input: { userMessage, memberId } }, generate) : generate();

}
