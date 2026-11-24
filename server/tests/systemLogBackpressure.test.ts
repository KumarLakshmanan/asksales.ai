import { describe, expect, it, jest } from '@jest/globals';
import { setImmediate } from 'node:timers/promises';
const resolvers: Array<() => void> = [];
const persist = jest.fn<() => Promise<void>>(() => new Promise(resolve => resolvers.push(resolve)));
jest.unstable_mockModule('../models/systemLogs/functions', () => ({ createSystemLog: persist }));
const { SystemLogDBStream } = await import('../services/systemLogDBStream.js');

describe('bounded diagnostic persistence', () => {
  it('caps in-flight writes during a DB stall and recovers capacity without throwing', async () => {
    const stream = new SystemLogDBStream(2);
    for (let index = 0; index < 5; index++) stream.write('{"level":40,"msg":"synthetic"}\n');
    await setImmediate();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(stream.getDiagnostics()).toEqual({ pendingWrites: 2, droppedWrites: 3 });
    resolvers.splice(0).forEach(resolve => resolve());
    await setImmediate();
    stream.write('{"level":40,"msg":"synthetic recovered"}\n');
    await setImmediate();
    expect(persist).toHaveBeenCalledTimes(3);
    expect(stream.getDiagnostics()).toEqual({ pendingWrites: 1, droppedWrites: 3 });
    resolvers.splice(0).forEach(resolve => resolve());
    stream.end();
  });
});
