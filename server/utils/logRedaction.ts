const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:password(?:hash)?|passphrase|secret|token|authorization|cookie|session|credential|private[_-]?key|api[_-]?key|client[_-]?secret|email|phone|address|ipAddress)$/i;

/** Shared credential primitive; each diagnostic surface retains its own PII policy and size bound. */
export function redactCredentialText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED)
    .replace(/\b(?:(?:sk|pk|rk|whsec|GOCSPX)[-_]|apify_api_|re_)[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/([?&](?:[a-z_]*(?:token|key|secret|password|signature)|code)=)[^&#\s]+/gi, `$1${REDACTED}`)
    .replace(/\b(?:password|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, REDACTED)
    .replace(/\b((?:postgres(?:ql)?|rediss?|https?):\/\/)[^/\s@]+:[^@\s]+@/gi, `$1${REDACTED}@`);
}

export function redactLogText(value: string): string {
  return redactCredentialText(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/(?:\/Users|\/home)\/[^/\s]+\//g, '/home/[USER]/')
    .slice(0, 8000);
}

export function redactLogValue(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key) && value !== null && value !== undefined && value !== '') return REDACTED;
  if (/^(err|error)$/i.test(key) && typeof value === 'string') return REDACTED;
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return redactLogText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactLogValue(item, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 150).map(([childKey, child]) => [
      childKey,
      redactLogValue(child, childKey, depth + 1),
    ]));
  }
  return value;
}

/** Final serialized boundary, so child bindings and every log sink are covered. */
export function redactedLogDestination(destination: { write(value: string): unknown; lastLevel?: number }) {
  return { write(chunk: string | Buffer) {
    for (const line of String(chunk).split('\n')) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        // Pino sets this routing metadata on its direct destination. Forward it
        // through the sanitizer so multistream does not silently drop records.
        if (typeof record.level === 'number') destination.lastLevel = record.level;
        destination.write(`${JSON.stringify(redactLogValue(record))}\n`);
      }
      catch { destination.write('{"level":40,"msg":"Log record omitted: invalid or unavailable destination"}\n'); }
    }
  } };
}
