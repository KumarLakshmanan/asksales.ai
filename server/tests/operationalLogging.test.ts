import { describe, expect, it } from '@jest/globals';
import pino from 'pino';
import { redactedLogDestination } from '../utils/logRedaction.js';

describe('log sink boundary', () => {
  it('sanitizes messages, primitive errors, nested fields and child bindings before all sinks', () => {
    const sinks = ['', ''];
    const destination = redactedLogDestination(pino.multistream(sinks.map((_value, i) => ({
      stream: { write(line: string) { sinks[i] += line; } },
    }))));
    const logger = pino({}, destination).child({ accessToken: 'synthetic-child-secret',
      nested: { data: { apiKey: 'synthetic-deep-secret' } } });
    logger.info({ err: 'synthetic-provider-body', refreshToken: 'synthetic-root-secret' },
      'Contact audit@example.test Bearer synthetic-bearer ?access_token=synthetic-query');
    for (const output of sinks) {
      for (const value of ['synthetic-child-secret', 'synthetic-deep-secret', 'synthetic-provider-body',
        'synthetic-root-secret', 'audit@example.test', 'synthetic-bearer', 'synthetic-query']) {
        expect(output).not.toContain(value);
      }
      expect(JSON.parse(output).msg).toContain('[REDACTED]');
    }
  });

  it('retains safe diagnostic identifiers and omits malformed records', () => {
    let output = '';
    const stream = redactedLogDestination({ write(value: string) { output += value; } });
    stream.write(JSON.stringify({ requestId: 'request-1', err: { type: 'TimeoutError', code: 'ETIMEDOUT' } }));
    expect(JSON.parse(output)).toEqual({ requestId: 'request-1', err: { type: 'TimeoutError', code: 'ETIMEDOUT' } });
    output = ''; stream.write('synthetic-malformed-secret');
    expect(output).not.toContain('synthetic-malformed-secret');
  });
  it('removes credential URI userinfo and password hashes', () => {
    let output = '';
    pino({}, redactedLogDestination({ write(value: string) { output += value; } }))
      .info({ passwordHash: 'synthetic-hash' }, 'redis://fixture:synthetic-password@localhost:6379');
    expect(output).not.toContain('synthetic-password');
    expect(output).not.toContain('synthetic-hash');
    expect(output).toContain('localhost');
  });
});
