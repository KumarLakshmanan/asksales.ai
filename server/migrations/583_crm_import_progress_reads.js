/** Progress counters commit atomically with row receipts. Reconcile historical
 * counters once, then index the small warning/issue subsets used by polling. */
export async function up(client) {
  await client.query(`
    CREATE INDEX crm_import_warning_progress_idx ON crm_contact_import_details(import_id,business_profile_id)
      WHERE status='warning';
    CREATE INDEX crm_import_issue_preview_idx ON crm_contact_import_details(import_id,business_profile_id,row_number)
      WHERE status IN('warning','duplicate','skipped','failed','blocked') AND error_message IS NOT NULL;
    DO $$
    DECLARE previous_system text:=current_setting('app.business_system',true);
    BEGIN
      PERFORM set_config('app.business_system','on',true);
      UPDATE crm_contact_imports batch SET
        success_count=totals.success_count,error_count=totals.error_count,
        skipped_count=totals.skipped_count,processed_records=totals.processed_records
      FROM (SELECT batch.id,
          count(detail.id) FILTER(WHERE detail.status IN('success','warning'))::int AS success_count,
          count(detail.id) FILTER(WHERE detail.status='failed')::int AS error_count,
          count(detail.id) FILTER(WHERE detail.status='skipped')::int AS skipped_count,
          count(detail.id) FILTER(WHERE detail.status IN('success','warning','duplicate','skipped','failed'))::int AS processed_records
        FROM crm_contact_imports batch LEFT JOIN crm_contact_import_details detail
          ON detail.import_id=batch.id AND detail.business_profile_id=batch.business_profile_id GROUP BY batch.id) totals
      WHERE batch.id=totals.id;
      PERFORM set_config('app.business_system',COALESCE(previous_system,''),true);
    END $$;
  `);
}
export async function down(client) {
  // Receipt-derived counters remain accurate when the older reader is restored.
  await client.query('DROP INDEX crm_import_warning_progress_idx,crm_import_issue_preview_idx');
}
