import { isBusinessApproved } from '../tenancy/businessLifecycle.js';
import { isPostgresIntegerId } from '../utils/postgresIntegerId.js';
import { ConversationRequestError } from '../services/ConversationRequestCoordinator.js';
/**
 * Chat WebSocket Server
 * Extracted from routes.ts — dedicated WebSocket server for real-time agent communication.
 * Replaces the mock Express req/res anti-pattern with direct function calls.
 */

import type { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { verifyToken } from '../utils/jwt.js';
import { webSocketEmitter } from '../services/agents/WebSocketEmitter.js';
import { processMessageDirect } from '../mastra/chatController.js';
import { WS_HEARTBEAT_INTERVAL_MS } from '../utils/timingConstants';
import { AUTH_COOKIES, readAuthCookie } from '../utils/authCookies.js';
import { bridgeUserToEventBus, unbridgeUserFromEventBus } from '../gateway/RealtimeGateway.js';
import { getUserById } from '../models/users/functions.js';
import { getEffectiveModuleAccess } from '../models/platformAccess/functions.js';
import { getChatThreadById } from '../models/chatThreads/functions.js';
import { isTokenRevoked } from '../utils/jwt.js';
import { eventBus, type EventPayload } from '../events/EventBus.js';
import { randomUUID } from 'crypto';
import { db } from '../models/db.js';
import { teamMembersTable } from '../models/teamMembers/schema.js';
import { and, eq } from 'drizzle-orm';
import { resolveBusinessScope } from '../tenancy/businessScopeResolver.js';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import { supportTeamsTable } from '../models/supportTeams/schema.js';

const WS_PATH = '/api/agents/progress';
const HEARTBEAT_INTERVAL = WS_HEARTBEAT_INTERVAL_MS;

interface AuthenticatedSocket extends WebSocket {
  userId?: number;
  isAlive?: boolean;
  chatInFlight?: boolean;
  recentChatMessages?: number[];
  supportMemberId?: number;
}

interface SocketAuthPayload {
  userId?: number;
  adminId?: number;
  supportMemberId?: number;
  iat?: number;
  jti?: string;
}

let activeWebSocketServer: WebSocketServer | null = null;

function isAllowedOrigin(origin: string | undefined): boolean {
  const normalizeOrigin = (value: string): string | null => {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };
  const normalizedOrigin = origin ? normalizeOrigin(origin) : null;
  const configured = [
    process.env.CLIENT_URL,
    process.env.FRONTEND_URL,
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeOrigin)
    .filter((value): value is string => Boolean(value));
  if (normalizedOrigin && configured.includes(normalizedOrigin)) return true;
  if (normalizedOrigin === 'https://asksales.ai') return true;
  if (process.env.NODE_ENV !== 'production' && normalizedOrigin) {
    try {
      const parsed = new URL(normalizedOrigin);
      return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Attach the Chat WebSocket server to an existing HTTP server.
 * Returns the WebSocketServer instance for testing or shutdown.
 */
export function setupChatWebSocket(httpServer: HTTPServer): WebSocketServer {
  if (activeWebSocketServer) {
    throw new Error('Chat WebSocket server is already initialized');
  }
  const wss = new WebSocketServer({
    server: httpServer,
    path: WS_PATH,
    perMessageDeflate: false,
    maxPayload: 1 * 1024 * 1024, // 1 MB per message limit
    verifyClient: (info, callback) => {
      try {
        const origin = info.origin || info.req.headers.origin;
        if (!isAllowedOrigin(origin)) {
          logger.warn({ origin }, '[WS] Rejected connection from untrusted origin');
          return callback(false, 403, 'Origin not allowed');
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const supportAudience = new URL(info.req.url || WS_PATH, 'http://localhost').searchParams.get('audience') === 'support';
        const token = supportAudience
          ? readAuthCookie(info.req as any, AUTH_COOKIES.support)
          : readAuthCookie(info.req as any, AUTH_COOKIES.user) || readAuthCookie(info.req as any, AUTH_COOKIES.support);

        // WebSocket upgrades carry the same HttpOnly session cookie as HTTP requests.
        if (token) {
          try {
            const payload = verifyToken(token);
            if (!payload?.userId && !payload?.supportMemberId) {
              logger.warn('[WS] Invalid token — missing authenticated principal');
              return callback(false, 401, 'Invalid token');
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (info.req as any).authPayload = payload as SocketAuthPayload;
            logger.debug({ userId: payload.userId }, '[WS] Token verified');
            return callback(true);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (err: any) {
            logger.warn({ err: err.message }, '[WS] Session verification failed');
          }
        }

        logger.warn('[WS] No valid authentication provided');
        callback(false, 401, 'Authentication required');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        logger.error({ err }, '[WS] Connection verification error');
        callback(false, 401, 'Authentication failed');
      }
    },
  });
  activeWebSocketServer = wss;

  // ── Heartbeat (ping / pong) ──────────────────────────────────────────────
  const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((raw) => {
      const ws = raw as AuthenticatedSocket;
      if (ws.isAlive === false) {
        logger.debug({ userId: ws.userId }, '[WS] Terminating stale connection');
        if (ws.userId && !ws.supportMemberId) webSocketEmitter.unregisterClient(ws.userId, ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => {
    clearInterval(heartbeatTimer);
    if (activeWebSocketServer === wss) activeWebSocketServer = null;
  });

  // ── Connection handler ───────────────────────────────────────────────────
  wss.on('connection', async (raw: WebSocket, req) => {
    const ws = raw as AuthenticatedSocket;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authPayload = (req as any).authPayload as SocketAuthPayload | undefined;
    if (authPayload?.supportMemberId && !authPayload.userId && !authPayload.adminId) {
      const memberId = Number(authPayload.supportMemberId);
      try {
        if (authPayload.jti && await isTokenRevoked(authPayload.jti)) {
          ws.close(1008, 'Session revoked');
          return;
        }
        const [member] = await withSystemScope('Authenticate support notification socket', () => db.select().from(teamMembersTable).where(and(
          eq(teamMembersTable.id, memberId), eq(teamMembersTable.isActive, true),
        )).limit(1));
        if (!member?.businessProfileId || (member.passwordChangedAt && authPayload.iat && authPayload.iat * 1000 < member.passwordChangedAt.getTime())) {
          ws.close(1008, 'Account unavailable');
          return;
        }
        const [team] = await withBusinessScope({ userId:member.userId, businessProfileId:member.businessProfileId }, () => db.select({ id:supportTeamsTable.id }).from(supportTeamsTable)
          .where(and(eq(supportTeamsTable.id,member.teamId),eq(supportTeamsTable.isActive,true))).limit(1));
        if (!team) { ws.close(1008,'Support team unavailable'); return; }
        ws.userId = member.userId;
        ws.supportMemberId = memberId;
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        const socketId = `support-${memberId}-${randomUUID()}`;
        await eventBus.subscribeToUser(member.userId, (event: EventPayload) => {
          if (event.businessProfileId !== member.businessProfileId) return;
          const notification = event.data?.supportNotification as { memberIds?: number[] } | undefined;
          if (!notification?.memberIds?.includes(memberId) || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ schemaVersion: 1, type: 'support_notification', kind: 'support_notification',
            eventId: event.messageId, data: { ...notification, timestamp: event.timestamp } }));
        }, socketId);
        ws.send(JSON.stringify({ type: 'connected', data: { message: 'Connected to support notification stream', memberId } }));
        ws.on('message', () => ws.send(JSON.stringify({ type: 'error', data: { code: 'READ_ONLY_STREAM', message: 'This realtime stream is read-only.' } })));
        ws.on('close', () => { void eventBus.onWebSocketDisconnect(socketId); });
        ws.on('error', (error) => logger.warn({ err: error, memberId }, '[WS] Support notification socket error'));
      } catch (error) {
        logger.error({ err: error, memberId }, '[WS] Support member realtime authorization failed');
        ws.close(1011, 'Authorization unavailable');
      }
      return;
    }
    if (!authPayload?.userId || authPayload.adminId || authPayload.supportMemberId) {
      logger.warn('[WS] No userId in auth payload — closing');
      ws.close(1008, 'Unauthorized');
      return;
    }
    const userId = authPayload.userId;

    try {
      if (authPayload.jti && await isTokenRevoked(authPayload.jti)) {
        ws.close(1008, 'Session revoked');
        return;
      }
      const user = await getUserById(userId);
      if (
        !user ||
        user.deletedAt ||
        (user.passwordChangedAt && authPayload.iat && authPayload.iat * 1000 < user.passwordChangedAt.getTime())
      ) {
        ws.close(1008, 'Account unavailable');
        return;
      }
    } catch (error) {
      logger.error({ err: error, userId }, '[WS] Account/module authorization check failed');
      ws.close(1011, 'Authorization unavailable');
      return;
    }

    const requestedBusiness = new URL(req.url || WS_PATH, 'http://localhost').searchParams.get('businessProfileId');
    if (requestedBusiness !== null && (!/^[1-9]\d*$/.test(requestedBusiness) || !Number.isSafeInteger(Number(requestedBusiness)))) {
      ws.close(1008, 'Invalid business profile');
      return;
    }
    const businessScope = await resolveBusinessScope(userId, requestedBusiness === null ? undefined : Number(requestedBusiness));
    if (!businessScope) { ws.close(1008, 'Business profile unavailable'); return; }

    const authorizeBusiness = async () => {
      const current = await resolveBusinessScope(userId,businessScope.businessProfileId);
      return Boolean(current && current.userId === businessScope.userId && await isBusinessApproved(current.userId));
    };
    try {
      if (!await authorizeBusiness()) { ws.close(1008, 'Business approval required'); return; }
      const campaignAccess = (await getEffectiveModuleAccess(businessScope.userId)).find(module => module.key === 'campaigns');
      if (!campaignAccess?.enabled) { ws.close(1008,'Campaign conversations unavailable'); return; }
    } catch { ws.close(1011,'Authorization unavailable'); return; }
    ws.userId = userId;
    ws.isAlive = true;
    ws.chatInFlight = false;
    ws.recentChatMessages = [];

    // Heartbeat pong handler
    ws.on('pong', () => { ws.isAlive = true; });

    // Bridge Redis user events into this authenticated socket. This also
    // registers it with WebSocketEmitter for direct chat progress events.
    try {
      await withBusinessScope(businessScope, () => bridgeUserToEventBus(businessScope.userId, ws, businessScope.businessProfileId, authorizeBusiness));
    } catch (error) {
      logger.error({ err: error, userId }, '[WS] Unable to initialize realtime event bridge');
      ws.close(1011, 'Realtime service unavailable');
      return;
    }

    // Welcome handshake
    ws.send(JSON.stringify({
      type: 'connected',
      data: { message: 'Connected to agent progress stream', userId },
    }));

    // ── Message handler ──────────────────────────────────────────────────
    ws.on('message', (data: Buffer | string) => withBusinessScope(businessScope, async () => {
      try {
        if (!await authorizeBusiness()) { ws.close(1008,'Business access removed'); return; }
        const message = JSON.parse(data.toString());
        logger.debug({ userId, type: message.type }, '[WS] Message received');

        if (message.type === 'subscribe_thread') {
          // Client is telling us which thread it's currently viewing
          const threadId = message.data?.threadId ? Number(message.data.threadId) : undefined;
          if (threadId !== undefined && !isPostgresIntegerId(threadId)) {
            ws.send(JSON.stringify({
              type: 'error',
              data: { message: 'Invalid thread subscription', code: 'INVALID_THREAD' },
            }));
            return;
          }
          if (threadId !== undefined) {
            const thread = await getChatThreadById(threadId);
            if (!thread || thread.userId !== businessScope.userId) {
              ws.send(JSON.stringify({
                type: 'error',
                data: { message: 'Thread not found', code: 'THREAD_NOT_FOUND' },
              }));
              return;
            }
          }
          webSocketEmitter.updateClientThread(businessScope.userId, ws, threadId);
          logger.debug({ userId, threadId }, '[WS] Client subscribed to thread');
          return;
        }

        if (message.type === 'unsubscribe_thread') {
          // Client is leaving a thread (e.g. navigating away from chat)
          webSocketEmitter.updateClientThread(businessScope.userId, ws, undefined);
          logger.debug({ userId }, '[WS] Client unsubscribed from thread');
          return;
        }

        if (message.type === 'send_chat_message') {
          const { content, threadId, businessProfileId, attachments, displayContent } = message.data || {};
          if (businessProfileId && Number(businessProfileId) !== businessScope.businessProfileId) {
            ws.send(JSON.stringify({ type: 'error', data: { code: 'BUSINESS_PROFILE_MISMATCH', message: 'This message belongs to a different business.', ackMessageId: message.messageId, terminal: true } }));
            return;
          }
          if (typeof content !== 'string' || !content.trim()) {
            ws.send(JSON.stringify({
              type: 'error',
              data: {
                success: false,
                error: 'Message content is required',
                code: 'INVALID_CONTENT',
                ackMessageId: message.messageId,
                terminal: true,
              },
            }));
            return;
          }
          const now = Date.now();
          ws.recentChatMessages = (ws.recentChatMessages || []).filter(
            (timestamp) => now - timestamp < 60_000,
          );
          if (ws.recentChatMessages.length >= 20) {
            ws.send(JSON.stringify({
              type: 'error',
              data: {
                success: false,
                error: 'Too many chat messages. Please wait before sending another.',
                code: 'RATE_LIMITED',
              },
            }));
            return;
          }
          ws.recentChatMessages.push(now);
          ws.chatInFlight = true;
          const rawIdemKey = (message.messageId || message.data?.messageId) as string | undefined;
          if (rawIdemKey && !/^[A-Za-z0-9:_-]{1,200}$/.test(rawIdemKey)) {
            ws.chatInFlight = false;
            ws.send(JSON.stringify({
              type: 'error',
              data: { message: 'Invalid message ID', code: 'INVALID_MESSAGE_ID' },
            }));
            return;
          }

          // Replays use the same owned-thread and durable input checks as HTTP.
          // A legacy Redis response cannot authorize a changed request payload.
          try {
            // Direct call — no mock Express objects
            const result = await processMessageDirect(
              businessScope.userId,
              content,
              threadId,
              businessProfileId,
              attachments,
              (resolvedThreadId) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'thread_resolved',
                    data: {
                      threadId: resolvedThreadId,
                      requestMessageId: rawIdemKey,
                    },
                  }));
                }
              },
              undefined,
              rawIdemKey || randomUUID(),
              typeof displayContent === 'string' ? displayContent : undefined,
            );

            if (!await authorizeBusiness()) { ws.close(1008,'Business access removed'); return; }
            if (result.error) {
              ws.send(JSON.stringify({
                type: 'error',
                data: {
                  success: false,
                  error: result.error,
                  message: result.error,
                  code: result.code || 500,
                  threadId: result.threadId || undefined,
                  ackMessageId: rawIdemKey,
                  terminal: true,
                },
              }));
            } else {
              ws.send(JSON.stringify({
                type: 'message_sent',
                data: {
                  success: true,
                  ackMessageId: rawIdemKey,
                  threadId: result.threadId,
                  message: result.message,
                  response: result.response,
                  fitScore: result.fitScore,
                  currentAgent: result.currentAgent,
                  requiresApproval: result.requiresApproval,
                  actionButtons: result.actionButtons,
                },
              }));
            }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (err: any) {
            logger.error({ err, userId }, '[WS] processMessageDirect threw');
            ws.send(JSON.stringify({
              type: 'error',
              data: { success: false, error: err.message || 'Failed to process message', code: err instanceof ConversationRequestError ? err.code : 500, ackMessageId: rawIdemKey, terminal: true },
            }));
          } finally {
            ws.chatInFlight = false;
          }
          return;
        }

        ws.send(JSON.stringify({
          type: 'error',
          data: { message: 'Unsupported realtime command', code: 'UNSUPPORTED_COMMAND' },
        }));
      } catch (err) {
        logger.error({ err, userId }, '[WS] Failed to parse incoming message');
        ws.send(JSON.stringify({
          type: 'error',
          data: { message: 'Failed to process message' },
        }));
      }
    }));

    // ── Disconnect / error ───────────────────────────────────────────────
    ws.on('close', () => {
      logger.debug({ userId }, '[WS] Client disconnected');
      void unbridgeUserFromEventBus(businessScope.userId, ws).catch((error) => {
        logger.warn({ err: error, userId }, '[WS] Realtime disconnect cleanup failed');
      });
    });

    ws.on('error', (err) => {
      logger.error({ err, userId }, '[WS] Socket error');
    });
  });

  // ── Server-level error handler ─────────────────────────────────────────
  wss.on('error', (err) => {
    logger.error({ err }, '[WS] WebSocket server error');
  });

  logger.info({ path: WS_PATH }, '[WS] WebSocket server initialized');
  return wss;
}

export async function shutdownChatWebSocket(): Promise<void> {
  const wss = activeWebSocketServer;
  if (!wss) return;

  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }

  await new Promise<void>((resolve) => {
    const forceTimer = setTimeout(() => {
      for (const client of wss.clients) client.terminate();
    }, 5_000);
    forceTimer.unref?.();
    wss.close(() => {
      clearTimeout(forceTimer);
      resolve();
    });
  });
}
