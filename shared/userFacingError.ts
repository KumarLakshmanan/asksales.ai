export const AI_SERVICE_UNAVAILABLE_MESSAGE =
  'The AI service is temporarily unavailable. Please try this action again.';

const PROVIDER_INFRASTRUCTURE_PATTERNS = [
  /lightning dunning decision/i,
  /projects\/\d+/i,
  /resource[_\s-]?exhausted/i,
  /insufficient[_\s-]?quota/i,
  /quota (?:has been )?exceeded/i,
  /rate[_\s-]?limit/i,
  /too many requests/i,
  /provider (?:call|request|response|configuration|credential)/i,
  /(?:openai|openrouter|gemini|vertex ai|vertex_ai).*(?:billing|credential|denied|disabled|unavailable|failed|error)/i,
  /(?:api|access) key.*(?:invalid|missing|expired|disabled|unauthorized)/i,
  /billing.*(?:disabled|denied|required|unavailable)/i,
];

// Runtime and database failures are bugs or outages, not something the user
// can act on, and their text names internal fields, tables and code.
const INTERNAL_FAILURE_PATTERNS = [
  /\bcannot read propert(?:y|ies) of (?:undefined|null)\b/i,
  /\bis not a function\b/i,
  /^(?:TypeError|ReferenceError|SyntaxError|RangeError)\b/,
  /\bunexpected token\b.*\bJSON\b/i,
  /\bviolates (?:foreign key|unique|not-null|check) constraint\b/i,
  /\bduplicate key value\b/i,
  /\b(?:relation|column) "[^"]+" (?:of relation "[^"]+" )?does not exist\b/i,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/,
  // Serialized schema-validation issues (Zod) name internal fields and paths.
  /^\s*\[\s*\{\s*"(?:expected|code|origin|path|message)"\s*:/,
  /"code"\s*:\s*"(?:invalid_type|invalid_union|invalid_value|unrecognized_keys|too_small|too_big)"/,
];

const ERROR_FIELD_NAMES = new Set([
  'error',
  'error_message',
  'errormessage',
  'execution_error',
  'executionerror',
  'last_error',
  'lasterror',
]);

export function isInternalFailure(value: unknown): boolean {
  if (value == null) return false;
  const text = value instanceof Error ? value.message : String(value);
  return INTERNAL_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isProviderInfrastructureError(value: unknown): boolean {
  if (value == null) return false;
  const text = value instanceof Error ? value.message : String(value);
  return PROVIDER_INFRASTRUCTURE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Keep validation and business errors actionable, but never expose provider
 * billing, credential, project, quota, or model infrastructure details, or
 * internal runtime and database failures.
 */
export function toUserFacingError(
  value: unknown,
  fallback = 'This action could not be completed. Please try again.',
): string {
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  if (!text.trim()) return fallback;
  if (isProviderInfrastructureError(text)) return AI_SERVICE_UNAVAILABLE_MESSAGE;
  if (isInternalFailure(text)) return fallback;
  return text.length > 2_000 ? `${text.slice(0, 1_997)}...` : text;
}

/** A user-facing error for the middle of a sentence, without its own full stop. */
export function userFacingReason(value: unknown, fallback = 'something went wrong on our side'): string {
  return toUserFacingError(value, fallback).replace(/[.!\s]+$/, '');
}

// A serialized Zod issue list embedded in prose, e.g.
// "❌ Email template was not generated. [{"expected":"string","code":"invalid_type",...}]".
const SERIALIZED_ISSUE_LIST = /\[\s*\{\s*"(?:expected|code|origin|path|message)"\s*:[\s\S]*?\}\s*\]/g;
const ISSUE_CODE = /"code"\s*:\s*"[a-z_]+"/;

// The server registers one that swaps its own internal names (tool names,
// workflow and actor IDs) for plain words. Shared code cannot list them.
let technicalTermScrubber: ((content: string) => string) | null = null;

export function registerTechnicalTermScrubber(scrubber: (content: string) => string): void {
  technicalTermScrubber = scrubber;
}

/** Tool call/result receipts are paired by the app using the tool name in them. */
export function isToolReceiptMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const record = metadata as Record<string, unknown>;
  return record.isToolCall === true || record.isToolResult === true;
}

/** Chat content can contain full catalogs and reports, not just short errors. */
export function sanitizeAssistantContent(content: string, metadata?: unknown): string {
  if (typeof content !== 'string') return content;
  if (isProviderInfrastructureError(content)) return AI_SERVICE_UNAVAILABLE_MESSAGE;
  const withoutIssueLists = content.replace(SERIALIZED_ISSUE_LIST, (issues) => (
    ISSUE_CODE.test(issues) ? 'Generation did not complete.' : issues
  ));
  if (!technicalTermScrubber || isToolReceiptMetadata(metadata)) return withoutIssueLists;
  try {
    return technicalTermScrubber(withoutIssueLists);
  } catch {
    return withoutIssueLists;
  }
}

/** Sanitize error-bearing fields without changing successful tool output. */
export function sanitizeErrorFields<T>(value: T, seen = new WeakSet<object>()): T {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeErrorFields(item, seen)) as T;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    const hasErrorValue = child != null && String(child).trim().length > 0;
    sanitized[key] = ERROR_FIELD_NAMES.has(normalizedKey) && hasErrorValue
      ? toUserFacingError(child)
      : sanitizeErrorFields(child, seen);
  }
  return sanitized as T;
}
