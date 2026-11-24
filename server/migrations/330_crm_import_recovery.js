/** Durable import identity and atomic row-progress receipts. No customer rows
 * are merged/deleted. Duplicate historical row receipts require owner review. */
export async function up(client) {
  const duplicates =
    await client.query(`SELECT import_id,row_number FROM crm_contact_import_details
    GROUP BY import_id,row_number HAVING count(*)>1 LIMIT 1`);
  if (duplicates.rows.length)
    throw new Error(
      "Duplicate import row receipts exist; review them before applying import recovery. No receipts were changed.",
    );
  // The ownership trigger still checks UPDATEs made by the migration owner.
  // Limit system scope to this transactional backfill.
  await client.query(`SELECT set_config('app.business_system','on',true);
    ALTER TABLE crm_contact_imports ADD COLUMN IF NOT EXISTS request_fingerprint varchar(64);
    ALTER TABLE crm_contact_imports ADD COLUMN IF NOT EXISTS processed_records integer NOT NULL DEFAULT 0;
    UPDATE crm_contact_imports p SET processed_records=(SELECT count(*) FROM crm_contact_import_details d WHERE d.import_id=p.id AND d.status IN ('success','warning','duplicate','skipped','failed'));
    CREATE UNIQUE INDEX IF NOT EXISTS crm_import_fingerprint_uq ON crm_contact_imports(business_profile_id,user_id,request_fingerprint) WHERE request_fingerprint IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS crm_import_row_receipt_uq ON crm_contact_import_details(import_id,row_number);
    SELECT set_config('app.business_system','off',true);`);
}
export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS crm_import_row_receipt_uq;
    DROP INDEX IF EXISTS crm_import_fingerprint_uq;
    ALTER TABLE crm_contact_imports DROP COLUMN IF EXISTS processed_records;
    ALTER TABLE crm_contact_imports DROP COLUMN IF EXISTS request_fingerprint;`);
}
