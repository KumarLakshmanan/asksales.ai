const SECRET_ASSIGNMENT = /\b(access[_ -]?token|refresh[_ -]?token|developer[_ -]?token|client[_ -]?secret|authorization)\b\s*[:=]\s*["']?[^\s,"']+/gi;
const SECRET_QUERY = /([?&])(access_token|refresh_token|developer_token|client_secret)=[^&#\s]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function sanitizeProviderError(message: string): string {
  const sanitized = String(message || 'Unknown provider error')
    .replace(BEARER_TOKEN, 'Bearer [redacted]')
    .replace(SECRET_ASSIGNMENT, (_match, label: string) => `${label}=[redacted]`)
    .replace(SECRET_QUERY, '$1$2=[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return (sanitized || 'Unknown provider error').slice(0, 1500);
}

export function providerErrorCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('confirmation')) return 'ACTIVATION_CONFIRMATION_REQUIRED';
  if (normalized.includes('currency')) return 'ACCOUNT_CURRENCY_MISMATCH';
  if (normalized.includes('customer changed') || normalized.includes('account is no longer ready')) return 'ACCOUNT_READINESS_CHANGED';
  if (normalized.includes('budget')) return 'BUDGET_VALIDATION_FAILED';
  if (normalized.includes('reconcil') || normalized.includes('clean up') || normalized.includes('cleanup')) return 'PROVIDER_RECONCILIATION_REQUIRED';
  if (normalized.includes('oauth') || normalized.includes('token') || normalized.includes('credential') || normalized.includes('unauthorized')) return 'PROVIDER_AUTHORIZATION_FAILED';
  if (normalized.includes('validation') || normalized.includes('headline') || normalized.includes('description') || normalized.includes('keyword')) return 'PROVIDER_VALIDATION_FAILED';
  return 'PROVIDER_REQUEST_FAILED';
}
