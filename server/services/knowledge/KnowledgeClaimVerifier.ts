import type { ToolOutcome } from '../agents/BaseOutreachAgent.js';
import { renderVerifiedHotelBookingSummary } from '../booking/HotelBookingSummary.js';
import { load } from 'cheerio';
import type {
  ClaimEvidence,
  KnowledgeRetrievalResult,
  KnowledgeRisk,
  VerifiedKnowledgeAnswer,
} from './types.js';
import { normalizeKnowledgeFactText } from './KnowledgeFactNormalization.js';
import { conflictingKnowledgeEvidence } from './KnowledgeConflictDetection.js';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were',
  'will', 'with', 'you', 'your',
]);

function terms(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    // Keep formatted currency amounts comparable with numeric tool results
    // (for example, "16,992" and 16992).
    .replace(/(?<=\d)[,\s](?=\d{3}(?:\D|$))/g, '')
    .replace(/_/g, ' ');
  return new Set(normalized.match(/[\p{L}\p{N}-]{2,}/gu)?.filter((term) => !STOP_WORDS.has(term)) || []);
}

function comparableFacts(value: string): string {
  return normalizeKnowledgeFactText(value)
    .replace(/\b\d{1,3}(?:,\d{2})+,\d{3}\b|\b\d{1,3}(?:,\d{3})+\b/g, (amount) => amount.replace(/,/g, ''));
}

const NEGATION = /\b(?:no|not|never|without|cannot|neither|unavailable|excluded)\b|\b\w+n['’]t\b/i;

function numericFacts(value: string): Set<string> {
  return new Set((value.match(/(?<![\p{L}\p{N}])\d+(?:\.\d+)?(?![\p{L}\p{N}])/gu) || [])
    .map((number) => String(Number(number))));
}

/** Reject obvious scalar/polarity contradictions before lexical matching.
 * This is a conservative deterministic guard, not semantic entailment. Select
 * the closest source sentence first so a value from a different room/product
 * elsewhere in the chunk cannot legitimize an invented number.
 */
function hasCompatibleFacts(claim: string, excerpt: string): boolean {
  const normalizedClaim = comparableFacts(claim);
  const claimNumbers = numericFacts(normalizedClaim);
  const contentTerms = (text: string) => new Set([...terms(text)]
    .filter((term) => !/^\d/.test(term) && !NEGATION.test(term) && !['do', 'does', 'did'].includes(term)));
  const subjectTerms = contentTerms(normalizedClaim);
  const sentences = comparableFacts(excerpt).split(/\n+|;|(?<=[.!?])\s+/u).filter((text) => text.trim());
  const candidates = sentences.map((text) => ({ text,
    overlap: [...contentTerms(text)].filter((term) => subjectTerms.has(term)).length,
  }));
  const bestOverlap = Math.max(0, ...candidates.map((candidate) => candidate.overlap));
  if (!bestOverlap) return false;
  return candidates.filter((candidate) => candidate.overlap === bestOverlap).every(({ text }) => {
    if (NEGATION.test(normalizedClaim) !== NEGATION.test(text)) return false;
    const sourceNumbers = numericFacts(text);
    return [...claimNumbers].every((number) => sourceNumbers.has(number));
  });
}

export function evidenceSupportsClaim(claim: string, excerpt: string): boolean {
  if (!hasCompatibleFacts(claim, excerpt)) return false;
  claim = comparableFacts(claim);
  excerpt = comparableFacts(excerpt);
  const claimTerms = terms(claim);
  if (claimTerms.size === 0) return false;
  const evidenceTerms = terms(excerpt);
  let overlap = 0;
  for (const term of claimTerms) if (evidenceTerms.has(term)) overlap += 1;
  return overlap >= Math.min(3, claimTerms.size) && overlap / claimTerms.size >= 0.45;
}

/** A question mark alone is not proof of a non-factual reply. Only a short,
 * standalone information request may bypass evidence checks; statements and
 * presupposed operational facts must still be verified. */
export function isEvidenceFreeClarification(replyText: string): boolean {
  const text = replyText.trim();
  // A name-collection request does not assert a reservation exists. Keep this
  // exact and closed: arbitrary "please share" sentences may contain prices,
  // benefits or confirmations and must still be checked against evidence.
  if (/^please (?:share|provide) your (?:full )?name(?: for (?:the|your) (?:booking|reservation) (?:enquiry|inquiry|request))?[.?]$/i.test(text)) return true;
  if (!text || text.length > 240 || !text.endsWith('?')) return false;
  if (/[.!;\n\r₹$€£\d]|\?.+\S/u.test(text)) return false;
  if (/\b(?:confirmed|completed|paid|refunded|guaranteed|includes?|accommodates?|costs?|available|reserved)\b/i.test(text)) return false;
  // Use a closed set of information-request forms, not any interrogative:
  // "Which complimentary services would you like?" still asserts a benefit.
  return /^(?:(?:can|could|would) you (?:please )?(?:share|provide|clarify|confirm) (?:more details|your (?:name|email|phone number|preferred dates|product version))|(?:what|which) dates would you prefer|which (?:product|product version|device) are you using|what is your (?:name|email|phone number)|how many (?:guests|adults|children|rooms) (?:are there|do you need))\?$/iu.test(text);
}

function atomicSegments(replyText: string): string[] {
  // Markup is presentation, not a factual assertion. Preserve block boundaries
  // and decode entities before sentence splitting (notably &amp; in email).
  const plain = /<\/?[a-z][^>]*>/i.test(replyText)
    ? load(replyText.replace(/<br\s*\/?\s*>|<\/(?:p|div|li|ol|ul|h[1-6])>/gi, '\n'), null, false).text()
    : replyText;
  return plain
    .replace(/\r/g, '')
    // Strip list markers BEFORE splitting on periods: otherwise "1. Check-in"
    // becomes an unsupported claim "1." separate from the actual fact.
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    // Never split after an abbreviation: "Rs. 4,299" is one price, not two claims.
    .split(/\n+|(?<=[.!])(?<!\b(?:[Rr]s|[Rr]e|INR|[Nn]o|[Nn]os|[Mm]r|[Mm]rs|[Mm]s|[Dd]r|[Ss]t|[Ss]r|[Jj]r|[Vv]s|[Aa]pprox|[Ii]ncl|[Ee]xcl|[Tt]el|[Pp]h)\.)\s+(?=[A-Z0-9])|\s*;\s*/u)
    .map((segment) => segment
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
      .replace(/\*\*/g, '')
      .trim())
    // A combined pair of standard timing facts is still two assertions. The
    // source often publishes each on its own line; checking both numbers
    // against either one line incorrectly rejects a correct answer. Keep the
    // grammar closed so qualifiers/conditions are never split away.
    .flatMap((segment) => {
      const time = String.raw`\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?`;
      const clause = String.raw`(?:standard\s+)?check[- ]?(?:in|out)(?:\s+time)?\s*(?:(?:is\s+)?at\s*|is\s+|:\s*)?${time}`;
      const pair = segment.match(new RegExp(`^(${clause})\\s*,?\\s+and\\s+(${clause})[.!]?$`, 'i'));
      return pair ? [pair[1].trim(), pair[2].trim()] : [segment];
    })
    .filter((segment) => segment.length > 0)
    .filter((segment) => !isEvidenceFreeClarification(segment));
}

function isClearlyGeneral(segment: string): boolean {
  const normalized = segment.trim();
  if (/^(?:you(?:['’]re| are) welcome|have (?:a )?(?:lovely|nice|great) (?:day|evening|weekend))[.!]?$/iu.test(normalized)) return true;
  // Closed, non-factual email framing. Names, signatures, subject lines and
  // any appended assertions still require evidence.
  if (/^(?:dear guest|hello|best regards|kind regards|regards|thank you)[,!]?$/i.test(normalized)) return true;
  if (normalized === 'Here is your booking summary:') return true;
  // Never let a greeting prefix hide a factual or transactional assertion.
  if (/[₹$€£\d]|\b(?:price|cost|rate|available|availability|booking|reservation|payment|refund|cancellation|policy|ticket|account|confirmed|completed|paid)\b/i.test(normalized)) {
    return false;
  }
  const generalCandidate = normalized.replace(
    /^[\p{L}\p{M} .'’-]{1,80},\s*(?=it(?:['’]s|\s+is)\s+(?:a\s+|my\s+)?pleasure\b)/iu,
    '',
  );
  return /^(?:(?:thanks|thank\s+you|hello|hi)[!.]?|(?:namaste|namaskara)(?:\s+[\p{L}][\p{L}\p{M} .'’-]{0,80})?[!.]?|certainly(?:[,!]\s*[\p{L}][\p{L}\p{M} .'’-]{0,80})?[!.]?|welcome(?:\s+back)?(?:[,!]\s*[\p{L}][\p{L}\p{M} .'’-]{0,80})?[!.]?|it(?:['’]s|\s+is)\s+(?:a\s+|my\s+)?pleasure\s+to\s+(?:assist|help)(?:\s+you)?(?:\s+again|\s+today)?[!.]?|(?:glad|happy)\s+to\s+(?:assist|help)(?:\s+you)?(?:\s+again|\s+today)?[!.]?|(?:that(?:['’]s|\s+is)\s+(?:a\s+)?|a\s+)?(?:great|good|excellent|wonderful)\s+choice(?:[,!]\s*[\p{L}][\p{L}\p{M} .'’-]{0,80})?[!.]?|to\s+confirm,?\s+i\s+have\s+the\s+following\s+details\s+for\s+your\s+stay:?|i(?:['’]m|\s+am)\s+sorry[!.]?|(?:for\s+your\s+safety|do\s+not\s+share|please\s+avoid\s+sharing|you\s+can\s+ask)\b.*|please\s+(?:choose|select|confirm|reply|let\s+me\s+know|tell\s+me|share)\b.*|let\s+me\s+know\b.*|would\s+you\s+be\s+open\s+to\s+(?:considering\s+)?(?:alternative|different)\b.*|i(?:['’]d|\s+would)\s+be\s+happy\s+to\s+check\b.*|i(?:['’]ll|\s+will)\s+connect\b.*|a\s+support\s+team\s+member\b.*)$/iu.test(generalCandidate);
}

function compactComparable(value: unknown): string {
  try {
    return (typeof value === 'string' ? value : JSON.stringify(value))
      .toLowerCase()
      // Normalize both western (113,870) and Indian (1,13,870) digit
      // grouping before punctuation is discarded. The previous three-digit
      // lookahead left Indian-formatted prices as "1 13870", which caused a
      // confirmed live quote to fail the final claim-verification boundary.
      .replace(/\b\d{1,3}(?:,\d{2})+,\d{3}\b|\b\d{1,3}(?:,\d{3})+\b/g, (amount) => amount.replace(/,/g, ''))
      .replace(/(?<=\d)[,\s](?=\d{3}(?:\D|$))/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  } catch {
    return '';
  }
}

function isoDateAliases(value: unknown): string[] {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return [];
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return [];
  const monthLong = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(date).toLowerCase();
  const monthShort = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(date).toLowerCase();
  const ordinalSuffix = day % 100 >= 11 && day % 100 <= 13
    ? 'th'
    : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
  const ordinalDay = `${day}${ordinalSuffix}`;
  return [
    value,
    `${day} ${monthLong} ${year}`,
    `${monthLong} ${day} ${year}`,
    `${ordinalDay} ${monthLong} ${year}`,
    `${monthLong} ${ordinalDay} ${year}`,
    `${day} ${monthLong}`,
    `${monthLong} ${day}`,
    `${ordinalDay} ${monthLong}`,
    `${monthLong} ${ordinalDay}`,
    `${day} ${monthShort} ${year}`,
    `${monthShort} ${day} ${year}`,
  ].map(compactComparable);
}

function isCanonicalBookingConfirmation(claim: string): boolean {
  return /^Are you sure you want to book\b/i.test(claim.trim());
}

function availabilityCurrency(option: Record<string, unknown>, result: Record<string, unknown>): string | null {
  // Legacy availability output omitted currency; the provider and canonical
  // renderer both default that omission to INR. An explicit currency never
  // inherits the default or gets silently converted to another currency.
  const value = option.currency === undefined ? (result.currency === undefined ? 'INR' : result.currency) : option.currency;
  return typeof value === 'string' && /^[a-z]{3}$/i.test(value) ? value.toUpperCase() : null;
}

function supportsCanonicalBookingConfirmation(claim: string, args: Record<string, unknown>,
  result: Record<string, unknown>, options: Record<string, unknown>[]): boolean {
  const checkIn = args.check_in ?? args.checkIn;
  const checkOut = args.check_out ?? args.checkOut;
  const rooms = Number(args.rooms ?? 1);
  const guests = Number(args.guests);
  const numeric = (value: unknown) => typeof value === 'number'
    || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
  if (typeof checkIn !== 'string' || typeof checkOut !== 'string' || !isoDateAliases(checkIn).length
    || !isoDateAliases(checkOut).length || checkOut <= checkIn
    || !numeric(args.rooms ?? 1) || !numeric(args.guests)
    || !Number.isSafeInteger(rooms) || rooms < 1 || !Number.isSafeInteger(guests) || guests < 1) return false;
  return options.filter(option => {
    const currency = availabilityCurrency(option, result);
    const price = Number(option.price_per_night);
    if (typeof option.name !== 'string' || !option.name.trim() || !currency || !numeric(option.price_per_night)
      || !Number.isFinite(price) || price <= 0) return false;
    const canonical = renderVerifiedHotelBookingSummary({ roomName: option.name, roomCount: rooms, guests,
      checkIn, checkOut, pricePerNight: price, currency });
    return claim.trim() === canonical.split('\n').at(-1);
  }).length === 1;
}

function compatibleAvailabilityScalars(claim: string, args: Record<string, unknown>): boolean {
  const checkIn = args.check_in ?? args.checkIn;
  const checkOut = args.check_out ?? args.checkOut;
  const guests = Number(args.guests);
  const rooms = Number(args.rooms ?? 1);
  const nights = typeof checkIn === 'string' && typeof checkOut === 'string'
    ? (Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000 : NaN;
  const normalized = comparableFacts(claim);
  const allowed = numericFacts([checkIn, checkOut, guests, rooms, Number.isSafeInteger(nights) && nights > 0 ? nights : ''].join(' '));
  if ([...numericFacts(normalized)].some(value => !allowed.has(value))) return false;
  for (const match of normalized.matchAll(/\b(\d+)\s+(guests?|rooms?|nights?|adults?|children)\b/g)) {
    const count = Number(match[1]);
    if (/^guest/.test(match[2]) ? count !== guests : /^room/.test(match[2]) ? count !== rooms
      : /^night/.test(match[2]) ? count !== nights : true) return false;
  }
  const dates = normalized.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
  if (dates.some(date => date !== checkIn && date !== checkOut)) return false;
  if (dates.length > 1 && (dates.length !== 2 || dates[0] !== checkIn || dates[1] !== checkOut)) return false;
  const comparable = compactComparable(normalized);
  const position = (date: unknown) => Math.min(...isoDateAliases(date)
    .map(alias => comparable.indexOf(alias)).filter(index => index >= 0));
  const start = position(checkIn);
  const end = position(checkOut);
  if (Number.isFinite(start) && Number.isFinite(end) && end < start) return false;
  return true;
}

function toolSupportsClaim(claim: string, tool: ToolOutcome): boolean {
  if (tool.status !== 'success' || tool.success !== true) return false;
  // This tool only presents the canonical evidence lane. Match its claims to
  // individual authorized excerpts, never to a serialized/truncated JSON blob.
  if (tool.name === 'answer_from_knowledge_base') return false;
  if (isCanonicalBookingConfirmation(claim) && tool.name !== 'check_room_availability') return false;
  if (tool.name === 'continue_external_booking') {
    const externalResult = tool.result && typeof tool.result === 'object' && !Array.isArray(tool.result)
      ? tool.result as Record<string, unknown>
      : {};
    const externalReady = externalResult.status === 'external_booking_ready';
    if (!externalReady) return false;
    return /\broom\s+selection\b.*\bready\s+to\s+continue\b/i.test(claim)
      || /\b(?:booking|hotel)\s+page\b.*\b(?:included|provided|shared|sent)\b|\b(?:included|provided|shared|sent)\b.*\b(?:booking|hotel)\s+page\b/i.test(claim)
      || /\bavailability\b.*\bfinal\s+price\b.*\bpayment\b.*\bconfirmation\b.*\b(?:page|site)\b/i.test(claim);
  }
  if (tool.name !== 'check_room_availability') return evidenceSupportsClaim(claim, toolResultText(tool));

  const comparableClaim = compactComparable(claim);
  const args = tool.args && typeof tool.args === 'object' && !Array.isArray(tool.args)
    ? tool.args as Record<string, unknown>
    : {};
  const result = tool.result && typeof tool.result === 'object' && !Array.isArray(tool.result)
    ? tool.result as Record<string, unknown>
    : {};
  if (result.success !== true) return false;
  const options = Array.isArray(result.options)
    ? result.options.filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === 'object' && !Array.isArray(option))
    : [];
  const externalSearchReady = result.status === 'external_booking_search_ready';
  if (externalSearchReady) {
    // The tool has validated and assembled the approved public search handoff.
    // The URL itself stays out of model-visible tool output and is appended by
    // the delivery layer, but these narrow boundary statements are evidenced
    // by that successful status. Do not treat it as proof that rooms exist.
    return /\b(?:live\s+)?(?:room|booking)\s+search\b.*\b(?:included|provided|shared|sent)\b/i.test(claim)
      || /\b(?:availability|final\s+price)\b.*\bpayment\b.*\bconfirmation\b.*\b(?:page|site)\b/i.test(claim);
  }
  const noAvailability = options.length === 0
    && (Number(result.count) === 0
      || /\b(?:no\s+rooms?\s+match|fully\s+booked|no\s+availability|unavailable)\b/i.test(String(result.note || '')));

  // A composite confirmation is one live tuple, not a bag of independently
  // matched numbers or a question exempt from factual verification.
  if (isCanonicalBookingConfirmation(claim)) return supportsCanonicalBookingConfirmation(claim, args, result, options);

  // Price assertions must be checked before any room/date/guest shortcut.
  // A returned room name is not evidence for an arbitrary price next to it.
  if (/[₹$€£]|\b(?:price|rate|costs?|total|inr|usd|eur|gbp)\b|\bper\s+night\b/i.test(claim)) {
    if (claimRequiresCommittedEffect(claim)) return false;
    const namedOptions = options.filter((option) => {
      const name = compactComparable(option.name);
      return name && comparableClaim.includes(name);
    });
    const amounts = numericFacts(comparableFacts(claim));
    if (amounts.size === 0) return false;
    const nightly = /\bnightly\b|\bper\s+night\b|\/\s*night\b/i.test(claim);
    const total = /\btotal\b/i.test(claim);
    // Split compound nightly/total claims rather than allowing swapped labels.
    if (nightly && total) return false;
    const matching = (namedOptions.length ? namedOptions : options).filter((option) => {
      const currency = availabilityCurrency(option, result);
      const symbols: Record<string, string> = { '₹': 'INR', '$': 'USD', '€': 'EUR', '£': 'GBP' };
      const statedCurrencies = [
        ...(claim.match(/[₹$€£]/g) || []).map(symbol => symbols[symbol]),
        ...Array.from(claim.matchAll(/\b([A-Z]{3})\s+(?=\d)/g), match => match[1]),
        ...(claim.match(/\b(?:inr|usd|eur|gbp)\b/gi) || []).map(value => value.toUpperCase()),
      ];
      if (!currency || statedCurrencies.some(value => value !== currency)) return false;
      const values = (nightly ? [option.price_per_night] : total ? [option.total_price]
        : [option.price_per_night, option.total_price])
        .filter((value) => typeof value === 'number' || typeof value === 'string')
        .flatMap((value) => [...numericFacts(comparableFacts(String(value)))]);
      return [...amounts].every((amount) => values.includes(amount));
    });
    return matching.length === 1;
  }

  if (!compatibleAvailabilityScalars(claim, args) || claimRequiresCommittedEffect(claim)) return false;

  if (options.length > 0
    && /^Which (?:verified )?(?:room|villa|room or villa) option would you like\?$/i.test(claim.trim())) return true;

  // A successful live availability lookup supports a narrow statement that
  // availability for the requested stay was checked. It does not support a
  // booking, hold, payment, or any other committed side effect.
  if ((options.length > 0 || noAvailability)
    && /\b(?:verified|checked|confirmed)\b.{0,40}\bavailability\b|\bavailability\b.{0,40}\b(?:verified|checked|confirmed)\b/i.test(claim)
    && !/\b(?:booking|reservation|hold|payment|paid)\b/i.test(claim)) return true;

  // A successful lookup with zero matching options supports only a narrow
  // no-availability statement. It must never be used to infer a cancellation,
  // hold, booking failure, or a different date/occupancy combination.
  if (noAvailability
    && /\b(?:fully\s+booked|no\s+rooms?\s+(?:are\s+)?available|(?:we\s+)?(?:do\s+not|don't)\s+have\s+any\s+rooms?\s+available|no\s+availability|unavailable)\b/i.test(claim)
    && !/\b(?:booking|reservation|hold|payment|paid|cancel)\b/i.test(claim)) return true;

  // Canonical summaries split the selected room and guest count onto their
  // own list lines. Match the exact returned room name or exact requested
  // count; never use loose lexical overlap for availability tool output.
  if (/\brooms?\b/i.test(claim) && options.some((option) => {
    const name = compactComparable(option.name);
    if (!name || !comparableClaim.includes(name)) return false;
    const remainder = comparableClaim.replace(name, '').trim().split(/\s+/).filter(Boolean);
    const roomCount = String(args.rooms ?? 1);
    return remainder.every((term) => ['room', 'rooms', 'selected', 'selection', 'your', 'the', 'is', roomCount].includes(term));
  })) return true;
  const guests = Number(args.guests);
  if (Number.isSafeInteger(guests) && guests > 0 && /\bguests?\b/i.test(claim)
    && new RegExp(`^(?:guests? )?${guests}(?: guests?)?$`).test(compactComparable(comparableFacts(claim)))) return true;

  const checkIn = args.check_in ?? args.checkIn;
  const checkOut = args.check_out ?? args.checkOut;
  if (/\bcheck[- ]?in\b/i.test(claim)) {
    return isoDateAliases(checkIn).some(date => comparableClaim === `check in ${date}` || comparableClaim === `checkin ${date}`);
  }
  if (/\bcheck[- ]?out\b/i.test(claim)) {
    return isoDateAliases(checkOut).some(date => comparableClaim === `check out ${date}` || comparableClaim === `checkout ${date}`);
  }

  // Booking summaries often combine the live check-in and check-out values on
  // one "Dates" line. Require both exact dates from the successful lookup so
  // an unrelated or partly invented range cannot pass.
  if (/\b(?:dates?|stay|nights?)\b/i.test(claim)
    && isoDateAliases(checkIn).some((date) => comparableClaim.includes(date))
    && isoDateAliases(checkOut).some((date) => comparableClaim.includes(date))) return true;

  // Introductory availability statements are supported when they repeat the
  // exact stay dates supplied to the successful availability lookup.
  if (/\b(?:available|availability|options?|stay|rooms?)\b/i.test(claim) && (options.length > 0 || noAvailability)) {
    const dateValues = [args.check_in, args.checkIn, args.check_out, args.checkOut]
      .flatMap(isoDateAliases)
      .filter(Boolean);
    const distinctDates = new Set(dateValues);
    if (distinctDates.size > 0 && [...distinctDates].some((date) => comparableClaim.includes(date))) return true;
  }

  return false;
}

/** Builds a claim set from every independently deliverable assertion. A model
 * cannot make one well-supported sentence conceal an unsupported list item. */
export function buildAtomicClaimEvidence(input: {
  replyText: string;
  retrieval?: KnowledgeRetrievalResult;
  toolOutcomes?: ToolOutcome[];
  providedClaims?: ClaimEvidence[];
  referenceEvidence?: Array<{ source: string; excerpt: string }>;
  audience?: 'customer' | 'internal';
  risk?: KnowledgeRisk;
}): ClaimEvidence[] {
  const provided = input.providedClaims || [];
  return atomicSegments(input.replyText).map((claim, index): ClaimEvidence => {
    if (isClearlyGeneral(claim)) {
      return { claimId: `customer-answer-${index + 1}`, claim, origin: 'general', evidenceIds: [], verdict: 'supported' };
    }
    // Live operational evidence takes precedence over a model-declared KB
    // origin. Availability and prices must never appear grounded merely
    // because a document happened to contain similar text.
    const matchingTool = (input.toolOutcomes || []).find((tool) => toolSupportsClaim(claim, tool));
    if (matchingTool) {
      return { claimId: `customer-answer-${index + 1}`, claim, origin: 'tool', evidenceIds: [], verdict: 'unsupported' };
    }
    if (input.audience === 'internal' && input.risk === 'low' && !claimRequiresCommittedEffect(claim)) {
      const uploadIds = (input.referenceEvidence || [])
        .filter(reference => reference.source.startsWith('user_upload:') && evidenceSupportsClaim(claim, reference.excerpt))
        .map(reference => reference.source);
      if (uploadIds.length) return { claimId: `customer-answer-${index + 1}`, claim, origin: 'reference', evidenceIds: uploadIds, verdict: 'unsupported' };
    }
    const declared = provided.find((candidate) =>
      evidenceSupportsClaim(claim, candidate.claim) || evidenceSupportsClaim(candidate.claim, claim));
    if (declared) return { ...declared, claimId: `customer-answer-${index + 1}`, claim };
    const evidenceIds = (input.retrieval?.evidence || [])
      .filter((evidence) => evidenceSupportsClaim(claim, evidence.excerpt))
      .map((evidence) => evidence.evidenceId);
    return { claimId: `customer-answer-${index + 1}`, claim, origin: 'knowledge', evidenceIds, verdict: 'unsupported' };
  });
}

function toolResultText(tool: ToolOutcome): string {
  const prefix = `${tool.name.replace(/_/g, ' ')} ${tool.confirmedSideEffect ? 'confirmed completed' : ''}`;
  const args = compactComparable(tool.args).slice(0, 5_000);
  if (typeof tool.result === 'string') return `${prefix} ${args} ${tool.result.slice(0, 20_000)}`;
  try {
    return `${prefix} ${args} ${JSON.stringify(tool.result).slice(0, 20_000)}`;
  } catch {
    return '';
  }
}

function confirmedToolExists(tools: ToolOutcome[], claim: string, requireCommittedEffect = false): boolean {
  return tools.some((tool) => tool.status === 'success'
    && tool.success === true
    && (!requireCommittedEffect || tool.confirmedSideEffect === true)
    && toolSupportsClaim(claim, tool));
}

function claimRequiresCommittedEffect(claim: string): boolean {
  // External-checkout boundary wording describes where a future transaction
  // will be completed; it is not a claim that this conversation completed it.
  if (/\b(?:availability|final\s+price)\b.*\bpayment\b.*\bconfirmation\b.*\b(?:on|through)\s+(?:that|the|an?\s+external)?\s*(?:booking\s+)?(?:page|site)\b/i.test(claim)) {
    return false;
  }
  return /\b(?:booking|reservation|payment|refund|cancellation|ticket|account)\b.{0,40}\b(?:confirmed|completed|processed|created|cancelled|canceled|refunded|updated|paid)\b|\b(?:confirmed|completed|processed|created|cancelled|canceled|refunded|updated|paid)\b.{0,40}\b(?:booking|reservation|payment|refund|cancellation|ticket|account)\b/i.test(claim);
}

export interface VerifyClaimsInput {
  claims: ClaimEvidence[];
  retrieval?: KnowledgeRetrievalResult;
  toolOutcomes?: ToolOutcome[];
  /** Authorized server-assembled lane, never model-provided citation text. */
  referenceEvidence?: Array<{ source: string; excerpt: string }>;
  audience: 'customer' | 'internal';
  risk: KnowledgeRisk;
}

export function onlyReadOnlyKnowledgeTools(tools: ToolOutcome[] = []): boolean {
  return tools.every(tool => tool.name === 'answer_from_knowledge_base'
    && tool.status === 'success' && tool.success === true && tool.confirmedSideEffect !== true
    && Boolean(tool.result && typeof tool.result === 'object'
      && (tool.result as Record<string, unknown>).grounding_status === 'sufficient'));
}

/** Low-risk FAQ recovery only. Never make a failed assertion pass: discard
 * independent unsupported additions, then reverify the remaining exact claims.
 * Conditional/safety/transactional failures retain the original fail-closed
 * outcome because removing them could change the supported answer's meaning.
 */
export function recoverSupportedKnowledgeAnswer(input: VerifyClaimsInput): {
  replyText: string;
  verification: VerifiedKnowledgeAnswer;
  removedClaimIds: string[];
} | null {
  if (input.risk !== 'low'
    || input.retrieval?.status !== 'sufficient' || !onlyReadOnlyKnowledgeTools(input.toolOutcomes)) return null;
  // Internal diagnostic verification may retain unsupported claims for audit.
  // Repair uses the strict customer standard for both audiences, while keeping
  // the same already-authorized retrieval scope and read-only tool restriction.
  const strictInput = { ...input, audience: 'customer' as const };
  const original = verifyKnowledgeClaims(strictInput);
  if (original.mayDeliver) return null;
  const rejected = original.claims.filter((claim) => claim.verdict !== 'supported');
  if (!rejected.length || rejected.some((claim) => claim.verdict === 'conflicting'
    || !['knowledge', 'general'].includes(claim.origin)
    || /\b(?:not|no|never|without|unless|except|only|if|until|must|warning|unsafe|danger|allerg\w*|payment|refund|booking|reservation|availability|price|pricing|rate|account|ticket|consent)\b|\b\w+n['’]t\b/i.test(claim.claim))) return null;
  const retained = original.claims.filter((claim) => claim.verdict === 'supported' && claim.origin === 'knowledge');
  if (!retained.length) return null;
  const verification = verifyKnowledgeClaims({ ...strictInput, claims: retained });
  if (!verification.mayDeliver || verification.answerGrounding !== 'grounded') return null;
  return {
    replyText: retained.map((claim) => claim.claim).join('\n\n'),
    verification,
    removedClaimIds: rejected.map((claim) => claim.claimId),
  };
}

/**
 * A deterministic final boundary. Retrieval alone never establishes grounding:
 * every tenant-specific claim must cite authorized evidence that contains enough
 * matching subject matter, and transactional claims require a confirmed tool.
 */
export function verifyKnowledgeClaims(input: VerifyClaimsInput): VerifiedKnowledgeAnswer {
  const evidenceById = new Map((input.retrieval?.evidence || []).map((evidence) => [evidence.evidenceId, evidence]));
  const conflictingEvidence = conflictingKnowledgeEvidence(input.retrieval?.evidence || []);
  const toolOutcomes = input.toolOutcomes || [];
  const verified = input.claims.map((claim): ClaimEvidence => {
    if (isCanonicalBookingConfirmation(claim.claim)) return {
      ...claim, origin: 'tool', evidenceIds: [],
      verdict: confirmedToolExists(toolOutcomes, claim.claim) ? 'supported' : 'unsupported',
    };
    if (claim.origin !== 'tool' && claimRequiresCommittedEffect(claim.claim)) {
      return { ...claim, verdict: 'unsupported' };
    }
    if (claim.origin === 'general') return {
      ...claim, evidenceIds: [], verdict: isClearlyGeneral(claim.claim) ? 'supported' : 'unsupported',
    };
    if (claim.origin === 'tool') {
      return {
        ...claim,
        verdict: confirmedToolExists(toolOutcomes, claim.claim, claimRequiresCommittedEffect(claim.claim))
          ? 'supported'
          : 'unsupported',
      };
    }
    if (claim.origin === 'reference') {
      const authorizedReferences = (input.referenceEvidence || [])
        .filter((evidence) => claim.evidenceIds.includes(evidence.source))
        .filter((evidence) => !evidence.source.startsWith('user_upload:') || (input.audience === 'internal' && input.risk === 'low'));
      return { ...claim, evidenceIds: authorizedReferences.map((evidence) => evidence.source),
        verdict: authorizedReferences.some((evidence) => evidenceSupportsClaim(claim.claim, evidence.excerpt))
          ? 'supported' : 'unsupported' };
    }
    if (input.retrieval?.status === 'conflict_detected' || conflictingEvidence.size > 0) return { ...claim, verdict: 'conflicting' };
    if (input.retrieval?.status !== 'sufficient') return { ...claim, evidenceIds: [], verdict: 'unsupported' };
    const authorized = claim.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((evidence): evidence is NonNullable<typeof evidence> => Boolean(evidence));
    return {
      ...claim,
      evidenceIds: authorized.map((evidence) => evidence.evidenceId),
      verdict: authorized.some((evidence) => evidenceSupportsClaim(claim.claim, evidence.excerpt))
        ? 'supported'
        : 'unsupported',
    };
  });

  const unsupported = verified.filter((claim) => claim.verdict !== 'supported').map((claim) => claim.claim);
  const factualClaims = verified.filter((claim) => claim.origin !== 'general');
  const highImpact = input.risk === 'high' || input.risk === 'transactional';
  const mayDeliver = input.audience !== 'customer'
    || (unsupported.length === 0 && (!highImpact || factualClaims.length > 0));
  const supportedFactual = factualClaims.length > 0 && factualClaims.every((claim) => claim.verdict === 'supported');

  return {
    answerGrounding: !mayDeliver ? 'blocked'
      : factualClaims.length === 0 ? 'not_required'
        : supportedFactual ? 'grounded' : 'partially_grounded',
    claims: verified,
    unsupportedClaims: unsupported,
    mayDeliver,
    reason: mayDeliver ? undefined : unsupported.length
      ? 'unsupported_customer_factual_claim'
      : 'high_impact_answer_without_verified_factual_evidence',
  };
}
