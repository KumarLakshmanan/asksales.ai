import type { PlaybookDirective } from './PlaybookEngine.js';
import { confidentSemanticIntent, type SupportSemanticIntent } from './SupportSemanticIntent.js';

/** NLU may retain pricing while the customer answers a date/count prompt. */
export function isCurrentPricingQuestion(request?: SupportSemanticIntent): boolean {
  return confidentSemanticIntent(request)?.pricingRequested === true;
}

/** Only validated, non-sensitive journey facts may decorate a collect prompt.
 * This is separate from model wording so it cannot invent prices or identity. */
export function collectContextPreface(directive: PlaybookDirective, intent?: string): string {
  const key = directive.journey?.missingFields[0];
  const fields = directive.journey?.fields || {};
  const value = (name: string) => ['collected', 'verified'].includes(fields[name]?.status) ? fields[name]?.value : undefined;
  const date = (name: string) => typeof value(name) === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(String(value(name))) ? String(value(name)) : '';
  const count = (name: string) => Number.isSafeInteger(value(name)) && Number(value(name)) >= 0 && Number(value(name)) <= 100 ? Number(value(name)) : undefined;
  if (intent === 'pricing_question' && key?.startsWith('stay.')) {
    return 'I can help you check the price. I need the remaining stay details to look up a quote; I haven’t checked availability or a final rate yet.';
  }
  if (key === 'stay.checkOut' && date('stay.checkIn')) return `Thanks — I have your check-in as ${date('stay.checkIn')}.`;
  if (key === 'stay.adults' && date('stay.checkIn') && date('stay.checkOut')) return `I have your stay as ${date('stay.checkIn')} to ${date('stay.checkOut')}.`;
  if (key === 'stay.children' && count('stay.adults') !== undefined) return `Got it — ${count('stay.adults')} ${count('stay.adults') === 1 ? 'adult' : 'adults'}.`;
  if (key === 'stay.rooms' && count('stay.adults') !== undefined && count('stay.children') !== undefined) {
    return `That’s ${count('stay.adults')} ${count('stay.adults') === 1 ? 'adult' : 'adults'} and ${count('stay.children')} ${count('stay.children') === 1 ? 'child' : 'children'}.`;
  }
  return '';
}
