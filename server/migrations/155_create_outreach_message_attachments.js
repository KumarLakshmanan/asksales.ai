/**
 * Normalize outreach attachments and preserve independent storage, extraction,
 * and provider-delivery state.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS outreach_message_attachments (
      id SERIAL PRIMARY KEY,
      public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id INTEGER REFERENCES outreach_messages(id) ON DELETE CASCADE,
      storage_file_id INTEGER REFERENCES storage_files(id) ON DELETE RESTRICT,
      direction VARCHAR(20) NOT NULL,
      source VARCHAR(30) NOT NULL DEFAULT 'upload',
      file_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(200) NOT NULL,
      file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
      sha256 VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      status VARCHAR(24) NOT NULL DEFAULT 'ready'
        CHECK (status IN ('ready', 'quarantined', 'failed')),
      extraction_status VARCHAR(24) NOT NULL DEFAULT 'pending'
        CHECK (extraction_status IN ('pending', 'success', 'empty', 'unsupported', 'failed', 'quarantined')),
      extracted_text TEXT,
      extraction_error TEXT,
      delivery_status VARCHAR(24) NOT NULL DEFAULT 'pending'
        CHECK (delivery_status IN ('pending', 'sent', 'failed', 'unsupported', 'received')),
      delivery_error TEXT,
      provider_attachment_id VARCHAR(255),
      provider_media_id VARCHAR(255),
      metadata JSONB NOT NULL DEFAULT '{}',
      expires_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CHECK (
        (message_id IS NULL AND expires_at IS NOT NULL)
        OR (message_id IS NOT NULL AND expires_at IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS outreach_message_attachments_user_idx
      ON outreach_message_attachments(user_id);
    CREATE INDEX IF NOT EXISTS outreach_message_attachments_message_idx
      ON outreach_message_attachments(message_id);
    CREATE INDEX IF NOT EXISTS outreach_message_attachments_storage_file_idx
      ON outreach_message_attachments(storage_file_id);
    CREATE INDEX IF NOT EXISTS outreach_message_attachments_staged_expiry_idx
      ON outreach_message_attachments(expires_at)
      WHERE message_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS outreach_message_attachments_message_file_uq
      ON outreach_message_attachments(message_id, storage_file_id)
      WHERE message_id IS NOT NULL AND storage_file_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS outreach_message_attachments_provider_uq
      ON outreach_message_attachments(user_id, provider_attachment_id)
      WHERE provider_attachment_id IS NOT NULL;
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS outreach_message_attachments`);
}
