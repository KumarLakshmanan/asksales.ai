import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { WebSocket } from 'ws';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let subscribedHandler: ((event: any) => void) | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const subscribeToUser = jest.fn<any>(async (
  _userId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (event: any) => void,
) => {
  subscribedHandler = handler;
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const onWebSocketDisconnect = jest.fn<any>().mockResolvedValue(1);
const registerClient = jest.fn();
const unregisterClient = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTrackedClient = jest.fn<any>();

jest.unstable_mockModule('../events/EventBus.js', () => ({
  eventBus: {
    subscribeToUser,
    onWebSocketDisconnect,
    initialize: jest.fn(),
  },
}));

jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({
  webSocketEmitter: {
    registerClient,
    unregisterClient,
    getTrackedClient,
  },
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

const {
  bridgeUserToEventBus,
  unbridgeUserFromEventBus,
} = await import('../gateway/RealtimeGateway.js');

function socketDouble() {
  return {
    readyState: WebSocket.OPEN,
    send: jest.fn(),
  } as unknown as WebSocket;
}

describe('RealtimeGateway delivery contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    subscribedHandler = undefined;
    subscribeToUser.mockImplementation(async (
      _userId: number,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (event: any) => void,
    ) => {
      subscribedHandler = handler;
    });
  });

  it('maps internal ws channels to the client event name and preserves message IDs', async () => {
    const ws = socketDouble();
    getTrackedClient.mockReturnValue({ ws, threadId: 12 });
    await bridgeUserToEventBus(7, ws, 11);

    subscribedHandler?.({
      channel: 'events:ws:chat_response',
      messageId: 'chat_response_7_1',
      userId: 7,
      businessProfileId: 11,
      threadId: 12,
      timestamp: '2026-07-18T00:00:00.000Z',
      data: { content: 'Complete' },
    });

    const sent = JSON.parse((ws.send as jest.Mock).mock.calls[0][0] as string);
    expect(sent.type).toBe('chat_response');
    expect(sent.messageId).toBe('chat_response_7_1');
    expect(sent.data.content).toBe('Complete');
    expect(sent.data.threadId).toBe(12);
  });

  it('does not relay a thread event to a socket viewing another thread', async () => {
    const ws = socketDouble();
    getTrackedClient.mockReturnValue({ ws, threadId: 99 });
    await bridgeUserToEventBus(7, ws, 11);

    subscribedHandler?.({
      channel: 'events:ws:chat_response',
      userId: 7,
      businessProfileId: 11,
      threadId: 12,
      timestamp: '2026-07-18T00:00:00.000Z',
      data: {},
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('removes both local and Redis registrations on disconnect', async () => {
    const ws = socketDouble();
    await bridgeUserToEventBus(7, ws, 11);
    await unbridgeUserFromEventBus(7, ws);

    expect(unregisterClient).toHaveBeenCalledWith(7, ws);
    expect(onWebSocketDisconnect).toHaveBeenCalledTimes(1);
  });

  it('rolls back local registration when Redis subscription fails', async () => {
    const ws = socketDouble();
    subscribeToUser.mockRejectedValueOnce(new Error('Redis unavailable'));

    await expect(bridgeUserToEventBus(7, ws, 11)).rejects.toThrow('Redis unavailable');
    expect(unregisterClient).toHaveBeenCalledWith(7, ws);
    expect(onWebSocketDisconnect).toHaveBeenCalledTimes(1);
  });

  it('drops other-business and unassigned events even for the same account and thread', async () => {
    const ws = socketDouble();
    getTrackedClient.mockReturnValue({ ws, threadId: 12 });
    await bridgeUserToEventBus(7, ws, 11);
    for (const businessProfileId of [22, undefined]) subscribedHandler?.({
      channel:'events:ws:chat_response', userId:7, businessProfileId, threadId:12,
      timestamp:'2026-09-26T00:00:00.000Z', data:{ content:'Other business' },
    });
    expect(ws.send).not.toHaveBeenCalled();
  });
});
