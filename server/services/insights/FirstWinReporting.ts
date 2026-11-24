import { sql } from 'drizzle-orm';

/** Same lifetime-first-win policy as Workspace Insights. Retired contact aliases
 * resolve before timestamp/event-ID ordering. Cycles have no canonical root and
 * are omitted rather than arbitrarily assigned. No row edit time is evidence. */
export function firstWinCtes(userId: number | null, businessProfileId: number | null, crmEnabled: boolean) {
  return sql`WITH RECURSIVE scoped_contacts AS (
    SELECT id,lead_id,merged_into_contact_id,user_id,business_profile_id FROM crm_contacts
      WHERE (${userId}::int IS NULL OR user_id=${userId}) AND (${businessProfileId}::int IS NULL OR business_profile_id=${businessProfileId}) AND ${crmEnabled}
  ), contact_roots AS (
    SELECT id AS original_id,id AS contact_id,merged_into_contact_id AS next_id,ARRAY[id] AS path,user_id,business_profile_id FROM scoped_contacts
    UNION ALL
    SELECT r.original_id,c.id,c.merged_into_contact_id,r.path||c.id,r.user_id,r.business_profile_id FROM contact_roots r
      JOIN scoped_contacts c ON c.id=r.next_id AND c.user_id=r.user_id AND c.business_profile_id=r.business_profile_id WHERE NOT c.id=ANY(r.path)
  ), resolved_contacts AS (
    SELECT original_id,contact_id,user_id,business_profile_id FROM contact_roots WHERE next_id IS NULL
  ), first_wins AS (
    SELECT DISTINCT ON(r.user_id,r.business_profile_id,r.contact_id) e.*,r.contact_id AS canonical_contact_id
    FROM sales_outcome_events e JOIN resolved_contacts r ON r.original_id=e.contact_id AND r.user_id=e.user_id AND r.business_profile_id=e.business_profile_id
    WHERE e.kind='contact_won'
    ORDER BY r.user_id,r.business_profile_id,r.contact_id,e.occurred_at,e.id
  )`;
}
