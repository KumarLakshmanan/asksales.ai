/**
 * WebSocketService Tests
 * Tests: disconnect flag, subscribe/unsubscribe, getState, send
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock WebSocket globally
const mockWs = {
  close: vi.fn(),
  send: vi.fn(),
  readyState: 3, // CLOSED initially
  onopen: null as (() => void) | null,
  onclose: null as ((event: CloseEvent) => void) | null,
  onmessage: null as ((event: MessageEvent) => void) | null,
  onerror: null as (() => void) | null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
};

const WebSocketMock = vi.fn(function MockWebSocket() {
  mockWs.readyState = 0; // CONNECTING
  return mockWs;
});
Object.assign(WebSocketMock, {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
});
vi.stubGlobal('WebSocket', WebSocketMock);

// Import after mock setup
const { default: webSocketService } = await import('@/services/WebSocketService');

describe('WebSocketService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockWs.readyState = 3; // CLOSED
    webSocketService.disconnect();
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('user',JSON.stringify({ id:42 }));
    sessionStorage.setItem('active-business-profile:42','101');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('disconnect', () => {
    it('should return DISCONNECTED state after disconnect', () => {
      webSocketService.disconnect();
      expect(webSocketService.getState()).toBe('DISCONNECTED');
    });

    it('should be disconnectable multiple times without error', () => {
      webSocketService.disconnect();
      webSocketService.disconnect();
      webSocketService.disconnect();
      expect(webSocketService.getState()).toBe('DISCONNECTED');
    });
  });

  describe('subscribe and unsubscribe', () => {
    it('should return a function from subscribe', () => {
      const handler = vi.fn();
      const result = webSocketService.subscribe('test_event', handler);
      expect(typeof result).toBe('function');
    });

    it('should return unsubscribe function that can be called', () => {
      const handler = vi.fn();
      const unsub = webSocketService.subscribe('test_event', handler);
      unsub(); // Should not throw
    });

    it('should support multiple handlers for the same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const unsub1 = webSocketService.subscribe('test_event', handler1);
      const unsub2 = webSocketService.subscribe('test_event', handler2);

      expect(typeof unsub1).toBe('function');
      expect(typeof unsub2).toBe('function');

      unsub1();
      unsub2();
    });
  });

  describe('getState', () => {
    it('should return DISCONNECTED when not connected', () => {
      webSocketService.disconnect();
      expect(webSocketService.getState()).toBe('DISCONNECTED');
    });

    it('should return a valid state string', () => {
      const state = webSocketService.getState();
      expect(['DISCONNECTED', 'CONNECTING', 'CONNECTED']).toContain(state);
    });
  });

  describe('send', () => {
    it('should queue messages when not connected', () => {
      webSocketService.disconnect();
      const result = webSocketService.send({ type: 'test' });
      expect(result).toBe('queued');
    });

    it('should queue multiple messages', () => {
      webSocketService.disconnect();
      const result1 = webSocketService.send({ type: 'test1' });
      const result2 = webSocketService.send({ type: 'test2' });
      expect(result1).toBe('queued');
      expect(result2).toBe('queued');
    });

    it('persists queued chat messages under the authenticated user only', () => {
      void webSocketService.connect(42);
      webSocketService.send({
        type: 'send_chat_message',
        data: { content: 'Hello' },
      });

      expect(localStorage.getItem('websocket_message_queue:42:101')).toContain('Hello');
      expect(localStorage.getItem('websocket_message_queue')).toBeNull();
    });

    it('preserves unacknowledged chat turns across disconnect and reconnect', async () => {
      void webSocketService.connect(42);
      webSocketService.send({
        type: 'send_chat_message',
        data: { content: 'Resume after reload' },
      });
      webSocketService.disconnect();

      expect(localStorage.getItem('websocket_message_queue:42:101')).toContain('Resume after reload');

      const reconnected = webSocketService.connect(42);
      mockWs.readyState = 1;
      mockWs.onopen?.();
      await reconnected;

      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('Resume after reload'));
    });

    it('releases a queued durable turn when HTTP takes ownership', () => {
      void webSocketService.connect(42);
      webSocketService.send({
        type: 'send_chat_message',
        messageId: 'chat_http_fallback_1',
        data: { content: 'Deliver over HTTP' },
      });

      expect(localStorage.getItem('websocket_message_queue:42:101')).toContain('chat_http_fallback_1');
      webSocketService.releaseQueuedMessage('chat_http_fallback_1');
      expect(JSON.parse(localStorage.getItem('websocket_message_queue:42:101') || '[]')).toEqual([]);
    });
  });

  describe('delivery recovery', () => {
    it('retains an open-socket chat turn until the server acknowledges it', async () => {
      const connected = webSocketService.connect(7);
      mockWs.readyState = 1;
      mockWs.onopen?.();
      await connected;

      webSocketService.send({
        type: 'send_chat_message',
        data: { content: 'Retain me' },
      });
      const stored = JSON.parse(localStorage.getItem('websocket_message_queue:7:101') || '[]');
      expect(stored).toHaveLength(1);

      mockWs.onmessage?.({
        data: JSON.stringify({
          type: 'message_sent',
          data: { success: true, ackMessageId: stored[0].id },
        }),
      } as MessageEvent);

      expect(JSON.parse(localStorage.getItem('websocket_message_queue:7:101') || '[]')).toEqual([]);
    });

    it('drops an acknowledged reconnect replay without retrying it again', async () => {
      const connected = webSocketService.connect(7);
      mockWs.readyState = 1;
      mockWs.onopen?.();
      await connected;

      webSocketService.send({
        type: 'send_chat_message',
        messageId: 'chat_replayed_1',
        data: { content: 'Already accepted' },
      });
      expect(localStorage.getItem('websocket_message_queue:7:101')).toContain('chat_replayed_1');

      mockWs.onmessage?.({
        data: JSON.stringify({
          type: 'error',
          data: {
            code: 'REQUEST_IN_PROGRESS',
            replayed: true,
            terminal: true,
            ackMessageId: 'chat_replayed_1',
          },
        }),
      } as MessageEvent);

      expect(JSON.parse(localStorage.getItem('websocket_message_queue:7:101') || '[]')).toEqual([]);
    });

    it('deduplicates the direct and Redis-bridged copy of the same event', async () => {
      const handler = vi.fn();
      webSocketService.subscribe('chat_response', handler);
      const connected = webSocketService.connect(1);
      mockWs.readyState = 1;
      mockWs.onopen?.();
      await connected;

      const event = {
        data: JSON.stringify({
          type: 'chat_response',
          messageId: 'response-1',
          data: { content: 'Done' },
        }),
      } as MessageEvent;
      mockWs.onmessage?.(event);
      mockWs.onmessage?.(event);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('delivers distinct chunks for one message and discards event replays', async () => {
      const handler = vi.fn();
      const unsubscribe = webSocketService.subscribe('chat_response_chunk', handler);
      const connected = webSocketService.connect(1);
      mockWs.readyState = 1;
      mockWs.onopen?.();
      await connected;
      const deliver = (eventId: string, messageId: string, sequence: number) => mockWs.onmessage?.({
        data: JSON.stringify({ type: 'chat_response_chunk', eventId, messageId, sequence, data: { chunk: String(sequence) } }),
      } as MessageEvent);
      deliver('chunk-event-1', 'assistant-1', 1);
      deliver('chunk-event-2', 'assistant-1', 2);
      deliver('chunk-event-1', 'legacy-transport-id', 1);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls.map(([data]) => data.chunk)).toEqual(['1', '2']);
      unsubscribe();
    });

    it('preserves the versioned correlation envelope for reducers', async () => {
      const handler = vi.fn();
      webSocketService.subscribe('workflow_run_status', handler);
      const connected = webSocketService.connect(1);
      mockWs.readyState = 1;
      mockWs.onopen?.();
      await connected;

      mockWs.onmessage?.({
        data: JSON.stringify({
          schemaVersion: 1,
          eventId: 'event-7',
          type: 'workflow_run_status',
          kind: 'workflow_run_status',
          threadId: 12,
          turnId: 'turn-2',
          runId: 'run-3',
          actionId: 'action-4',
          messageId: 'event-7',
          sequence: 5,
          data: { status: 'running' },
        }),
      } as MessageEvent);

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        status: 'running',
        __envelope: {
          schemaVersion: 1,
          eventId: 'event-7',
          kind: 'workflow_run_status',
          threadId: 12,
          turnId: 'turn-2',
          runId: 'run-3',
          actionId: 'action-4',
          messageId: 'event-7',
          sequence: 5,
        },
      }));
    });

    it('restores the active thread subscription after connecting', async () => {
      webSocketService.subscribeToThread(17);
      const connected = webSocketService.connect(1);
      mockWs.readyState = 1;
      mockWs.onopen?.();
      await connected;

      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'subscribe_thread',
        data: { threadId: 17 },
      }));
    });

    it('coalesces rapid thread cleanup and remount subscriptions', async () => {
      const connected = webSocketService.connect(1);
      mockWs.readyState = 1;
      mockWs.onopen?.();
      await connected;
      mockWs.send.mockClear();

      webSocketService.subscribeToThread(17);
      webSocketService.subscribeToThread(undefined);
      webSocketService.subscribeToThread(17);
      await Promise.resolve();

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'subscribe_thread',
        data: { threadId: 17 },
      }));
    });

    it('cancels scheduled reconnects when the user disconnects', async () => {
      const connected = webSocketService.connect(1);
      mockWs.readyState = 1;
      mockWs.onopen?.();
      await connected;

      mockWs.readyState = 3;
      mockWs.onclose?.({} as CloseEvent);
      webSocketService.disconnect();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(WebSocketMock).toHaveBeenCalledTimes(1);
    });

    it('keeps probing after the initial reconnect threshold', async () => {
      const connected = webSocketService.connect(1);
      mockWs.readyState = 1;
      mockWs.onopen?.();
      await connected;

      mockWs.readyState = 3;
      mockWs.onclose?.({} as CloseEvent);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        mockWs.readyState = 3;
        mockWs.onclose?.({} as CloseEvent);
      }

      expect(WebSocketMock.mock.calls.length).toBeGreaterThan(6);
    });
  });
});
