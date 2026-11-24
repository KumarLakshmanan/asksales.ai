/**
 * Add the non-extraction state and enforce one generated TTS object per
 * outreach reply message. Existing attachment rows are unchanged.
 */
export async function up(client) {
  await client.query(`
    DO $$
    DECLARE check_name TEXT;
    BEGIN
      SELECT conname INTO check_name
      FROM pg_constraint
      WHERE conrelid = 'outreach_message_attachments'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%extraction_status%';
      IF check_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE outreach_message_attachments DROP CONSTRAINT %I', check_name);
      END IF;
    END $$;

    ALTER TABLE outreach_message_attachments
      ADD CONSTRAINT outreach_message_attachments_extraction_status_check
      CHECK (extraction_status IN (
        'pending', 'success', 'empty', 'unsupported', 'failed', 'quarantined', 'not_applicable'
      ));

    CREATE UNIQUE INDEX IF NOT EXISTS outreach_message_attachments_tts_message_uq
      ON outreach_message_attachments(message_id, source)
      WHERE message_id IS NOT NULL AND source = 'tts';
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS outreach_message_attachments_tts_message_uq;
    UPDATE outreach_message_attachments
    SET extraction_status = 'unsupported',
        extraction_error = COALESCE(extraction_error, 'Generated voice output is not used as inbound AI context.')
    WHERE extraction_status = 'not_applicable';
    ALTER TABLE outreach_message_attachments
      DROP CONSTRAINT IF EXISTS outreach_message_attachments_extraction_status_check;
    ALTER TABLE outreach_message_attachments
      ADD CONSTRAINT outreach_message_attachments_extraction_status_check
      CHECK (extraction_status IN (
        'pending', 'success', 'empty', 'unsupported', 'failed', 'quarantined'
      ));
  `);
}
