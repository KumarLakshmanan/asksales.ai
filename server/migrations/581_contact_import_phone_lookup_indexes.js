// A stored key lets PostgreSQL use phone lookups before evaluating RLS. An
// expression index alone cannot push normalization through the RLS barrier.
// Invalid free-form fields stay unchanged and cannot create oversized keys.
const phoneKey=`CASE WHEN regexp_replace(normalize(phone, NFKC), '[^0-9]', '', 'g') ~ '^[0-9]{7,17}$'
  THEN regexp_replace(normalize(phone, NFKC), '[^0-9]', '', 'g') ELSE NULL END`;
export async function up(client) {
  await client.query(`
    ALTER TABLE crm_contacts ADD COLUMN phone_lookup_digits text GENERATED ALWAYS AS (${phoneKey}) STORED;
    ALTER TABLE leads ADD COLUMN phone_lookup_digits text GENERATED ALWAYS AS (${phoneKey}) STORED;
    CREATE INDEX contact_import_phone_lookup_idx ON crm_contacts
      (user_id, phone_lookup_digits, business_profile_id)
      WHERE deleted_at IS NULL;
    CREATE INDEX lead_import_phone_lookup_idx ON leads
      (user_id, phone_lookup_digits, business_profile_id)
      WHERE deleted_at IS NULL;
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX contact_import_phone_lookup_idx, lead_import_phone_lookup_idx;
    ALTER TABLE crm_contacts DROP COLUMN phone_lookup_digits;
    ALTER TABLE leads DROP COLUMN phone_lookup_digits;`);
}
