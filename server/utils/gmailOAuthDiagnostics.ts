import type { OAuth2Client } from 'google-auth-library';

/** Only bounded, known diagnostic codes may leave the OAuth callback. Provider
 * exceptions can contain authorization codes, tokens, SQL parameters and email. */
export type GmailConnectionStage = 'session' | 'configuration' | 'token_exchange'
  | 'permissions' | 'mailbox_profile' | 'credential_save' | 'sender_setup' | 'inbox_watch';

/** Connected mailboxes refresh through the locked, persisted credential path.
 * The SDK's five-minute early refresh otherwise rejects a still-valid token
 * before that path's one-minute refresh window, because it has no refresh token. */
export function configureGmailPersistedTokenClient(client: Pick<OAuth2Client, 'eagerRefreshThresholdMillis'>): void {
  client.eagerRefreshThresholdMillis = 0;
}

export function configureGmailConnectionTransport(client: Pick<OAuth2Client, 'transporter'>): void {
  // The Google auth SDK explicitly enables retries for POST /token. Its
  // per-request options override transporter defaults, so use an interceptor
  // to prevent replaying a code Google may already have consumed.
  client.transporter.interceptors.request.add({ resolved: async options => {
    options.retry = false;
    options.retryConfig = { ...options.retryConfig, retry: 0 };
    options.timeout ??= 10000;
    return options;
  } });
}

const PROVIDER_CODES = new Set([
  'access_denied', 'invalid_grant', 'invalid_client', 'unauthorized_client',
  'redirect_uri_mismatch', 'invalid_scope', 'insufficientPermissions',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'SERVICE_DISABLED', 'accessNotConfigured',
  'domainPolicy', 'failedPrecondition', 'rateLimitExceeded', 'userRateLimitExceeded',
  'quotaExceeded', 'dailyLimitExceeded', 'backendError', 'internalError',
]);
const NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function gmailConnectionFailure(error: unknown, stage: GmailConnectionStage) {
  const chain: Record<string, unknown>[] = [];
  let value = error;
  for (let depth = 0; value && depth < 5; depth++) {
    const item = record(value);
    chain.push(item);
    value = item.cause;
  }
  let providerCode: string | undefined;
  let networkCode: string | undefined;
  let databaseCode: string | undefined;
  let httpStatus: number | undefined;
  let ownershipConflict = false;
  for (const item of chain) {
    const response = record(item.response);
    const body = record(response.data);
    const providerError = record(body.error);
    const details = Array.isArray(providerError.details) ? providerError.details : [];
    const errors = Array.isArray(providerError.errors) ? providerError.errors : [];
    const candidates = [body.error, ...details.map(detail => record(detail).reason), ...errors.map(detail => record(detail).reason)];
    providerCode ||= candidates.find((code): code is string => typeof code === 'string' && PROVIDER_CODES.has(code));
    if (typeof response.status === 'number' && Number.isInteger(response.status) && response.status >= 400 && response.status <= 599) httpStatus ??= response.status;
    if (typeof item.code === 'string') {
      if (NETWORK_CODES.has(item.code)) networkCode ||= item.code;
      if (/^[0-9]{2}[A-Z0-9]{3}$/.test(item.code)) databaseCode ||= item.code;
      if (item.code === 'GMAIL_MAILBOX_ALREADY_CONNECTED') ownershipConflict = true;
    }
    if (item.name === 'AbortError' || item.name === 'TimeoutError') networkCode ||= 'ETIMEDOUT';
  }
  let failureCode: string = `${stage}_failed`;
  if (ownershipConflict) failureCode = 'mailbox_already_connected';
  else if (databaseCode === '42501') failureCode = 'connection_database_permission_denied';
  else if (databaseCode && ['42703', '42P01', '42883'].includes(databaseCode)) failureCode = 'connection_database_schema_outdated';
  else if (databaseCode === '23505') failureCode = 'connection_database_conflict';
  else if (providerCode === 'invalid_grant') failureCode = 'authorization_code_rejected';
  else if (providerCode === 'invalid_client' || providerCode === 'unauthorized_client') failureCode = 'oauth_client_rejected';
  else if (providerCode === 'redirect_uri_mismatch') failureCode = 'redirect_uri_mismatch';
  else if (providerCode === 'SERVICE_DISABLED' || providerCode === 'accessNotConfigured') failureCode = 'gmail_api_disabled';
  else if (providerCode === 'domainPolicy') failureCode = 'workspace_policy_blocked';
  else if (providerCode === 'failedPrecondition') failureCode = 'mailbox_unavailable';
  else if (providerCode === 'insufficientPermissions' || providerCode === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || providerCode === 'invalid_scope') failureCode = 'missing_scopes';
  else if ((providerCode && ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'].includes(providerCode)) || httpStatus === 429) failureCode = 'google_rate_limited';
  else if (networkCode && ['credential_save', 'sender_setup', 'configuration'].includes(stage)) failureCode = 'connection_database_unavailable';
  else if (databaseCode) failureCode = 'connection_storage_failed';
  else if (networkCode) failureCode = 'google_connection_unavailable';
  else if (httpStatus && httpStatus >= 500) failureCode = 'google_unavailable';
  else if (httpStatus === 401) failureCode = 'google_access_rejected';
  else if (httpStatus === 403) failureCode = 'google_access_blocked';
  return { failureCode, failureStage: stage, providerCode, httpStatus, databaseCode, networkCode };
}

/** Retry only safe Google reads, never a single-use authorization-code exchange
 * or database writes. Disable the SDK's own retries to keep a bounded budget. */
export async function readGmailConnection<T>(
  read: () => Promise<T>,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); } catch (error) {
      const failure = gmailConnectionFailure(error, 'mailbox_profile');
      const retryable = ['google_connection_unavailable', 'google_unavailable', 'google_rate_limited'].includes(failure.failureCode)
        && !['quotaExceeded', 'dailyLimitExceeded'].includes(failure.providerCode || '');
      if (!retryable || attempt >= 2) throw error;
      await pause(1000 * 2 ** attempt);
    }
  }
}
