import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { Writable } from 'node:stream';
const originalEnvironment = { NODE_ENV: process.env.NODE_ENV, FILE_LOGGING_ENABLED: process.env.FILE_LOGGING_ENABLED };
process.env.NODE_ENV = 'production';
process.env.FILE_LOGGING_ENABLED = 'false';
jest.unstable_mockModule('../services/systemLogDBStream.js', () => ({
  SystemLogDBStream: class extends Writable {
    _write(_chunk: unknown, _encoding: unknown, callback: () => void) { callback(); }
    getDiagnostics() { return { pendingWrites: 2, droppedWrites: 3, message: 'must-never-be-exposed' }; }
  },
}));
const { getLogPersistenceDiagnostics } = await import('../infrastructure/logPersistenceDiagnostics.js');
afterAll(() => { for (const [key, value] of Object.entries(originalEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
describe('process-local diagnostic counters', () => {
  it('identifies a disabled/unregistered sink rather than implying it is enabled', () => {
    expect(getLogPersistenceDiagnostics()).toEqual({ enabled: false, pendingWrites: 0, droppedWrites: 0 });
  });
  it('registers the actual logger sink and exposes only counters', async () => {
    await import('../utils/logger.js');
    expect(getLogPersistenceDiagnostics()).toEqual({ enabled: true, pendingWrites: 2, droppedWrites: 3 });
  });
});
