/**
 * Global WebSocket Service
 * Manages a single WebSocket connection for all app components
 */

import { selectedBusinessProfileId } from '@/lib/business-profile';

type WebSocketEventHandler = (event: Record<string, unknown>) => void;

interface QueuedMessage {
  id: string;
  data: Record<string, unknown>;
  timestamp: number;
  retries: number;
  lastAttemptAt?: number;
}

class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string = "";
  private handlers: Map<string, Set<WebSocketEventHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 3000;
  private messageQueue: QueuedMessage[] = [];
  private isConnecting = false;
  private disconnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionGeneration = 0;
  private receivedMessageIds = new Set<string>();
  private maxReceivedMessagesCache = 1000;
  private userId: number | null = null;
  private businessProfileId: number | null = null;
  private desiredThreadId: number | undefined;
  private threadSubscriptionScheduled = false;
  // M6: track consecutive parse errors; force reconnect after 10.
  private consecutiveParseErrors = 0;
  private maxConsecutiveParseErrors = 10;

  private normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const maybeEvent = error as Event;
      if (maybeEvent.type) {
        return `WebSocket ${maybeEvent.type} event`;
      }
      try {
        return JSON.stringify(error);
      } catch {
        return "Unknown WebSocket error";
      }
    }
    return "Unknown WebSocket error";
  }

  private getMessageQueueKey(): string | null {
    return this.userId && this.businessProfileId ? `websocket_message_queue:${this.userId}:${this.businessProfileId}` : null;
  }

  private getWebSocketUrl(): string {
    // Realtime runs on the API server, so follow NEXT_PUBLIC_API_URL unless a separate
    // WebSocket host is configured; pointing the app at another API then moves both.
    const configured =
      process.env.NEXT_PUBLIC_WS_URL?.trim() || process.env.NEXT_PUBLIC_API_URL?.trim();
    const fallback = typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:8080";
    const parsed = new URL(configured || fallback);
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    if (!["ws:", "wss:"].includes(parsed.protocol)) {
      throw new Error("NEXT_PUBLIC_WS_URL must use http(s) or ws(s)");
    }
    parsed.pathname = "/api/agents/progress";
    parsed.search = "";
    if (this.businessProfileId) parsed.searchParams.set('businessProfileId', String(this.businessProfileId));
    parsed.hash = "";
    return parsed.toString();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  connect(userId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        reject(new Error("A valid user is required for realtime connection"));
        return;
      }

      const businessProfileId = selectedBusinessProfileId();
      if (this.userId !== null && (this.userId !== userId || this.businessProfileId !== businessProfileId)) {
        this.connectionGeneration++;
        this.clearReconnectTimer();
        const previousSocket = this.ws;
        this.ws = null;
        this.isConnecting = false;
        previousSocket?.close(1000, "User changed");
        this.messageQueue = [];
        this.receivedMessageIds.clear();
        this.desiredThreadId = undefined;
      }

      this.disconnected = false;
      this.userId = userId;
      this.businessProfileId = businessProfileId;
      this.loadMessageQueue();

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      if (this.isConnecting) {
        let elapsed = 0;
        const checkInterval = setInterval(() => {
          elapsed += 100;
          if (this.ws?.readyState === WebSocket.OPEN) {
            clearInterval(checkInterval);
            resolve();
          } else if (elapsed >= 10000) {
            clearInterval(checkInterval);
            reject(new Error('WebSocket connection timed out'));
          }
        }, 100);
        return;
      }

      this.isConnecting = true;
      this.clearReconnectTimer();
      const generation = ++this.connectionGeneration;

      try {
        this.url = this.getWebSocketUrl();
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          if (generation !== this.connectionGeneration) return;
          this.reconnectAttempts = 0;
          this.isConnecting = false;
          this.flushMessageQueue();
          this.sendThreadSubscription();
          this.emit("websocket_connected", {});
          resolve();
        };

        this.ws.onmessage = (event) => {
          if (generation !== this.connectionGeneration) return;
          try {
            const wsEvent = JSON.parse(event.data);
            if (!wsEvent || typeof wsEvent !== "object" || typeof wsEvent.type !== "string") {
              throw new Error("Invalid realtime event envelope");
            }
            const ackMessageId = wsEvent.data?.ackMessageId;
            if (
              typeof ackMessageId === "string" &&
              (wsEvent.type === "message_sent" || (wsEvent.type === "error" && wsEvent.data?.terminal))
            ) {
              this.acknowledgeMessage(ackMessageId);
            }
            // An event identifies a delivery; a message may receive many chunks.
            // Legacy envelopes used messageId as their delivery identity.
            const eventId = typeof wsEvent.eventId === 'string' && wsEvent.eventId
              ? wsEvent.eventId
              : typeof wsEvent.messageId === 'string' && wsEvent.messageId ? wsEvent.messageId : undefined;
            if (eventId && this.receivedMessageIds.has(eventId)) return;

            if (eventId) {
              this.receivedMessageIds.add(eventId);
              if (this.receivedMessageIds.size > this.maxReceivedMessagesCache) {
                const firstId = this.receivedMessageIds.values().next().value;
                if (firstId !== undefined) this.receivedMessageIds.delete(firstId);
              }
            }

            this.consecutiveParseErrors = 0;
            this.emit(wsEvent.type, {
              ...wsEvent.data,
              __envelope: {
                schemaVersion: wsEvent.schemaVersion,
                eventId: wsEvent.eventId,
                kind: wsEvent.kind || wsEvent.type,
                threadId: wsEvent.threadId,
                turnId: wsEvent.turnId,
                runId: wsEvent.runId,
                actionId: wsEvent.actionId,
                messageId: wsEvent.messageId,
                sequence: wsEvent.sequence,
              },
            });
            this.emit("message", wsEvent);
          } catch (error) {
            // M6: count consecutive parse errors; log payload prefix for debugging.
            this.consecutiveParseErrors++;
            const payloadPreview = typeof event.data === "string"
              ? event.data.substring(0, 100)
              : "(binary)";
            console.error(
              `[WebSocketService] Message parse error (consecutive: ${this.consecutiveParseErrors}):`,
              error,
              `\nPayload preview: ${payloadPreview}`
            );
            // After hitting threshold, force a reconnect to recover the stream.
            if (this.consecutiveParseErrors >= this.maxConsecutiveParseErrors) {
              console.warn(
                `[WebSocketService] ${this.consecutiveParseErrors} consecutive parse errors — forcing reconnect`
              );
              this.consecutiveParseErrors = 0;
              this.ws?.close(4000, "Excessive parse errors");
            }
          }
        };

        this.ws.onerror = (error) => {
          if (generation !== this.connectionGeneration) return;
          this.isConnecting = false;
          const message = this.normalizeErrorMessage(error);
          this.emit("websocket_error", { error: message, url: this.url });
          reject(new Error(message));
        };

        this.ws.onclose = () => {
          if (generation !== this.connectionGeneration) return;
          this.ws = null;
          this.isConnecting = false;
          this.emit("websocket_disconnected", {});
          if (this.userId && !this.disconnected) {
            this.attemptReconnect(this.userId);
          }
        };
      } catch (error) {
        if (generation !== this.connectionGeneration) return;
        this.isConnecting = false;
        reject(error);
        // Also attempt reconnection after constructor-level failure
        if (this.userId) {
          this.attemptReconnect(this.userId);
        }
      }
    });
  }

  private attemptReconnect(userId: number) {
    this.reconnectAttempts++;
    if (this.reconnectAttempts === this.maxReconnectAttempts) {
      this.emit("websocket_max_retries", { attempts: this.reconnectAttempts });
    }

    // The API has a long cold-start path and can be unavailable for more than
    // the initial retry window. Keep probing at the capped interval so queued
    // chat turns resume without a page reload when the server returns.
    const cappedAttempt = Math.min(this.reconnectAttempts, this.maxReconnectAttempts);
    const baseDelay = Math.min(
      this.reconnectDelay * Math.pow(2, cappedAttempt - 1),
      30_000,
    );
    const delay = Math.round(baseDelay * (0.85 + Math.random() * 0.3));
    const generation = this.connectionGeneration;

    this.emit("websocket_retrying", { retryCount: cappedAttempt, nextDelayMs: delay });

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (
        this.disconnected ||
        this.userId !== userId ||
        generation !== this.connectionGeneration
      ) {
        return;
      }
      this.connect(userId).catch((error) => {
        console.warn("[WebSocketService] Reconnection failed:", this.normalizeErrorMessage(error));
      });
    }, delay);
  }

  subscribe(eventType: string, handler: WebSocketEventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
    return () => {
      const handlers = this.handlers.get(eventType);
      if (handlers) handlers.delete(handler);
    };
  }

  private emit(eventType: string, data: Record<string, unknown>) {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          console.error(`[WebSocketService] Error in handler for ${eventType}:`, error);
        }
      });
    }
  }

  send(data: Record<string, unknown>): 'sent' | 'queued' {
    const requestedMessageId = typeof data.messageId === "string" ? data.messageId : undefined;
    const messageId = requestedMessageId && /^[A-Za-z0-9:_-]{1,200}$/.test(requestedMessageId)
      ? requestedMessageId
      : `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const queuedMessage: QueuedMessage = {
      id: messageId,
      data: { ...data, messageId },
      timestamp: Date.now(),
      retries: 0,
    };

    const durable = data.type === "send_chat_message";
    if (durable) this.queueMessage(queuedMessage);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(queuedMessage.data));
        if (durable) {
          queuedMessage.retries += 1;
          queuedMessage.lastAttemptAt = Date.now();
          this.persistMessageQueue();
        }
        return 'sent';
      } catch {
        if (!durable) this.queueMessage(queuedMessage);
        return 'queued';
      }
    } else {
      if (!durable) this.queueMessage(queuedMessage);
      return 'queued';
    }
  }

  private acknowledgeMessage(messageId: string): void {
    const next = this.messageQueue.filter((message) => message.id !== messageId);
    if (next.length === this.messageQueue.length) return;
    this.messageQueue = next;
    this.persistMessageQueue();
  }

  /**
   * Remove a turn from the reconnect queue before another durable transport
   * takes ownership of delivery (currently the authenticated HTTP fallback).
   */
  releaseQueuedMessage(messageId: string): void {
    this.acknowledgeMessage(messageId);
  }

  private queueMessage(message: QueuedMessage) {
    if (this.messageQueue.some((queued) => queued.id === message.id)) return;
    if (this.messageQueue.length >= 100) {
      throw new Error("Too many unacknowledged messages. Wait for delivery before sending more.");
    }
    this.messageQueue.push(message);
    this.persistMessageQueue();
  }

  private loadMessageQueue() {
    try {
      if (typeof window === "undefined") return;
      const key = this.getMessageQueueKey();
      if (!key) return;
      const stored = localStorage.getItem(key);
      if (stored) {
        const parsed = JSON.parse(stored);
        const now = Date.now();
        this.messageQueue = Array.isArray(parsed)
          ? parsed.filter((message): message is QueuedMessage => (
              message &&
              typeof message.id === "string" &&
              /^[A-Za-z0-9:_-]{1,200}$/.test(message.id) &&
              typeof message.timestamp === "number" &&
              now - message.timestamp < 24 * 60 * 60 * 1000 &&
              Number.isInteger(message.retries) &&
              message.retries >= 0 &&
              message.data &&
              typeof message.data === "object" &&
              message.data.type === "send_chat_message"
            )).slice(-100)
          : [];
      }
    } catch {
      this.messageQueue = [];
    }
  }

  private persistMessageQueue() {
    try {
      if (typeof window === "undefined") return;
      const key = this.getMessageQueueKey();
      if (!key) return;
      const durableMessages = this.messageQueue.filter(
        (message) => message.data.type === "send_chat_message",
      );
      localStorage.setItem(key, JSON.stringify(durableMessages));
    } catch {
      // Ignore
    }
  }

  private flushMessageQueue() {
    const now = Date.now();

    this.messageQueue = this.messageQueue.filter((msg) => {
      const age = now - msg.timestamp;
      return age < 24 * 60 * 60 * 1000;
    });

    const messagesToSend = [...this.messageQueue];

    messagesToSend.forEach((message) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify(message.data));
          message.retries += 1;
          message.lastAttemptAt = now;
        } catch {
          // Keep the durable message queued until the server acknowledges it.
        }
      }
    });

    this.persistMessageQueue();
  }

  disconnect() {
    this.disconnected = true;
    this.connectionGeneration++;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close(1000, "Client disconnected");
      this.ws = null;
    }
    this.handlers.clear();
    this.messageQueue = [];
    this.reconnectAttempts = 0;
    this.receivedMessageIds.clear();
    this.userId = null;
    this.desiredThreadId = undefined;
    this.isConnecting = false;
    // Keep the per-user durable queue in localStorage. Auth hydration, page
    // reloads, and provider remounts all call disconnect transiently; deleting
    // it here used to lose chat turns that had not yet received a server ACK.
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getState(): "CONNECTING" | "CONNECTED" | "DISCONNECTED" {
    if (this.isConnecting) return "CONNECTING";
    if (this.isConnected()) return "CONNECTED";
    return "DISCONNECTED";
  }

  /**
   * Tell the server which thread this connection is currently viewing.
   * This enables server-side filtering so thread-specific events
   * are only sent to connections viewing that thread.
   */
  subscribeToThread(threadId: number | undefined): void {
    const nextThreadId = Number.isSafeInteger(threadId) && Number(threadId) > 0
      ? Number(threadId)
      : undefined;
    if (this.desiredThreadId === nextThreadId) return;

    this.desiredThreadId = nextThreadId;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.threadSubscriptionScheduled) return;

    // React effect cleanup/remount and route transitions can issue several
    // unsubscribe/subscribe calls in one turn. Coalesce them so the server
    // observes only the final thread and cannot briefly leak or drop events.
    this.threadSubscriptionScheduled = true;
    queueMicrotask(() => {
      this.threadSubscriptionScheduled = false;
      this.sendThreadSubscription();
    });
  }

  private sendThreadSubscription(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = this.desiredThreadId
      ? { type: "subscribe_thread", data: { threadId: this.desiredThreadId } }
      : { type: "unsubscribe_thread", data: {} };
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      // The reconnect path will restore the desired subscription.
    }
  }
}

export const webSocketService = new WebSocketService();
export default webSocketService;
