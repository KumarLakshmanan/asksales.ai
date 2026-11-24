export interface InstagramOAuthCredentialMetadata {
  credentialType?: string | null;
  accessToken?: string | boolean | null;
  accountIdentifier?: string | null;
  tokenExpiry?: Date | string | null;
  sessionData?: unknown;
}

function hasAccessToken(value: InstagramOAuthCredentialMetadata['accessToken']): boolean {
  return value === true || (typeof value === 'string' && value.trim().length > 0);
}

function getSessionData(value: unknown): { connectedViaOAuth?: boolean; pageId?: string; useInstagramLogin?: boolean } {
  return value && typeof value === 'object'
    ? value as { connectedViaOAuth?: boolean; pageId?: string; useInstagramLogin?: boolean }
    : {};
}

/** Explicit provider metadata, never token prefixes, determines the API host. */
export function isDirectInstagramLogin(credential: { sessionData?: unknown } | null | undefined): boolean {
  return getSessionData(credential?.sessionData).useInstagramLogin === true;
}

/**
 * Legacy manual rows can become OAuth-backed after a successful reconnect.
 * The OAuth callback records that proof in sessionData, so accept it while the
 * repair migration normalizes credential_type for existing installations.
 */
export function isOAuthBackedInstagramCredential(
  credential: InstagramOAuthCredentialMetadata | null | undefined,
): boolean {
  if (!credential) return false;
  const session = getSessionData(credential.sessionData);
  const oauthCompleted = credential.credentialType === 'oauth' || session.connectedViaOAuth === true;

  return Boolean(
    oauthCompleted
    && hasAccessToken(credential.accessToken)
    && credential.accountIdentifier
    && (session.useInstagramLogin === true || session.pageId)
  );
}

export function isUsableInstagramOAuthCredential(
  credential: InstagramOAuthCredentialMetadata | null | undefined,
  now = Date.now(),
): boolean {
  if (!isOAuthBackedInstagramCredential(credential)) return false;
  if (!credential?.tokenExpiry) return true;
  return new Date(credential.tokenExpiry).getTime() > now;
}

/**
 * Manual developer credentials are first-class Graph API credentials. Unlike
 * OAuth rows they do not need an OAuth proof flag; account/page routing is
 * resolved from meta_page_connections by the service.
 */
export function isUsableInstagramCredential(
  credential: InstagramOAuthCredentialMetadata | null | undefined,
  now = Date.now(),
): boolean {
  if (!credential) return false;
  const isManual = credential.credentialType === 'manual';
  const isOAuth = isOAuthBackedInstagramCredential(credential);
  if ((!isManual && !isOAuth) || !hasAccessToken(credential.accessToken) || !credential.accountIdentifier) return false;
  return !credential.tokenExpiry || new Date(credential.tokenExpiry).getTime() > now;
}
