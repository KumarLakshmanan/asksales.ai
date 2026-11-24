import crypto from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { redactPiiWithStableTokens } from '../agents/orchestration/PrivacyVaultService.js';
import { isEmailAddress } from '../../../shared/emailAddress.js';

/** Only tenant-owned public business catalogs confer this exemption. An
 * uploaded document, message, or model-declared source never does. */
export async function loadVerifiedBusinessContacts(userId: number, businessProfileId: number | null, executor: Pick<typeof db, 'execute'> = db): Promise<string[]> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return [];
  const records: Record<string, unknown>[] = [];
  const catalogQuery = async (statement: SQL) => {
    const nested = executor !== db;
    if (nested) await executor.execute(sql`SAVEPOINT knowledge_contact_catalog`);
    try {
      return await executor.execute(statement);
    } catch (error) {
      // An absent optional catalog must not leave the caller's transaction in
      // PostgreSQL's aborted state after this read-only lookup fails.
      if (nested) await executor.execute(sql`ROLLBACK TO SAVEPOINT knowledge_contact_catalog`);
      throw error;
    } finally {
      if (nested) await executor.execute(sql`RELEASE SAVEPOINT knowledge_contact_catalog`);
    }
  };
  try {
    const result = await catalogQuery(sql`SELECT phone,email,address FROM company_settings
      WHERE user_id=${userId} AND id=app_business_profile_id() AND ${businessProfileId
        ? sql`id=${businessProfileId}`
        : sql`TRUE`}`);
    records.push(...result.rows as Record<string, unknown>[]);
  } catch { /* No registry evidence means ordinary PII protection. */ }
  if (businessProfileId == null) {
    try {
      // Hotel properties currently have no business-profile association. Never
      // guess a property when more than one is configured.
      const result = await catalogQuery(sql`SELECT phone,email,address FROM hotel_properties
        WHERE user_id=${userId} AND (SELECT count(*) FROM hotel_properties WHERE user_id=${userId})=1`);
      records.push(...result.rows as Record<string, unknown>[]);
    } catch { /* The hotel module may not be configured for this tenant. */ }
  }
  return [...new Set(records.flatMap(row => ['phone', 'email', 'address'].flatMap(field => {
    const value = typeof row[field] === 'string' ? row[field].trim() : '';
    if (value.length < 7 || value.length > 500 || /\b(?:password|api[_ -]?key|secret|bearer|otp)\b/i.test(value)) return [];
    if (field === 'phone' && !/^\+?[\d ().-]{7,30}$/.test(value)) return [];
    if (field === 'email' && !isEmailAddress(value)) return [];
    return [value];
  })))];
}

/** Preserve exact catalog values while all other PII goes through the standard
 * detector. Random, typed markers cannot be supplied by customer text and also
 * survive the labeled Address detector. */
export function maskVerifiedBusinessContacts(text: string, values: readonly string[]) {
  const restorations: Array<[string, string]> = [];
  let masked = text;
  for (const value of [...new Set(values)].filter(value => typeof value === 'string' && value.length >= 7).sort((a, b) => b.length - a.length)) {
    if (!masked.includes(value)) continue;
    const marker = `[PUBLIC_BUSINESS_CONTACT_${BigInt(`0x${crypto.randomBytes(8).toString('hex')}`).toString()}]`;
    const exact = new RegExp(`(?<![\\p{L}\\p{N}@_%+.-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}@_%+-]|\\.[\\p{L}\\p{N}])`, 'gu');
    const phone = /^\+?[\d ().-]{7,30}$/.test(value);
    masked = masked.replace(exact, (match, offset: number, whole: string) => {
      // A public phone substring must not split a longer card/ID/phone number
      // into pieces that evade the ordinary detector.
      if (phone && (/\d[\t ().-]*$/.test(whole.slice(0, offset)) || /^[\t ().-]*\d/.test(whole.slice(offset + match.length)))) return match;
      return marker;
    });
    restorations.push([marker, value]);
  }
  return { masked, restore: (value: string) => restorations.reduce((current, [marker, contact]) => current.split(marker).join(contact), value) };
}

export function redactWithVerifiedBusinessContacts(text: string, values: readonly string[]): string {
  const protectedText = maskVerifiedBusinessContacts(text, values);
  return protectedText.restore(redactPiiWithStableTokens(protectedText.masked).redactedText);
}
