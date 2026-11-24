import { sql } from "drizzle-orm";
import { requireBusinessScope } from "../../tenancy/businessContext.js";
/** Only durable CRM links and provider identity mappings establish a customer.
 * Similar names, shared emails and phone substrings never merge a report. */
export function customerReportingIdentityCtes() {
  const { userId, businessProfileId: business } = requireBusinessScope();
  return sql`contact_roots AS (
    WITH RECURSIVE paths AS (
      SELECT c.id AS contact_id,c.id AS current_id,c.merged_into_contact_id AS next_id,ARRAY[c.id] AS visited,c.deleted_at
        FROM crm_contacts c WHERE c.user_id=${userId} AND c.business_profile_id=${business}
      UNION ALL
      SELECT p.contact_id,target.id,target.merged_into_contact_id,p.visited||target.id,target.deleted_at
        FROM paths p JOIN crm_contacts target ON target.id=p.next_id AND target.user_id=${userId} AND target.business_profile_id=${business}
        WHERE NOT target.id=ANY(p.visited) AND cardinality(p.visited)<32
    ) SELECT contact_id,current_id AS root_id FROM paths WHERE next_id IS NULL AND deleted_at IS NULL
  ), customer_leads AS (
    SELECT lead_id,'contact:'||MIN(root_id) AS customer_key FROM (
      SELECT contact.lead_id,root.root_id FROM crm_contacts contact JOIN contact_roots root ON root.contact_id=contact.id
        WHERE contact.user_id=${userId} AND contact.business_profile_id=${business} AND contact.lead_id IS NOT NULL
      UNION
      SELECT identity.lead_id,root.root_id FROM crm_contact_channel_identities identity JOIN contact_roots root ON root.contact_id=identity.contact_id
        WHERE identity.user_id=${userId} AND identity.business_profile_id=${business} AND identity.lead_id IS NOT NULL
      UNION
      SELECT conversation.lead_id,root.root_id FROM outreach_conversations conversation JOIN contact_roots root ON root.contact_id=conversation.crm_contact_id
        WHERE conversation.user_id=${userId} AND conversation.business_profile_id=${business} AND conversation.lead_id IS NOT NULL
    ) linked GROUP BY lead_id HAVING COUNT(DISTINCT root_id)=1
  ), conversation_customers AS (
    SELECT c.id,COALESCE('contact:'||root.root_id,lead.customer_key,'lead:'||c.lead_id) AS customer_key
      FROM outreach_conversations c LEFT JOIN contact_roots root ON root.contact_id=c.crm_contact_id
      LEFT JOIN customer_leads lead ON lead.lead_id=c.lead_id
      WHERE c.user_id=${userId} AND c.business_profile_id=${business}
  )`;
}
