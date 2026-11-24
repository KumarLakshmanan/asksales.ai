import { describe, expect, it } from '@jest/globals';
import { redactLogText, redactLogValue } from '../utils/logRedaction.js';

describe('system log redaction', () => {
  it('redacts bearer tokens, JWTs, provider keys, email addresses, and sensitive query values', () => {
    const jwt = 'eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop';
    const output = redactLogText(`Bearer top-secret ${jwt} sk-abcdefghijk user@example.com ?token=abc123&safe=yes`);
    expect(output).not.toContain('top-secret');
    expect(output).not.toContain(jwt);
    expect(output).not.toContain('sk-abcdefghijk');
    expect(output).not.toContain('user@example.com');
    expect(output).toContain('safe=yes');
  });

  it('recursively censors sensitive context while retaining operational identifiers', () => {
    expect(redactLogValue({
      userId: 42,
      requestId: 'request-1',
      headers: { authorization: 'Bearer secret', cookie: 'session=secret' },
      account: { email: 'user@example.com', phone: '+919999999999' },
    })).toEqual({
      userId: 42,
      requestId: 'request-1',
      headers: { authorization: '[REDACTED]', cookie: '[REDACTED]' },
      account: { email: '[REDACTED]', phone: '[REDACTED]' },
    });
  });

  it('removes local usernames from stack paths', () => {
    expect(redactLogText('/Users/alice/project/server.ts\n/home/bob/app.js'))
      .toBe('/home/[USER]/project/server.ts\n/home/[USER]/app.js');
  });
});
