import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';

const port = Number(process.env.CONVERSATION_REDIS_QA_PORT);
const local = port ? describe : describe.skip;
const previous = { host: process.env.REDIS_HOST, port: process.env.REDIS_PORT, password: process.env.REDIS_PASSWORD };
if (port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('A disposable Redis port is required');
  process.env.REDIS_HOST = '127.0.0.1'; process.env.REDIS_PORT = String(port); process.env.REDIS_PASSWORD = '';
}
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { eventBus } = await import('../events/EventBus.js');
const { closeRedisConnections } = await import('../infrastructure/redis.js');
const { bridgeUserToEventBus, unbridgeUserFromEventBus } = await import('../gateway/RealtimeGateway.js');
const { webSocketEmitter } = await import('../services/agents/WebSocketEmitter.js');
let server: WebSocketServer;
const connections: Array<{ client: WebSocket; server: WebSocket; messages: Array<Record<string, unknown>> }> = [];

local('actual Redis pub/sub and loopback WebSockets for conversation tabs', () => {
  beforeAll(async () => {
    await eventBus.initialize();
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server,'listening');
  });
  afterAll(async () => {
    for (const connection of connections) {
      await unbridgeUserFromEventBus(7,connection.server);
      connection.client.terminate(); connection.server.terminate();
    }
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await eventBus.close(); await closeRedisConnections();
    for (const [key,value] of Object.entries({ REDIS_HOST: previous.host, REDIS_PORT: previous.port, REDIS_PASSWORD: previous.password })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  async function connect(threadId: number, authorize = async () => true) {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback socket unavailable');
    const ready = new Promise<WebSocket>((resolve,reject) => server.once('connection', socket => {
      void bridgeUserToEventBus(7,socket,1,authorize).then(() => {
        webSocketEmitter.updateClientThread(7,socket,threadId); resolve(socket);
      },reject);
    }));
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const messages: Array<Record<string, unknown>> = [];
    client.on('message', data => messages.push(JSON.parse(String(data))));
    const [socket] = await Promise.all([ready,once(client,'open')]);
    const connection = { client,server:socket,messages }; connections.push(connection); return connection;
  }
  const publish = (threadId: number, businessProfileId = 1) => eventBus.publish({
    channel:'events:ws:chat_response_chunk',userId:7,businessProfileId,threadId,messageId:`fixture-${threadId}-${businessProfileId}`,
    timestamp:new Date().toISOString(),data:{thread_id:threadId,responseId:'fixture-response',sequence:1,chunk:'Reviewed response'},
  });
  it('isolates businesses and threads, preserves another tab after disconnect, and closes revoked access', async () => {
    const first = await connect(42);
    let permitted = true;
    const second = await connect(99,async () => permitted);
    await publish(42,2); // A different selected business must not reach either tab.
    const firstMessage = once(first.client,'message'); await publish(42); await firstMessage;
    expect(first.messages).toHaveLength(1); expect(second.messages).toHaveLength(0);
    expect(first.messages[0]).toMatchObject({type:'chat_response_chunk',threadId:42,eventId:'fixture-42-1',sequence:1});
    await unbridgeUserFromEventBus(7,first.server); first.client.terminate();
    const secondMessage = once(second.client,'message'); await publish(99); await secondMessage;
    expect(second.messages).toHaveLength(1);
    permitted = false;
    const closed = once(second.client,'close'); await publish(99); const [code] = await closed;
    expect(code).toBe(1008); expect(second.messages).toHaveLength(1);
  });
});
