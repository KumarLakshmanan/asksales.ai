const legacyStates = "'local_draft', 'submitted', 'pending', 'approved', 'rejected', 'paused', 'disabled'";

export async function up(client) {
  await client.query(`ALTER TABLE whatsapp_templates
    DROP CONSTRAINT IF EXISTS whatsapp_templates_submission_status_check,
    ADD CONSTRAINT whatsapp_templates_submission_status_check CHECK (
      submission_status IN (${legacyStates}, 'submitting', 'submission_uncertain', 'submission_failed', 'identity_conflict')
    )`);
}

export async function down(client) {
  // Never silently reclassify an uncertain provider operation as an ordinary
  // draft during rollback. Reconcile it before tightening the constraint.
  const unresolved = await client.query(`SELECT 1 FROM whatsapp_templates
    WHERE submission_status NOT IN (${legacyStates}) LIMIT 1`);
  if (unresolved.rows.length) throw new Error('Reconcile outstanding WhatsApp template submissions before rolling back migration 245.');
  await client.query(`ALTER TABLE whatsapp_templates
    DROP CONSTRAINT IF EXISTS whatsapp_templates_submission_status_check,
    ADD CONSTRAINT whatsapp_templates_submission_status_check CHECK (submission_status IN (${legacyStates}))`);
}
