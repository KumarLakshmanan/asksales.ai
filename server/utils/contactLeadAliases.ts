import {sql} from 'drizzle-orm';

/** Build the small set of lead references before selecting active leads. ORs
 * containing correlated subqueries force a full lead scan for every update. */
export function contactLeadAliasIds(userId:number,businessProfileId:number,contactId:number,leadId:number|null) {
  return sql`SELECT ${leadId}::integer AS id
    UNION
    SELECT conversation.lead_id AS id FROM outreach_conversations conversation
      WHERE conversation.user_id=${userId} AND conversation.business_profile_id=${businessProfileId}
        AND conversation.crm_contact_id=${contactId}
    UNION
    SELECT retired.lead_id AS id FROM crm_contacts retired
      WHERE retired.user_id=${userId} AND retired.business_profile_id=${businessProfileId}
        AND retired.merged_into_contact_id=${contactId}`;
}
