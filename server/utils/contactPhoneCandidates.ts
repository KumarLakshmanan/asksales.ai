import {sql} from 'drizzle-orm';

/** Index each identity route separately. An OR with a correlated identity
 * subquery otherwise scans every CRM contact even with a phone-key index.
 * Callers retain their final qualification and row locks on these candidates. */
export function contactPhoneCandidateIds(userId:number,businessProfileId:number|null,phone:string,fingerprint:string|null) {
  return sql`SELECT matched.id FROM crm_contacts matched
    WHERE matched.user_id=${userId} AND matched.deleted_at IS NULL
      AND matched.business_profile_id IS NOT DISTINCT FROM ${businessProfileId}::integer
      AND matched.phone_lookup_digits=${phone}
    UNION
    SELECT lookup_identity.contact_id AS id FROM crm_contact_channel_identities lookup_identity
    WHERE lookup_identity.user_id=${userId}
      AND lookup_identity.business_profile_id IS NOT DISTINCT FROM ${businessProfileId}::integer
      AND lookup_identity.identifier_type='phone' AND lookup_identity.identifier_fingerprint=${fingerprint}
      AND lookup_identity.verification_level IN('provider','customer_verified','owner_verified')`;
}
