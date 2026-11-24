import { sql } from 'drizzle-orm';

/** Match uploaded identifiers only within the current business. */
export function leadUploadLookup(userId: number, businessProfileId: number, emails: string[], phones: string[]) {
  const emailMatch = emails.length
    ? sql`LOWER(l.email) IN (${sql.join(emails.map(email => sql`${email}`), sql`, `)})`
    : sql`false`;
  const phoneMatch = phones.length
    ? sql`l.phone IN (${sql.join(phones.map(phone => sql`${phone}`), sql`, `)})`
    : sql`false`;
  return sql`
    SELECT l.*, LOWER(l.email) AS email FROM leads l
    WHERE l.user_id = ${userId} AND l.business_profile_id = ${businessProfileId}
      AND l.deleted_at IS NULL AND (${emailMatch} OR ${phoneMatch})
  `;
}
