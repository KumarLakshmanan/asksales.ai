/**
 * Realtime Gateway Bridge
 * 
 * Connects the Event Bus (Redis Pub/Sub) to WebSocket clients.
 * Subscribes to user-scoped event channels and pushes to connected clients.
 *
 * Requires Redis — no fallback.
 */

import { WebSocket } from 'ws';
import { eventBus, type EventPayload } from '../events/EventBus.js';
import { webSocketEmitter } from '../services/agents/WebSocketEmitter.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

const socketIds = new WeakMap<WebSocket, string>();

/**
 * Subscribe a WebSocket client to events via the Event Bus
 * When events are published for this user, they are forwarded to the WebSocket
 */
export async function bridgeUserToEventBus(userId: number, ws: WebSocket, businessProfileId: number, authorize?: () => Promise<boolean>): Promise<void> {
  // Register with both systems (webSocketEmitter for thread tracking, eventBus for delivery)
  webSocketEmitter.registerClient(userId, ws);
  const socketId = randomUUID();
  socketIds.set(ws, socketId);

  // Subscribe to user-scoped events from Event Bus
  try {
    await eventBus.subscribeToUser(userId, async (event: EventPayload) => {
      try {
        if (!businessProfileId || event.businessProfileId !== businessProfileId) return;
        if (authorize && !await authorize()) { ws.close(1008, 'Business access removed'); return; }
        if (ws.readyState === WebSocket.OPEN) {
        // Thread filtering: if the event has a threadId AND the client has
        // subscribed to a specific thread, only relay if they match.
        const tracked = webSocketEmitter.getTrackedClient(userId, ws);
        const eventThreadId = event.threadId || (event.data?.thread_id as number | undefined);
        if (eventThreadId && tracked?.threadId && eventThreadId !== tracked.threadId) {
          return; // Skip — this client is viewing a different thread
        }

        const clientEventType = event.channel.startsWith('events:ws:')
          ? event.channel.slice('events:ws:'.length)
          : event.channel;
        const eventData = event.data || {};
        ws.send(JSON.stringify({
          schemaVersion: 1,
          eventId: event.messageId,
          kind: clientEventType,
          type: clientEventType,
          messageId: event.messageId,
          threadId: eventThreadId,
          runId: event.workflowId || event.executionId || eventData.run_id || eventData.execution_id,
          turnId: eventData.turn_id,
          actionId: eventData.action_id || eventData.toolCallId,
          sequence: eventData.sequence,
          data: {
            ...eventData,
            channel: event.channel,
            threadId: event.threadId,
            workflowId: event.workflowId,
            executionId: event.executionId,
            timestamp: event.timestamp,
          },
        }));
        }
      } catch (err) {
        logger.error({ userId, err }, '[RealtimeGateway] Failed to send event to WebSocket');
      }
    }, socketId);
  } catch (error) {
    webSocketEmitter.unregisterClient(userId, ws);
    socketIds.delete(ws);
    await eventBus.onWebSocketDisconnect(socketId).catch(() => 0);
    throw error;
  }

  logger.info({ userId }, '[RealtimeGateway] User bridged to Event Bus');
}

/**
 * Unsubscribe a user from Event Bus when WebSocket disconnects
 */
export async function unbridgeUserFromEventBus(userId: number, ws: WebSocket): Promise<void> {
  webSocketEmitter.unregisterClient(userId, ws);
  const socketId = socketIds.get(ws);
  if (socketId) {
    await eventBus.onWebSocketDisconnect(socketId);
    socketIds.delete(ws);
  }
  logger.info({ userId }, '[RealtimeGateway] User unbridged from Event Bus');
}

/**
 * Initialize the Realtime Gateway
 * Sets up Event Bus subscriptions for system-wide events
 */
export async function initializeRealtimeGateway(): Promise<void> {
  await eventBus.initialize();
  logger.info('[RealtimeGateway] Initialized with Event Bus');
}
