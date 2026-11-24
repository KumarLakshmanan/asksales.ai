/**
 * WhatsApp Cloud API recipients are E.164 digits without "+": a country code
 * followed by the national number. Trunk prefixes ("0…") and placeholders
 * such as "{}" are not deliverable and must be fixed in CRM before sending.
 */
export const WHATSAPP_NUMBER_HELP = 'Add the WhatsApp number with its country code, for example 919876543210.';

export function normalizeWhatsAppNumber(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === 'object') return null;
  const compact = String(value).normalize('NFKC').trim().replace(/[\s().-]/g, '');
  if (!/^(?:\+|00)?[0-9]+$/.test(compact)) return null;
  const digits = compact.replace(/^(?:\+|00)/, '');
  return /^[1-9][0-9]{7,14}$/.test(digits) ? digits : null;
}

/** The first stored WhatsApp/phone value that is a real number. A literal
 * "{}" left by an old import must not hide a valid phone column. */
export function firstWhatsAppNumberSource(...values: unknown[]): string {
  for (const value of values) {
    if (value === null || value === undefined || typeof value === 'object') continue;
    const text = String(value).trim();
    if (text && text !== '{}' && text !== '[]' && text.toLowerCase() !== 'null') return text;
  }
  return '';
}
