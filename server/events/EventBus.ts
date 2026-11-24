/**
 * Event Bus — Redis Pub/Sub based event distribution
 * 
 * Decouples event producers (Orchestrator, Tool Workers) from consumers
 * (Realtime Gateway, Analytics, Orchestrator graph resumption).
 * 
 * Replaces direct WebSocket emission with publish-subscribe pattern.
 */

import { getRedisConnection, getRedisSubscriber } from '../infrastructure/redis.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';
import { currentBusinessScope, withBusinessScope } from '../tenancy/businessContext.js';

// ─── Event Types ────────────────────────────────────────────────────────────────

export const EVENT_CHANNELS = {
  // Tool lifecycle events
  TOOL_STARTED: 'events:tool:started',
  TOOL_PROGRESS: 'events:tool:progress',
  TOOL_COMPLETED: 'events:tool:completed',
  TOOL_FAILED: 'events:tool:failed',

  // Agent lifecycle events
  AGENT_TRANSITION: 'events:agent:transition',
  AGENT_MESSAGE: 'events:agent:message',
  AGENT_THINKING: 'events:agent:thinking',

  // Workflow events
  WORKFLOW_STARTED: 'events:workflow:started',
  WORKFLOW_PROGRESS: 'events:workflow:progress',
  WORKFLOW_COMPLETED: 'events:workflow:completed',
  WORKFLOW_FAILED: 'events:workflow:failed',

  // Scraping events
  SCRAPING_STARTED: 'events:scraping:started',
  SCRAPING_PROGRESS: 'events:scraping:progress',
  SCRAPING_COMPLETED: 'events:scraping:completed',

  // Outreach events
  OUTREACH_SENT: 'events:outreach:sent',
  OUTREACH_REPLIED: 'events:outreach:replied',
  OUTREACH_BOUNCED: 'events:outreach:bounced',
  CRM_AUTOMATION_UPDATED: 'events:crm:automation:updated',

  // Content events
  CONTENT_GENERATED: 'events:content:generated',
  IMAGE_GENERATED: 'events:image:generated',
  VIDEO_GENERATED: 'events:video:generated',

  // Approval events
  APPROVAL_REQUIRED: 'events:approval:required',
  APPROVAL_GRANTED: 'events:approval:granted',
  APPROVAL_REJECTED: 'events:approval:rejected',

  // System events
  NOTIFICATION: 'events:notification',
  ERROR: 'events:error',
} as const;

export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS] | `events:ws:${string}`;

// ─── Event Payload ──────────────────────────────────────────────────────────────

export interface EventPayload {
  channel: EventChannel;
  messageId?: string;
  userId: number;
  businessProfileId?: number;
  threadId?: number;
  workflowId?: string;
  executionId?: string;
  correlationId?: string;
  timestamp: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}

// ─── Event Handler Type ─────────────────────────────────────────────────────────

export type EventHandler = (event: EventPayload) => void | Promise<void>;

// ─── Event Bus ──────────────────────────────────────────────────────────────────

// Phase 5.10 / PERF-008: per-event TTL — drop a handler if it hasn't been
// invoked within this window. Prevents zombie subscriptions from leaking
// memory when a client disconnects without unsubscribing.
const EVENT_DEFAULT_TTL_MS = 30_000;
// Sweep frequency for TTL reaper.
const TTL_REAPER_INTERVAL_MS = 60_000;

class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private subscribedChannels: Set<string> = new Set();
  /** Per-socket channel handlers for precise multi-tab cleanup. */
  private socketHandlers: Map<string, Map<string, EventHandler>> = new Map();
  /** Phase 5.10: per-handler lastInvocation for TTL reaping */
  private handlerLastSeen: Map<EventHandler, number> = new Map();
  /** Socket handlers have explicit disconnect cleanup and must survive idle periods. */
  private persistentHandlers: Set<EventHandler> = new Set();
  /** Phase 5.10: pattern subscriptions tracking (for psubscribe) */
  private subscribedPatterns: Set<string> = new Set();
  private ttlReaperTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  /**
   * Initialize the event bus — sets up Redis subscriber
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const subscriber = getRedisSubscriber();

    // Handle incoming messages from Redis Pub/Sub
    subscriber.on('message', (channel: string, message: string) => {
      try {
        const event: EventPayload = JSON.parse(message);
        const handlers = this.handlers.get(channel);
        if (handlers) {
          const now = Date.now();
          for (const handler of handlers) {
            this.handlerLastSeen.set(handler, now);
            try {
              Promise.resolve(event.businessProfileId
                ? withBusinessScope({ userId: event.userId, businessProfileId: event.businessProfileId }, () => handler(event))
                : handler(event)).catch((err) => {
                logger.error({ channel, err }, 'Async event handler error');
              });
            } catch (err) {
              logger.error({ channel, err }, 'Event handler error');
            }
          }
        }
      } catch (err) {
        logger.error({ channel, err }, 'Failed to parse event message');
      }
    });

    // Handle pattern messages (for user-scoped events)
    subscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
      try {
        const event: EventPayload = JSON.parse(message);
        const handlers = this.handlers.get(pattern);
        if (handlers) {
          const now = Date.now();
          for (const handler of handlers) {
            this.handlerLastSeen.set(handler, now);
            try {
              Promise.resolve(event.businessProfileId
                ? withBusinessScope({ userId: event.userId, businessProfileId: event.businessProfileId }, () => handler(event))
                : handler(event)).catch((err) => {
                logger.error({ pattern, channel, err }, 'Async pattern event handler error');
              });
            } catch (err) {
              logger.error({ pattern, channel, err }, 'Pattern event handler error');
            }
          }
        }
      } catch (err) {
        logger.error({ pattern, channel, err }, 'Failed to parse pattern event message');
      }
    });

    // Phase 5.10: start the TTL reaper.
    this.ttlReaperTimer = setInterval(() => this.reapStaleHandlers(), TTL_REAPER_INTERVAL_MS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (this.ttlReaperTimer && typeof (this.ttlReaperTimer as any).unref === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.ttlReaperTimer as any).unref();
    }

    this.initialized = true;
    logger.info('[EventBus] Initialized');
  }

  /**
   * Phase 5.10: reap handlers that haven't been invoked within the TTL.
   * This is a soft cleanup — we just drop the reference. Redis subscriptions
   * stay alive (they're cheap) until the channel is unsubscribed via
   * `unsubscribe()` or `onWebSocketDisconnect()`.
   */
  private reapStaleHandlers(): void {
    const cutoff = Date.now() - EVENT_DEFAULT_TTL_MS;
    let reaped = 0;
    for (const [handler, lastSeen] of this.handlerLastSeen.entries()) {
      if (this.persistentHandlers.has(handler)) continue;
      if (lastSeen < cutoff) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const [channel, set] of this.handlers.entries()) {
          if (set.has(handler)) set.delete(handler);
        }
        this.handlerLastSeen.delete(handler);
        reaped++;
      }
    }
    // Drop empty handler sets so we can also unsubscribe from Redis.
    for (const [channel, set] of this.handlers.entries()) {
      if (set.size === 0) this.handlers.delete(channel);
    }
    if (reaped > 0) logger.info({ reaped }, '[EventBus] Reaped stale handlers');
  }

  /**
   * Publish an event to a channel
   */
  async publish(event: EventPayload): Promise<void> {
    const publisher = getRedisConnection();
    const normalizedEvent = {
      ...event,
      businessProfileId: event.businessProfileId ?? (currentBusinessScope()?.userId === event.userId ? currentBusinessScope()?.businessProfileId : undefined),
      messageId: event.messageId || randomUUID(),
    };
    const message = JSON.stringify(normalizedEvent);

    // Publish to the specific channel
    await publisher.publish(event.channel, message);

    // Also publish to a user-scoped channel for WebSocket routing
    if (event.userId) {
      await publisher.publish(`events:user:${event.userId}`, message);
    }

    logger.debug(
      { channel: event.channel, userId: event.userId },
      'Event published'
    );
  }

  /**
   * Subscribe to a channel
   *
   * Phase 5.10: if `socketId` is provided the (socketId → channel) mapping
   * is recorded so `onWebSocketDisconnect(socketId)` can clean up in O(1).
   */
  async subscribe(
    channel: string,
    handler: EventHandler,
    socketId?: string,
    options?: { persistent?: boolean },
  ): Promise<void> {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
    }
    this.handlers.get(channel)!.add(handler);
    this.handlerLastSeen.set(handler, Date.now());

    if (socketId) {
      if (!this.socketHandlers.has(socketId)) this.socketHandlers.set(socketId, new Map());
      this.socketHandlers.get(socketId)!.set(channel, handler);
    }
    if (socketId || options?.persistent) this.persistentHandlers.add(handler);

    // Subscribe in Redis if not already
    if (!this.subscribedChannels.has(channel)) {
      const subscriber = getRedisSubscriber();
      await subscriber.subscribe(channel);
      this.subscribedChannels.add(channel);
      logger.debug({ channel, socketId }, 'Subscribed to channel');
    }
  }

  /**
   * Phase 5.10: remove ALL channels associated with a given socket id.
   * Called from the WebSocket layer on `socket.disconnect`. This avoids the
   * O(N×M) scan that the previous implementation required (loop over
   * every channel looking for this socket).
   */
  async onWebSocketDisconnect(socketId: string): Promise<number> {
    const channelHandlers = this.socketHandlers.get(socketId);
    if (!channelHandlers || channelHandlers.size === 0) return 0;
    let removed = 0;
    for (const [channel, handler] of channelHandlers) {
      const handlers = this.handlers.get(channel);
      if (handlers) {
        handlers.delete(handler);
        this.handlerLastSeen.delete(handler);
        this.persistentHandlers.delete(handler);
        removed++;
        if (handlers.size === 0) {
          this.handlers.delete(channel);
          if (this.subscribedChannels.has(channel)) {
            try {
              const subscriber = getRedisSubscriber();
              await subscriber.unsubscribe(channel);
            } catch (err) {
              logger.warn({ channel, err }, '[EventBus] unsubscribe on disconnect failed');
            }
            this.subscribedChannels.delete(channel);
          }
        }
      }
    }
    this.socketHandlers.delete(socketId);
    logger.info({ socketId, removed }, '[EventBus] Cleaned up disconnected socket');
    return removed;
  }

  /**
   * Subscribe to a user-scoped channel (for WebSocket routing)
   */
  async subscribeToUser(userId: number, handler: EventHandler, socketId?: string): Promise<void> {
    const channel = `events:user:${userId}`;
    await this.subscribe(channel, handler, socketId);
  }

  /**
   * Unsubscribe from a channel (removes all handlers and Redis subscription)
   */
  async unsubscribe(channel: string): Promise<void> {
    const handlers = this.handlers.get(channel);
    if (handlers) {
      for (const handler of handlers) {
        this.handlerLastSeen.delete(handler);
        this.persistentHandlers.delete(handler);
      }
    }
    this.handlers.delete(channel);

    if (this.subscribedChannels.has(channel)) {
      const subscriber = getRedisSubscriber();
      await subscriber.unsubscribe(channel);
      this.subscribedChannels.delete(channel);
      logger.debug({ channel }, 'Unsubscribed from channel');
    }
  }

  /**
   * Unsubscribe from a user-scoped channel
   */
  async unsubscribeFromUser(userId: number): Promise<void> {
    const channel = `events:user:${userId}`;
    await this.unsubscribe(channel);
  }

  /**
   * Subscribe to all events matching a pattern
   *
   * Phase 5.10: tracks pattern subscriptions so `close()` can `punsubscribe`
   * from each one (otherwise they leak Redis-side).
   */
  async subscribePattern(pattern: string, handler: EventHandler): Promise<void> {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
    }
    this.handlers.get(pattern)!.add(handler);
    this.handlerLastSeen.set(handler, Date.now());

    if (!this.subscribedPatterns.has(pattern)) {
      const subscriber = getRedisSubscriber();
      await subscriber.psubscribe(pattern);
      this.subscribedPatterns.add(pattern);
    }
    logger.debug({ pattern }, 'Subscribed to pattern');
  }

  /**
   * Helper: Publish tool lifecycle events
   */
  async emitToolEvent(
    type: 'started' | 'progress' | 'completed' | 'failed',
    payload: {
      userId: number;
      threadId?: number;
      toolName: string;
      executionId?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data?: Record<string, any>;
    }
  ): Promise<void> {
    const channelMap = {
      started: EVENT_CHANNELS.TOOL_STARTED,
      progress: EVENT_CHANNELS.TOOL_PROGRESS,
      completed: EVENT_CHANNELS.TOOL_COMPLETED,
      failed: EVENT_CHANNELS.TOOL_FAILED,
    };

    await this.publish({
      channel: channelMap[type],
      userId: payload.userId,
      threadId: payload.threadId,
      executionId: payload.executionId,
      timestamp: new Date().toISOString(),
      data: {
        toolName: payload.toolName,
        ...payload.data,
      },
    });
  }

  /**
   * Helper: Publish agent transition events
   */
  async emitAgentTransition(
    userId: number,
    threadId: number,
    fromAgent: string,
    toAgent: string,
    reason?: string
  ): Promise<void> {
    await this.publish({
      channel: EVENT_CHANNELS.AGENT_TRANSITION,
      userId,
      threadId,
      timestamp: new Date().toISOString(),
      data: { fromAgent, toAgent, reason },
    });
  }

  /**
   * Helper: Publish workflow progress events
   */
  async emitWorkflowProgress(
    userId: number,
    workflowId: string,
    progress: number,
    step: string,
    message?: string
  ): Promise<void> {
    await this.publish({
      channel: EVENT_CHANNELS.WORKFLOW_PROGRESS,
      userId,
      workflowId,
      timestamp: new Date().toISOString(),
      data: { progress, step, message },
    });
  }

  /**
   * Gracefully close the event bus
   */
  async close(): Promise<void> {
    const subscriber = getRedisSubscriber();
    for (const channel of this.subscribedChannels) {
      await subscriber.unsubscribe(channel);
    }
    for (const pattern of this.subscribedPatterns) {
      await subscriber.punsubscribe(pattern);
    }
    if (this.ttlReaperTimer) {
      clearInterval(this.ttlReaperTimer);
      this.ttlReaperTimer = null;
    }
    this.subscribedChannels.clear();
    this.subscribedPatterns.clear();
    this.socketHandlers.clear();
    this.persistentHandlers.clear();
    this.handlerLastSeen.clear();
    this.handlers.clear();
    this.initialized = false;
    logger.info('[EventBus] Closed');
  }
}

// Singleton
export const eventBus = new EventBus();
