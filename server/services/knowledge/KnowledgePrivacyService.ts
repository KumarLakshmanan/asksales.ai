import crypto from 'crypto';
import { redactPiiWithStableTokens } from '../agents/orchestration/PrivacyVaultService.js';
import { maskVerifiedBusinessContacts } from './KnowledgeBusinessContacts.js';

export type KnowledgePrivacyClassification =
  | 'public'
  | 'business'
  | 'internal'
  | 'personal'
  | 'restricted'
  | 'secret';

export interface KnowledgePrivacyScan {
  classification: KnowledgePrivacyClassification;
  searchText: string;
  containsPersonalData: boolean;
  mustQuarantine: boolean;
  reasons: string[];
  injectionFlags: string[];
  exactIdentifiers: string[];
  contentHash: string;
}

const SECRET_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { code: 'password_assignment', pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*[^\s]{6,}/i },
  { code: 'api_secret', pattern: /\b(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*[A-Za-z0-9_\-.]{12,}/i },
  { code: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9_\-.=]{16,}/i },
  { code: 'payment_card', pattern: /\b(?:\d[ -]*?){13,19}\b/ },
];

const INJECTION_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: 'ignore_instructions', pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?\b/i },
  { code: 'prompt_override', pattern: /\b(?:override|replace|bypass)\s+(?:the\s+)?(?:system|safety|policy|guardrail|instructions?)\b/i },
  { code: 'prompt_exfiltration', pattern: /\b(?:reveal|print|repeat|expose)\s+(?:the\s+)?(?:system prompt|hidden prompt|developer message|secrets?)\b/i },
  { code: 'tool_directive', pattern: /\b(?:call|invoke|execute)\s+(?:the\s+)?(?:tool|function|command)\b/i },
  { code: 'role_reassignment', pattern: /\byou are now\b|\bact as (?:a|an)\b/i },
];

const IDENTIFIER_PATTERN = /\b(?=[A-Z0-9_-]{4,32}\b)(?=[A-Z0-9_-]*[A-Z])(?=[A-Z0-9_-]*\d)[A-Z0-9]+(?:[-_][A-Z0-9]+)+\b/g;

// A sentence full stop may follow; a fifth numeric part may not.
const DOTTED_QUAD = /(?<!\d|\d\.)(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g;

/** Business documentation routinely contains LAN setup addresses (router
 * pages, printers) and four-part version numbers. Neither identifies a
 * person, so only the knowledge classifier exempts them; customer-message
 * redaction keeps treating every dotted quad as an IP address. */
export function isNonPersonalDottedQuad(value: string, precedingText = ''): boolean {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet))) return false;
  if (octets.some(octet => octet > 255)) return true;
  if (/\b(?:version|ver\.?|firmware|build|release|v)\s*[:#]?\s*$/i.test(precedingText.slice(-24))) return true;
  const [a, b, c] = octets;
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

function maskNonPersonalDottedQuads(text: string) {
  const restorations: Array<[string, string]> = [];
  const masked = text.replace(DOTTED_QUAD, (match, offset: number) => {
    if (!isNonPersonalDottedQuad(match, text.slice(Math.max(0, offset - 24), offset))) return match;
    // Letters only: a digit-bearing marker could itself resemble a phone or card number.
    const marker = `[NETWORK_VALUE_${Array.from(crypto.randomBytes(10), byte => String.fromCharCode(97 + (byte % 26))).join('')}]`;
    restorations.push([marker, match]);
    return marker;
  });
  return { masked, restore: (value: string) => restorations.reduce((current, [marker, original]) => current.split(marker).join(original), value) };
}

/** Redact published knowledge text with the same exemptions the classifier
 * applied when it was approved: verified business contacts and non-personal
 * network or version values. */
export function redactKnowledgeText(text: string, trustedBusinessContacts: readonly string[] = []): string {
  return knowledgeRedaction(text, trustedBusinessContacts).text;
}

function knowledgeRedaction(text: string, trustedBusinessContacts: readonly string[]) {
  const network = maskNonPersonalDottedQuads(text);
  const contacts = maskVerifiedBusinessContacts(network.masked, trustedBusinessContacts);
  const result = redactPiiWithStableTokens(contacts.masked);
  return { text: network.restore(contacts.restore(result.redactedText)), piiTypes: result.piiTypes };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function scanKnowledgeContent(content: string, options: { trustedBusinessContacts?: readonly string[] } = {}): KnowledgePrivacyScan {
  const normalized = content.replace(/\r\n/g, '\n').split('\u0000').join('').trim();
  const contacts = options.trustedBusinessContacts || [];
  const redaction = knowledgeRedaction(normalized, contacts);
  const redacted = redaction.text;
  const containsPersonalData = redacted !== normalized;
  const maskedContacts = maskVerifiedBusinessContacts(normalized, contacts).masked;
  const secretMatches = SECRET_PATTERNS.filter(({ code, pattern }) => pattern.test(code === 'payment_card' ? maskedContacts : normalized)).map(({ code }) => code);
  const injectionFlags = INJECTION_PATTERNS.filter(({ pattern }) => pattern.test(normalized)).map(({ code }) => code);
  const exactIdentifiers = unique(normalized.toUpperCase().match(IDENTIFIER_PATTERN) || []);
  const reasons: string[] = [];

  if (secretMatches.length) reasons.push(...secretMatches.map((code) => `secret:${code}`));
  if (injectionFlags.length) reasons.push(...injectionFlags.map((code) => `injection:${code}`));
  // The detected kinds let the owner find what to correct; values are never stored.
  if (containsPersonalData) reasons.push('personal_data_detected', ...redaction.piiTypes.map(type => `personal_data:${type}`));

  let classification: KnowledgePrivacyClassification = 'business';
  if (secretMatches.length) classification = 'secret';
  else if (injectionFlags.length) classification = 'restricted';
  else if (containsPersonalData) classification = 'personal';

  return {
    classification,
    searchText: redacted,
    containsPersonalData,
    // Secrets and instruction-like source poisoning never reach publication or
    // an external embedding provider. Personal data is de-identified first and
    // remains reviewable under the governed publication workflow.
    mustQuarantine: secretMatches.length > 0 || injectionFlags.length > 0,
    reasons,
    injectionFlags,
    exactIdentifiers,
    contentHash: crypto.createHash('sha256').update(normalized).digest('hex'),
  };
}

export function fingerprintKnowledgeQuery(query: string): string {
  const safe = redactPiiWithStableTokens(query).redactedText.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(safe).digest('hex');
}

export function extractExactIdentifiers(query: string): string[] {
  return unique(query.toUpperCase().match(IDENTIFIER_PATTERN) || []);
}

/** Last-mile defense for old indexed rows and independently invoked consumers. */
export function safeKnowledgeText(text: string, trustedBusinessContacts: readonly string[] = []): string | null {
  const scan = scanKnowledgeContent(text, { trustedBusinessContacts });
  return scan.mustQuarantine ? null : scan.searchText;
}
