import { describe, expect, it, jest } from '@jest/globals';
import { gmailConnectionFailure, readGmailConnection, type GmailConnectionStage } from '../utils/gmailOAuthDiagnostics.js';

describe('safe Gmail connection diagnostics', () => {
  it.each([
    ['token_exchange', { response: { status: 400, data: { error: 'invalid_grant' } } }, 'authorization_code_rejected'],
    ['token_exchange', { response: { status: 401, data: { error: 'invalid_client' } } }, 'oauth_client_rejected'],
    ['mailbox_profile', { response: { status: 403, data: { error: { details: [{ reason: 'SERVICE_DISABLED' }] } } } }, 'gmail_api_disabled'],
    ['mailbox_profile', { response: { status: 403, data: { error: { errors: [{ reason: 'domainPolicy' }] } } } }, 'workspace_policy_blocked'],
    ['mailbox_profile', { response: { status: 403, data: { error: { errors: [{ reason: 'insufficientPermissions' }] } } } }, 'missing_scopes'],
    ['mailbox_profile', { response: { status: 429 } }, 'google_rate_limited'],
    ['mailbox_profile', { response: { status: 503 } }, 'google_unavailable'],
    ['mailbox_profile', { cause: { code: 'ENOTFOUND' } }, 'google_connection_unavailable'],
    ['credential_save', { cause: { code: '42501' } }, 'connection_database_permission_denied'],
    ['credential_save', { cause: { code: '42703' } }, 'connection_database_schema_outdated'],
    ['sender_setup', { cause: { code: '23505' } }, 'connection_database_conflict'],
    ['configuration', { cause: { code: 'ECONNREFUSED' } }, 'connection_database_unavailable'],
    ['credential_save', { code: 'GMAIL_MAILBOX_ALREADY_CONNECTED' }, 'mailbox_already_connected'],
  ] as Array<[GmailConnectionStage, unknown, string]>)('classifies %s errors as %s without serializing provider data', (stage, error, code) => {
    expect(gmailConnectionFailure(error, stage).failureCode).toBe(code);
  });
  it('keeps only known codes, status and stage from nested errors containing credentials and SQL', () => {
    const sensitive = 'private-mailbox@example.test access_token=private-token authorization_code=private-code';
    const failure = gmailConnectionFailure({ message: sensitive, stack: sensitive, code: sensitive, config: { body: sensitive },
      response: { status: 403, data: { error: { message: sensitive, errors: [{ reason: sensitive }], details: [{ reason: 'SERVICE_DISABLED', metadata: sensitive }] } } },
      cause: { code: '42501', message: sensitive, query: sensitive },
    }, 'credential_save');
    expect(failure).toMatchObject({ failureCode: 'connection_database_permission_denied', failureStage: 'credential_save', providerCode: 'SERVICE_DISABLED', httpStatus: 403, databaseCode: '42501' });
    expect(JSON.stringify(failure)).not.toContain('private-');
    const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
    expect(gmailConnectionFailure(cyclic, 'sender_setup').failureCode).toBe('sender_setup_failed');
  });
});

describe('bounded retries for safe mailbox reads', () => {
  it('recovers from temporary network and Google server errors with backoff', async () => {
    const read = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValue('mailbox');
    const pause = jest.fn<(_ms: number) => Promise<void>>().mockResolvedValue(undefined);
    await expect(readGmailConnection(read, pause)).resolves.toBe('mailbox');
    expect(pause.mock.calls).toEqual([[1000], [2000]]);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('retries Gmail rate limits expressed as HTTP 403, then stops at three attempts', async () => {
    const error = { response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } };
    const read = jest.fn<() => Promise<string>>().mockRejectedValue(error);
    await expect(readGmailConnection(read, async () => {})).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it.each(['SERVICE_DISABLED', 'domainPolicy', 'insufficientPermissions', 'dailyLimitExceeded', 'quotaExceeded'])('does not retry a permanent Google block: %s', async reason => {
    const error = { response: { status: 403, data: { error: { errors: [{ reason }] } } } };
    const read = jest.fn<() => Promise<string>>().mockRejectedValue(error);
    const pause = jest.fn<(_ms: number) => Promise<void>>();
    await expect(readGmailConnection(read, pause)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1); expect(pause).not.toHaveBeenCalled();
  });
});
