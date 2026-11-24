import { describe, expect, it, jest } from '@jest/globals';
import { setImmediate } from 'node:timers/promises';

const persist = jest.fn<(entry: { level: string; message: string }) => Promise<void>>(async () => {});
jest.unstable_mockModule('../models/systemLogs/functions', () => ({ createSystemLog: persist }));
const { SystemLogDBStream, persistedMinimumLevel } = await import('../services/systemLogDBStream.js');

const lines = [
  '{"level":20,"msg":"debug detail"}',
  '{"level":30,"msg":"Processing general job"}',
  '{"level":40,"msg":"Provider slow"}',
  '{"level":50,"msg":"Provider failed"}',
  '{"level":60,"msg":"Process crashed"}',
].join('\n') + '\n';

async function stored(minimumLevel?: number) {
  persist.mockClear();
  const stream = minimumLevel === undefined ? new SystemLogDBStream(100) : new SystemLogDBStream(100, minimumLevel);
  stream.write(lines);
  await setImmediate();
  await setImmediate();
  stream.end();
  return persist.mock.calls.map(([entry]) => entry.message);
}

describe('system log persistence level', () => {
  it('stores warnings and errors but not routine info by default', async () => {
    expect(await stored()).toEqual(['Provider slow', 'Provider failed', 'Process crashed']);
  });

  it('can store info again, and never stores debug', async () => {
    expect(await stored(persistedMinimumLevel('info'))).toEqual([
      'Processing general job',
      'Provider slow',
      'Provider failed',
      'Process crashed',
    ]);
  });

  it('reads SYSTEM_LOG_DB_LEVEL values and falls back to warn', () => {
    expect(persistedMinimumLevel('info')).toBe(30);
    expect(persistedMinimumLevel(' ERROR ')).toBe(50);
    expect(persistedMinimumLevel('warn')).toBe(40);
    expect(persistedMinimumLevel('debug')).toBe(40);
    expect(persistedMinimumLevel(undefined)).toBe(40);
  });
});
