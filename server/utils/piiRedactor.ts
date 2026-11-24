/**
 * PII Redaction (H6)
 *
 * Lightweight redactor used to strip personally-identifiable information from
 * lead/contact context BEFORE it is sent to an LLM for smart-reply generation.
 * Goal: prevent leaking customer email addresses, phone numbers, credit-card
 * numbers, etc. into a reply that may go to other recipients in the thread.
 *
 * Conservative regex-only approach. We do not aim for 100% recall — the input
 * is already structured (lead.email, lead.phone) so we know what's likely PII.
 */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\b(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// 13–19 digit numbers that could be a credit-card; allows spaces or dashes
const CREDIT_CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;
// IPv4 addresses
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export interface RedactPiiOptions {
  /** When true, replace with token-style markers like [EMAIL] (default true). */
  marker?: boolean;
}

export function redactPii(input: string | null | undefined, options: RedactPiiOptions = {}): string {
  if (!input) return '';
  const marker = options.marker !== false;
  return String(input)
    .replace(EMAIL_RE, marker ? '[EMAIL]' : '')
    .replace(SSN_RE, marker ? '[SSN]' : '')
    .replace(CREDIT_CARD_RE, (m) => {
      // Only redact if the digit-only count is in 13–19 range (real card lengths)
      const digits = m.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19) return m;
      return marker ? '[CARD]' : '';
    })
    .replace(PHONE_RE, marker ? '[PHONE]' : '')
    .replace(IPV4_RE, marker ? '[IP]' : '');
}

