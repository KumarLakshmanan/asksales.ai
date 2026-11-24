import crypto from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import { outreachMessagesTable } from '../../../models/outreachConversations/schema.js';
import { supportPrivacyVaultTable, supportPrivacyAccessLogsTable, type PiiType } from '../../../models/supportOrchestration/schema.js';
import { logger } from '../../../utils/logger.js';

const DEFAULT_RAW_RETENTION_DAYS = 30;
const KEY_VERSION = Math.max(1, Number.parseInt(process.env.SUPPORT_PII_KEY_VERSION || '1', 10) || 1);
const ephemeralTokenKey = crypto.randomBytes(32);

interface DetectedValue {
  type: PiiType;
  value: string;
  start: number;
  end: number;
}

export interface RedactionResult {
  redactedText: string;
  piiTypes: PiiType[];
  tokenCount: number;
}

export interface StructuredModelSanitization {
  value: unknown;
  piiTypes: string[];
}

export const MODEL_SECRET_KEY = /(?:^|_)(?:token|secret|password|passphrase|passcode|credentials?|authorization|cookie|api_?key|otp|pin|(?:verification|security|login|one_?time|mfa|2fa)_?code)(?:$|_)/i;
const MODEL_DIRECT_KEY = /(?:^|_)(?:email|phone|mobile|name|full_?name|first_?name|last_?name|address|sender(?:_identifier)?)(?:$|_)/i;
const MODEL_COMPANY_KEY = /(?:^|_)(?:company|organization|organisation)(?:$|_)/i;

/** Redacts structured model inputs without mutating the operational object.
 * Raw identifiers remain available only to server-side delivery/tool adapters. */
export function sanitizeStructuredForModel(value: unknown): StructuredModelSanitization {
  const piiTypes = new Set<string>();
  const counters = new Map<string, number>();
  const token = (type: string) => {
    const next = (counters.get(type) || 0) + 1;
    counters.set(type, next);
    piiTypes.add(type.toLowerCase());
    return `[${type}_${next}]`;
  };
  const walk = (current: unknown, key = '', depth = 0): unknown => {
    if (depth > 8) return '[TRUNCATED_STRUCTURED_CONTEXT]';
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (current !== null && current !== undefined && MODEL_SECRET_KEY.test(normalizedKey)) {
      piiTypes.add('credential');
      return '[REDACTED_SECRET]';
    }
    if (typeof current === 'string') {
      if (MODEL_COMPANY_KEY.test(normalizedKey)) return token('COMPANY');
      if (MODEL_DIRECT_KEY.test(normalizedKey)) {
        const type = normalizedKey.includes('email') ? 'EMAIL'
          : normalizedKey.includes('phone') || normalizedKey.includes('mobile') || normalizedKey.includes('sender') ? 'PHONE'
            : normalizedKey.includes('address') ? 'ADDRESS' : 'NAME';
        return token(type);
      }
      const redacted = redactPiiWithStableTokens(current.slice(0, 20_000));
      redacted.piiTypes.forEach((type) => piiTypes.add(type));
      return redacted.redactedText;
    }
    if (Array.isArray(current)) return current.slice(0, 100).map((item) => walk(item, key, depth + 1));
    if (current && typeof current === 'object') {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>).slice(0, 100)
        .map(([childKey, child]) => [childKey, walk(child, childKey, depth + 1)]));
    }
    return current;
  };
  return { value: walk(value), piiTypes: [...piiTypes] };
}

export interface ProtectInboundInput {
  userId: number;
  conversationId: number;
  channel: string;
  rawText: string;
  providerMessageId?: string;
  messageId?: number;
  sentMessageId?: number;
  entityType?: 'outreach_message' | 'widget_message' | 'widget_profile' | 'support_ticket_message';
  entityId?: number;
  retentionDays?: number;
}

export interface ProtectedInbound extends RedactionResult {
  vaultId: number | null;
}

/** How a pattern's capture is turned into the redacted span. Patterns without
 * a mode redact the first capture group (name/address) or the whole match. */
type PatternMode = 'weakName' | 'strongName' | 'nameHere' | 'disclosedAddress';

const NAME_WORD = String.raw`[\p{L}\p{M}][\p{L}\p{M}'’-]*`;
const NAME_WORDS = String.raw`${NAME_WORD}(?:[\t ]+${NAME_WORD}){0,3}`;

const PATTERNS: Array<{ type: PiiType; regex: RegExp; mode?: PatternMode }> = [
  { type: 'name', regex: /(?:^|\n)[\t ]*(?:full[\t ]*name|first[\t ]*name|last[\t ]*name|guest[\t ]*name|customer[\t ]*name|name)[\t ]*[:=][\t ]*([^\r\n;]{1,150})/giu },
  { type: 'address', regex: /(?:^|\n)[\t ]*(?:postal|home|residential|shipping|billing|street)?[\t ]*address[\t ]*[:=][\t ]*([^\r\n;]{3,300})/giu },
  // "I live at 12 MG Road Bangalore" / "my address is ...": up to the end of
  // the sentence or line. A full stop only ends the address when it is not part
  // of an initialism or a leading abbreviation ("M.G. Road", "St. Mary's Road").
  { type: 'address', mode: 'disclosedAddress', regex: /\b(?:i[\t ]+(?:live|stay|reside)[\t ]+at|(?:my|our)[\t ]+(?:(?:home|current|postal|permanent|residential|shipping|billing|delivery|mailing)[\t ]+)?address[\t ]+is)[\t ]*[:-]?[\t ]+((?:[^\r\n!?;.]|\.(?=\S)|(?<=\.\p{Lu})\.|(?<=\b(?:St|No|Opp|Nr|Mt))\.){3,300})/giu },
  { type: 'government_id', regex: /\b(?:aadhaar|aadhar|pan(?:[\t ]*card)?)[\t ]*(?:number|no\.?|#)?[\t ]*[:=]?[\t ]*(?:[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}|[A-Z]{5}\d{4}[A-Z])\b/gi },
  { type: 'email', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  // A bare nine-digit run is far more often a booking/order reference than an
  // SSN, so it needs SSN-style separators or an explicit label.
  { type: 'ssn', regex: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g },
  { type: 'ssn', regex: /(?<=\b(?:ssn|social[\t ]+security)(?:[\t ]*(?:number|no\.?|#))?[\t ]*(?:(?:is|was)\b|[:=#-])?[\t ]*)\d{9}\b/gi },
  { type: 'payment_card', regex: /\b(?:\d[ -]*?){13,19}\b/g },
  { type: 'ip_address', regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { type: 'government_id', regex: /\b(?:passport|driver(?:'s)?\s*licen[cs]e|national\s*id|itin|nin)\s*(?:number|no\.?|#|is|:)\s*[A-Z0-9-]{5,20}\b/gi },
  { type: 'phone', regex: /(?<![\w\d])(?:\+?91[\t .-]?)?[6-9]\d{4}[\t .-]\d{5}(?![\w\d])/g },
  { type: 'phone', regex: /(?<!\w)(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}(?!\w)/g },
  // Conversational self-introductions. The prefix is case-insensitive; the
  // candidate words sit in a lookahead (so a rejected candidate cannot swallow a
  // later prefix) and are validated word by word in conversationalNameLength.
  { type: 'name', mode: 'strongName', regex: new RegExp(String.raw`\bmy[\t ]+(?:full[\t ]+)?name(?:[\t ]+is|['’]s)(?=([\t ]+)(${NAME_WORDS}))`, 'giu') },
  { type: 'name', mode: 'weakName', regex: new RegExp(String.raw`\b(?:i[\t ]+am|i['’]m|this[\t ]+is|call[\t ]+me)(?=([\t ]+)(${NAME_WORDS}))`, 'giu') },
  // "Ravi here, need 2 deluxe rooms" at the start of a message or sentence.
  { type: 'name', mode: 'nameHere', regex: new RegExp(String.raw`(?<=(?:^|[.!?\n])[\t ]*(?:(?:hi+|hello|hey|namaste)[,!]?[\t ]+)?)(${NAME_WORDS})(?=[\t ]+here\b(?![\t ]+(?:is|are|was|were|isn['’]?t|aren['’]?t|has|have|had|will|would|can|could|should|does|do|did|seems?|looks?|we|i|you|they|it|to|in|at)\b))`, 'giu') },
];

const TITLECASE_WORD = /^\p{Lu}[\p{Ll}\p{M}'’-]*(?:\p{Lu}[\p{Ll}\p{M}'’-]+)*$/u;

/** Words that end a conversational name: "my name is ravi and i need a room". */
const NAME_STOP_WORDS = new Set([
  'a', 'about', 'again', 'also', 'am', 'an', 'and', 'are', 'as', 'at', 'because', 'been', 'booked', 'booking',
  'but', 'by', 'called', 'calling', 'can', 'checking', 'contacting', 'could', 'did', 'do', 'does', 'for', 'from',
  'had', 'has', 'have', 'having', 'he', 'hello', 'here', 'hi', 'how', 'i', "i'd", "i'll", "i'm", "i've", 'if',
  'in', 'interested', 'is', 'it', 'just', 'like', 'looking', 'me', 'messaging', 'my', 'need', 'needs', 'not',
  'of', 'on', 'or', 'our', 'please', 'pls', 'plz', 'regarding', 'she', 'so', 'speaking', 'staying', 'thanks',
  'that', 'the', 'there', 'they', 'this', 'to', 'trying', 'visiting', 'want', 'wanted', 'wants', 'was', 'we',
  'were', 'what', 'when', 'where', 'who', 'will', 'with', 'would', 'writing', 'you', 'your',
]);
/** Stop words that are also ordinary given names or surnames; when written in
 * Titlecase inside a name ("Kim So Hyun", "Ravi A Kumar") they do not end it. */
const NAME_AMBIGUOUS_STOP_WORDS = new Set(['a', 'an', 'can', 'so', 'will']);
/** "my name is the same as on the booking" is a statement, not a disclosure. */
const STRONG_NAME_FIRST_WORD_REJECT = new Set([
  'about', 'already', 'also', 'and', 'as', 'but', 'different', 'for', 'in', 'incorrect', 'is', 'listed',
  'mentioned', 'misspelled', 'missing', 'my', 'of', 'or', 'regarding', 'registered', 'same', 'shown', 'spelled',
  'spelt', 'that', 'the', 'this', 'to', 'with', 'written', 'wrong',
]);
const NON_NAME_COMPLEMENTS = new Set([
  'afraid', 'at', 'available', 'back', 'confident', 'delighted', 'excited',
  'fine', 'glad', 'good', 'great', 'happy', 'here', 'later', 'not', 'now',
  'okay', 'ok', 'on', 'pleased', 'proud', 'ready', 'sorry', 'thrilled',
  'still', 'today', 'tomorrow', 'unable', 'unhappy', 'via', 'well', 'working',
  'planning', 'interested',
]);
/** "Right here", "Over here", "Food here ..." are not "<Name> here". */
const NAME_HERE_EXCLUDED = new Set([
  'all', 'almost', 'already', 'anybody', 'anyone', 'back', 'click', 'come', 'down', 'everybody', 'everyone',
  'everything', 'food', 'get', 'got', 'hotel', 'issue', 'live', 'lives', 'living', 'look', 'new', 'no', 'nobody',
  'nothing', 'now', 'ok', 'okay', 'only', 'out', 'over', 'payment', 'press', 'problem', 'reply', 'right', 'room',
  'rooms', 'see', 'service', 'sign', 'somebody', 'someone', 'staff', 'start', 'stay', 'stays', 'still', 'tap',
  'type', 'up', 'wait', 'waiting', 'weather', 'wifi', 'write', 'yes',
]);
const GREETING_WORDS = /^(?:hi+|hello|hey|namaste)$/i;
const ADDRESS_FIRST_WORD_REJECT = new Set([
  'a', 'above', 'already', 'an', 'as', 'attached', 'below', 'changed', 'correct', 'different', 'given', 'here',
  'home', 'in', 'incorrect', 'mentioned', 'missing', 'my', 'night', 'not', 'on', 'our', 'present', 'same', 'that',
  'the', 'there', 'this', 'updated', 'wrong', 'your',
]);
/** Where an address disclosure runs into the next clause of the sentence. */
const ADDRESS_TAIL = /[\t ]+(?:and|but|so)[\t ]+(?:my|i|i['’]m|we|our|please|can|could|would|need|want|the)\b|[,\t ]+(?:please|pls|plz|thanks|thank[\t ]+you)\b/iu;

const normalizeWord = (word: string) => word.replace(/’/g, "'").toLocaleLowerCase();

function isNameStopWord(word: string, next?: string): boolean {
  const lower = normalizeWord(word);
  if (!NAME_STOP_WORDS.has(lower)) return false;
  // A capital "I" is the pronoun when a lowercase word follows ("Ravi I need"),
  // otherwise it is treated as an initial ("Ravi I Kumar").
  if (word === 'I') return next !== undefined && /^\p{Ll}/u.test(next);
  if (NAME_AMBIGUOUS_STOP_WORDS.has(lower) && TITLECASE_WORD.test(word)) return false;
  return true;
}

/** Length of the leading part of `capture` that is a person name, or 0.
 * Weak prefixes ("I am", "this is", "call me") only introduce a name when the
 * words are Titlecase; "my name is" accepts any case. Both stop at the first
 * function word so the rest of the sentence keeps its meaning. */
function conversationalNameLength(capture: string, mode: 'weakName' | 'strongName'): number {
  const words = [...capture.matchAll(new RegExp(NAME_WORD, 'gu'))];
  if (words.length === 0) return 0;
  const first = words[0][0];
  const firstLower = normalizeWord(first);
  if (NON_NAME_COMPLEMENTS.has(firstLower)) return 0;
  if (mode === 'weakName') {
    if (!TITLECASE_WORD.test(first) || (NAME_STOP_WORDS.has(firstLower) && firstLower !== 'will')) return 0;
  } else if (STRONG_NAME_FIRST_WORD_REJECT.has(firstLower)) {
    return 0;
  }
  let kept = 1;
  for (; kept < words.length; kept += 1) {
    const word = words[kept][0];
    if (mode === 'weakName' && !TITLECASE_WORD.test(word)) break;
    if (isNameStopWord(word, words[kept + 1]?.[0])) break;
  }
  const last = words[kept - 1];
  return last.index! + last[0].length;
}

/** Booking, order and invoice numbers are not phone numbers, and neither is a
 * year followed by four more digits ("arriving 2026 1114"). Anything written
 * in an explicit phone format (+country code, parentheses) stays a phone. */
const REFERENCE_NUMBER_LABEL = /(?<![\p{L}\p{N}])(?:booking|reservation|reference|ref|order|invoice|confirmation|pnr|ticket|tracking|transaction|txn|receipt|folio|voucher|id)(?:[\t ]*(?:id|no|number|num|code|ref|reference)\b)?\.?[\t ]*(?:(?:is|was)\b|[:#=-])?[\t ]*#?[\t ]*$/iu;
const PHONE_ID_LABEL = /(?:whatsapp|wa|phone|mobile|cell|contact|caller|telegram|viber|signal)[\t ]+id\W*$/i;

function isNonPhoneNumber(text: string, value: string, start: number): boolean {
  if (/[+(]/.test(value)) return false;
  if (/^(?:19|20)\d{2}[\t .-]\d{4}$/.test(value)) return true;
  const before = text.slice(Math.max(0, start - 48), start);
  return REFERENCE_NUMBER_LABEL.test(before) && !PHONE_ID_LABEL.test(before);
}

/** Resolves the redacted span for the context-dependent patterns. */
function resolveModeSpan(mode: PatternMode, match: RegExpMatchArray): { start: number; value: string } | null {
  const index = match.index!;
  if (mode === 'weakName' || mode === 'strongName') {
    const length = conversationalNameLength(match[2], mode);
    // The name sits in a lookahead, so it starts after the prefix and its gap.
    return length ? { start: index + match[0].length + match[1].length, value: match[2].slice(0, length) } : null;
  }
  if (mode === 'nameHere') {
    const words = [...match[1].matchAll(new RegExp(NAME_WORD, 'gu'))];
    while (words.length > 0 && GREETING_WORDS.test(words[0][0])) words.shift();
    if (words.length === 0 || words.length > 3) return null;
    for (const [word] of words) {
      const lower = normalizeWord(word);
      if (!TITLECASE_WORD.test(word) || NAME_HERE_EXCLUDED.has(lower) || NAME_STOP_WORDS.has(lower)
        || NON_NAME_COMPLEMENTS.has(lower)) return null;
    }
    const offset = words[0].index!;
    return { start: index + offset, value: match[1].slice(offset) };
  }
  const tail = match[1].search(ADDRESS_TAIL);
  const value = (tail >= 0 ? match[1].slice(0, tail) : match[1]).replace(/[\s,]+$/, '');
  const firstWord = normalizeWord(value.split(/[\s,]+/)[0] || '');
  if (value.length < 3 || ADDRESS_FIRST_WORD_REJECT.has(firstWord)) return null;
  // "I stay at <hotel/resort ...>" describes a booking, not a home address.
  if (/\bstay[\t ]+at\b/i.test(match[0]) && /\b(?:hotels?|resorts?|inn|lodge|hostel|villa|property|rooms?|suites?)\b/i.test(value)) return null;
  return { start: index + match[0].length - match[1].length, value };
}

const CREDENTIAL_LABEL = String.raw`(?:password|passphrase|passcode|(?:api|secret|private|recovery)[\s_-]*key|client[\s_-]*secret|(?:access|auth(?:entication)?|session|bearer)[\s_-]*token|PIN)`;
const OTP_LABEL = String.raw`(?:OTP|one[\s-]*time[\s-]*(?:password|passcode|code)|(?:verification|security|login|authentication|MFA|2FA)[\s-]*code)`;
const DISCLOSURE_SEPARATOR = String.raw`(?:[\t ]*(?:(?:is now|is|was|equals?)\b[\t ]*[:=]?[\t ]*|[:=][\t ]*)|[\t ]+)`;
const SECRET_VALUE = String.raw`(?:"([^"\r\n]{1,256})"|'([^'\r\n]{1,256})'|\x60([^\x60\r\n]{1,256})\x60|([^\s<>"'\x60,;]{1,256}))`;
const CREDENTIAL_DISCLOSURE_RE = new RegExp(String.raw`\b${CREDENTIAL_LABEL}\b["']?${DISCLOSURE_SEPARATOR}${SECRET_VALUE}`, 'gi');
const OTP_DISCLOSURE_RE = new RegExp(String.raw`\b${OTP_LABEL}\b["']?${DISCLOSURE_SEPARATOR}(?:["'\x60])?(\d(?:[\t -]?\d){3,9}|[A-Z0-9]{4,16})(?:["'\x60])?`, 'gi');
const SECRET_STATUS_WORDS = /^(?:not|incorrect|invalid|wrong|expired|expires|missing|forgotten|unknown|strong|secure|reset|changed|required|unavailable|working|broken|please|policy|protection|length|never|too|very|the|a|an|your|my|their|our)$/i;

/** Context is required for short credentials/codes: arbitrary dates, room
 * counts, booking references and catalog codes are not authentication secrets. */
function collectCredentialMatches(text: string): DetectedValue[] {
  const result: DetectedValue[] = [];
  for (const [type, regex] of [['credential', CREDENTIAL_DISCLOSURE_RE], ['otp', OTP_DISCLOSURE_RE]] as const) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const value = type === 'otp' ? match[1] : match.slice(1).find(part => part !== undefined);
      if (!value || match.index === undefined || SECRET_STATUS_WORDS.test(value.replace(/[.!?]+$/, ''))) continue;
      const offset = match[0].lastIndexOf(value);
      const start = match.index + offset;
      const end = start + value.length;
      if (/^\d+$/.test(value) && /^\s+(?:characters?|digits?|minutes?|seconds?)\b/i.test(text.slice(end))) continue;
      result.push({ type, value, start, end });
    }
  }
  // An Authorization header is itself an unambiguous credential context.
  for (const match of text.matchAll(/\b(?:authorization\s*[:=]\s*)?Bearer\s+([A-Za-z0-9._~+/-]{8,}={0,2})/gi)) {
    const start = match.index! + match[0].lastIndexOf(match[1]);
    result.push({ type: 'credential', value: match[1], start, end: start + match[1].length });
  }
  const phraseRegex = new RegExp(String.raw`\b(?:password|passphrase)\b${DISCLOSURE_SEPARATOR}([^\r\n]{1,256}?)(?=[,;]|\.(?:\s|$)|[!?](?:\s|$)|\s+(?:and|but|please|then)\b|$)`, 'gi');
  for (const match of text.matchAll(phraseRegex)) {
    const value = match[1].trim();
    if (!value || SECRET_STATUS_WORDS.test(value.split(/\s+/)[0])) continue;
    const start = match.index! + match[0].lastIndexOf(value);
    result.push({ type: 'credential', value, start, end: start + value.length });
  }
  const reverseOtpRegex = new RegExp(String.raw`\b(\d(?:[\t -]?\d){3,9}|[A-Z0-9]{4,16})\s+is\s+(?:(?:your|my|the)\s+)?${OTP_LABEL}\b`, 'gi');
  for (const match of text.matchAll(reverseOtpRegex)) {
    if (SECRET_STATUS_WORDS.test(match[1])) continue;
    result.push({ type: 'otp', value: match[1], start: match.index!, end: match.index! + match[1].length });
  }
  return result;
}

/** Server-only output protection for an unlabeled echo of a disclosed secret.
 * The source must be the current tenant-authorized inbound message, never a
 * model-controlled source or another conversation's private record. */
export function redactCredentialEchoes(text: string, source: string): string {
  let safe = text;
  const values = [...new Set(collectCredentialMatches(source).flatMap(match => [match.value,
    match.value.replace(/^["'`]|["'`.!?]+$/g, ''),
  ]).filter(value => value.length > 1))].sort((a, b) => b.length - a.length);
  for (const value of values) {
    safe = safe.split(value).join('[REDACTED_SECRET]');
    const compact = value.replace(/[\t -]/g, '');
    if (/^\d{4,10}$/.test(compact)) {
      safe = safe.replace(new RegExp(`(?<!\\d)${compact.split('').join('[\\t -]?')}(?!\\d)`, 'g'), '[REDACTED_SECRET]');
    }
  }
  return safe;
}

function normalizeCardCandidate(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function collectMatches(text: string, visibleEmailContacts = false): DetectedValue[] {
  const matches: DetectedValue[] = collectCredentialMatches(text);
  for (const { type, regex, mode } of PATTERNS) {
    if (visibleEmailContacts && (type === 'name' || type === 'email')) continue;
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      if (match.index === undefined) continue;
      let value: string;
      let start: number;
      if (mode) {
        // The redacted value is only part of the capture (a truncated name, a
        // trimmed address), so its offset comes from the capture group itself.
        const span = resolveModeSpan(mode, match);
        if (!span) continue;
        ({ value, start } = span);
      } else {
        value = (type === 'name' || type === 'address') && match[1] ? match[1] : match[0];
        start = match.index + (type === 'name' || type === 'address' ? match[0].lastIndexOf(value) : 0);
        // Labelled names ("Name: ...") share the ambiguity of the conversational
        // prefixes ("I am good"): do not turn common predicate/adverb
        // complements into person-name tokens.
        if (type === 'name' && NON_NAME_COMPLEMENTS.has(value.trim().split(/\s+/)[0].toLocaleLowerCase())) continue;
      }
      if (/^\[[A-Z_]+_\d+\]$/.test(value.trim())) continue;
      const end = start + value.length;
      if (type === 'payment_card' && !normalizeCardCandidate(value)) continue;
      if (type === 'phone') {
        const digits = value.replace(/\D/g, '');
        if (digits.length < 7 || digits.length > 15) continue;
        if (isNonPhoneNumber(text, value, start)) continue;
      }
      matches.push({ type, value, start, end });
    }
  }

  // Higher-priority patterns are collected first. Remove overlapping matches so
  // card and government identifiers cannot later be downgraded to phone tokens.
  return matches
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((candidate, index, all) => !all.slice(0, index).some(
      (accepted) => candidate.start < accepted.end && candidate.end > accepted.start,
    ));
}

export function redactPiiWithStableTokens(text: string, scope?: { userId: number; conversationId: number }): RedactionResult {
  if (!text) return { redactedText: '', piiTypes: [], tokenCount: 0 };
  return redactDetectedValues(text, collectMatches(text), scope);
}

/** Human email presentation only. Names and email addresses are operational
 * contact details; other sensitive values remain protected, including secrets.
 * Never use this projection for model input, search, or persisted history. */
export function redactSensitiveInboxEmailText(text: string, scope: { userId: number; conversationId: number }): string {
  return redactDetectedValues(text, collectMatches(text, true), scope).redactedText;
}

function redactDetectedValues(text: string, matches: DetectedValue[], scope?: { userId: number; conversationId: number }): RedactionResult {
  if (!text) return { redactedText: '', piiTypes: [], tokenCount: 0 };
  if (matches.length === 0) return { redactedText: text, piiTypes: [], tokenCount: 0 };

  const counters = new Map<PiiType, number>();
  const identities = new Map<string, string>();
  let cursor = 0;
  let redactedText = '';
  for (const match of matches) {
    redactedText += text.slice(cursor, match.start);
    const normalized = match.type === 'phone' ? match.value.replace(/\D/g, '') : match.value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
    const identity = `${match.type}:${normalized}`;
    let token = identities.get(identity);
    if (!token) {
      const count = (counters.get(match.type) ?? 0) + 1;
      counters.set(match.type, count);
      const key = process.env.SUPPORT_PII_TOKENIZATION_KEY || process.env.SUPPORT_PII_ENCRYPTION_KEY_V1
        || process.env.SUPPORT_PII_ENCRYPTION_KEY || process.env[`SUPPORT_PII_ENCRYPTION_KEY_V${KEY_VERSION}`]
        || process.env.SECRETS_ENCRYPTION_KEY || ephemeralTokenKey;
      const suffix = scope ? BigInt(`0x${crypto.createHmac('sha256', key)
        .update(`${scope.userId}:${scope.conversationId}:${identity}`).digest('hex').slice(0, 12)}`).toString() : String(count);
      token = `[${match.type.toUpperCase()}_${suffix}]`;
      identities.set(identity, token);
    }
    redactedText += token;
    cursor = match.end;
  }
  redactedText += text.slice(cursor);

  return {
    redactedText,
    piiTypes: Array.from(counters.keys()),
    tokenCount: matches.length,
  };
}

function getMasterKey(version = KEY_VERSION): Buffer {
  const configured = process.env[`SUPPORT_PII_ENCRYPTION_KEY_V${version}`] || (version === 1 ? process.env.SUPPORT_PII_ENCRYPTION_KEY
    || process.env.SECRETS_ENCRYPTION_KEY : undefined);
  if (!configured || configured.length < 32) {
    throw new Error('Support PII encryption is not configured with a key of at least 32 characters.');
  }
  return Buffer.from(configured, 'utf8');
}

export function isPrivacyVaultConfigured(): boolean {
  const configured = process.env[`SUPPORT_PII_ENCRYPTION_KEY_V${KEY_VERSION}`] || (KEY_VERSION === 1 ? process.env.SUPPORT_PII_ENCRYPTION_KEY || process.env.SECRETS_ENCRYPTION_KEY : undefined);
  return Boolean(configured && configured.length >= 32);
}

function tenantKey(userId: number, version = KEY_VERSION): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    getMasterKey(version),
    Buffer.from(`support-pii-tenant:${userId}`),
    Buffer.from(`support-pii-v${version}`),
    32,
  ));
}

function purposeKey(userId: number, purpose: string, version = KEY_VERSION): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    getMasterKey(version),
    Buffer.from(`support-restricted-tenant:${userId}`),
    Buffer.from(`support-restricted:${purpose}:v${version}`),
    32,
  ));
}

function encryptWithKey(key: Buffer, plaintext: string): { ciphertext: string; iv: string; authTag: string; keyVersion: number } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: KEY_VERSION,
  };
}

function decryptWithKey(key: Buffer, encrypted: { ciphertext: string; iv: string; authTag: string }): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encrypted.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function encryptRaw(userId: number, plaintext: string) {
  return encryptWithKey(tenantKey(userId), plaintext);
}

function decryptRaw(userId: number, encrypted: { ciphertext: string; iv: string; authTag: string; keyVersion?: number }): string {
  return decryptWithKey(tenantKey(userId, encrypted.keyVersion || 1), encrypted);
}

export interface RestrictedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/** Encrypts resumable runtime state without persisting raw identifiers in JSON columns. */
export function encryptRestrictedPayload(userId: number, purpose: string, value: unknown): RestrictedPayload {
  return encryptWithKey(purposeKey(userId, purpose), JSON.stringify(value));
}

export function decryptRestrictedPayload<T>(userId: number, purpose: string, value: RestrictedPayload): T {
  return JSON.parse(decryptWithKey(purposeKey(userId, purpose, value.keyVersion || 1), value)) as T;
}

/** Stable tenant-bound digest used for equality without lossy redaction collisions. */
export function restrictedBindingDigest(userId: number, purpose: string, value: string): string {
  return `v${KEY_VERSION}:${crypto.createHmac('sha256', purposeKey(userId, purpose)).update(value).digest('hex')}`;
}

export class PrivacyVaultService {
  async reveal(userId: number, vaultId: number, binding: { conversationId: number; messageId?: number; actor: string; purpose: string; memberId?: number }): Promise<{ rawText: string; piiTypes: PiiType[]; expiresAt: Date } | null> {
    if (!binding?.actor?.trim() || !binding?.purpose?.trim() || !Number.isSafeInteger(binding.conversationId)) return null;
    const [record] = await db.select().from(supportPrivacyVaultTable).where(and(
      eq(supportPrivacyVaultTable.id, vaultId),
      eq(supportPrivacyVaultTable.userId, userId),
      ...(binding?.conversationId !== undefined ? [eq(supportPrivacyVaultTable.conversationId, binding.conversationId)] : []),
      ...(binding?.messageId ? [eq(supportPrivacyVaultTable.messageId, binding.messageId)] : []),
    )).limit(1);
    if (!record || record.expiresAt <= new Date()) return null;
    const rawText = decryptRaw(userId, record);
    await db.insert(supportPrivacyAccessLogsTable).values({ userId, vaultId,
      messageId: record.messageId, memberId: binding?.memberId || null, action: 'reveal',
      reason: (binding?.purpose || 'authorized_runtime_processing').slice(0, 240),
      metadata: { actor: binding?.actor || 'system:support', conversationId: record.conversationId, keyVersion: record.keyVersion },
    });
    logger.info({ userId, vaultId, piiTypes: record.piiTypes }, '[PrivacyVault] Restricted raw content revealed');
    return { rawText, piiTypes: record.piiTypes, expiresAt: record.expiresAt };
  }

  async protectInbound(input: ProtectInboundInput): Promise<ProtectedInbound> {
    const redaction = redactPiiWithStableTokens(input.rawText, input);
    const messageId = input.messageId ?? (
      input.entityType === 'widget_message' ? null : await this.findInboundMessageId(input)
    );

    const existing = input.providerMessageId
      ? await db.select({ id: supportPrivacyVaultTable.id })
        .from(supportPrivacyVaultTable)
        .where(and(
          eq(supportPrivacyVaultTable.userId, input.userId),
          eq(supportPrivacyVaultTable.channel, input.channel),
          eq(supportPrivacyVaultTable.providerMessageId, input.providerMessageId),
        ))
        .limit(1)
      : [];

    let vaultId = existing[0]?.id ?? null;
    await db.transaction(async (tx: typeof db) => {
      if (redaction.tokenCount > 0 && !vaultId) {
        const encrypted = encryptRaw(input.userId, input.rawText);
        const retentionDays = Math.max(1, Math.min(input.retentionDays ?? DEFAULT_RAW_RETENTION_DAYS, 90));
        const [vault] = await tx.insert(supportPrivacyVaultTable).values({
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: messageId ?? null,
          channel: input.channel,
          providerMessageId: input.providerMessageId ?? null,
          entityType: input.entityType ?? (messageId ? 'outreach_message' : null),
          entityId: input.entityId ?? messageId ?? null,
          ...encrypted,
          piiTypes: redaction.piiTypes,
          expiresAt: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000),
        }).onConflictDoNothing({
          target: [supportPrivacyVaultTable.businessProfileId,
            supportPrivacyVaultTable.userId,
            supportPrivacyVaultTable.channel,
            supportPrivacyVaultTable.providerMessageId,
          ],
        }).returning({ id: supportPrivacyVaultTable.id });
        if (vault) {
          vaultId = vault.id;
        } else if (input.providerMessageId) {
          const [raced] = await tx.select({ id: supportPrivacyVaultTable.id })
            .from(supportPrivacyVaultTable)
            .where(and(
              eq(supportPrivacyVaultTable.userId, input.userId),
              eq(supportPrivacyVaultTable.channel, input.channel),
              eq(supportPrivacyVaultTable.providerMessageId, input.providerMessageId),
            ))
            .limit(1);
          vaultId = raced?.id ?? null;
        }
        if (!vaultId) throw new Error('Restricted privacy vault record could not be created.');
      }

      if (messageId) {
        const updated = await tx.update(outreachMessagesTable)
          .set({
            content: redaction.redactedText,
            redactedContent: redaction.redactedText,
            privacyVaultId: vaultId,
            htmlContent: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(outreachMessagesTable.id, messageId),
            eq(outreachMessagesTable.userId, input.userId),
            eq(outreachMessagesTable.conversationId, input.conversationId),
          ))
          .returning({ id: outreachMessagesTable.id });
        if (updated.length !== 1) throw new Error('Exact inbound outreach message could not be privacy-protected.');
      }

      if (input.entityType === 'widget_message' && input.entityId) {
        const widgetUpdate = await tx.execute(sql`
          UPDATE support_chat_messages scm
          SET content = ${redaction.redactedText},
              privacy_vault_id = ${vaultId},
              metadata = COALESCE(scm.metadata, '{}'::jsonb) || ${JSON.stringify({
                piiProtected: redaction.tokenCount > 0,
                piiTypes: redaction.piiTypes,
              })}::jsonb
          FROM support_chat_sessions scs
          JOIN team_members tm ON tm.id = scs.member_id
          WHERE scm.id = ${input.entityId}
            AND scm.session_id = scs.id
            AND tm.user_id = ${input.userId}
          RETURNING scm.id
        `);
        if (widgetUpdate.rows.length !== 1) throw new Error('Exact widget message could not be privacy-protected.');
      }

      if (input.sentMessageId) {
        const sentUpdate = await tx.execute(sql`
          UPDATE sent_messages
          SET message = ${redaction.redactedText},
              reply_content = ${redaction.redactedText},
              updated_at = NOW()
          WHERE id = ${input.sentMessageId}
            AND user_id = ${input.userId}
            AND is_reply = TRUE
          RETURNING id
        `);
        if (sentUpdate.rows.length !== 1) throw new Error('Exact inbound email record could not be privacy-protected.');
      }
    });

    return { ...redaction, vaultId };
  }

  private async findInboundMessageId(input: ProtectInboundInput): Promise<number | null> {
    if (!input.providerMessageId) return null;
    const result = await db.execute(sql`
      SELECT id FROM outreach_messages
      WHERE conversation_id = ${input.conversationId}
        AND user_id = ${input.userId}
        AND direction = 'inbound'
        AND (external_message_id = ${input.providerMessageId} OR waba_message_id = ${input.providerMessageId})
      LIMIT 1
    `);
    return Number((result.rows[0] as { id?: number } | undefined)?.id || 0) || null;
  }

  async purgeExpired(): Promise<number> {
    const result = await db.delete(supportPrivacyVaultTable)
      .where(lt(supportPrivacyVaultTable.expiresAt, new Date()))
      .returning({ id: supportPrivacyVaultTable.id });
    logger.debug({ candidateCount: result.length }, '[PrivacyVault] Expiry sweep completed');
    return result.length;
  }
}

export const privacyVaultService = new PrivacyVaultService();
