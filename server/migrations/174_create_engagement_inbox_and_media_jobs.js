/** Tenant-scoped operational state for the unified social engagement inbox. */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS engagement_inbox_state (
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id integer NOT NULL REFERENCES outreach_conversations(id) ON DELETE CASCADE,
      assigned_to integer REFERENCES users(id) ON DELETE SET NULL,
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      claimed_by integer REFERENCES users(id) ON DELETE SET NULL,
      claimed_at timestamp,
      claim_expires_at timestamp,
      first_inbound_at timestamp,
      first_response_at timestamp,
      due_at timestamp,
      updated_at timestamp NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS engagement_inbox_state_claim_idx ON engagement_inbox_state(user_id, claimed_by, claim_expires_at);
    CREATE TABLE IF NOT EXISTS engagement_saved_replies (
      id bigserial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title varchar(120) NOT NULL,
      body text NOT NULL,
      channels jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamp NOT NULL DEFAULT NOW(),
      updated_at timestamp NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, title)
    );
    CREATE TABLE IF NOT EXISTS media_transcode_jobs (
      id uuid PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id integer REFERENCES content_assets(id) ON DELETE SET NULL,
      source_url text NOT NULL,
      platform varchar(32) NOT NULL,
      status varchar(24) NOT NULL DEFAULT 'queued',
      probe jsonb,
      output_url text,
      error_code varchar(64),
      error_message text,
      attempts integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT NOW(),
      updated_at timestamp NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS media_transcode_jobs_user_status_idx ON media_transcode_jobs(user_id, status, created_at DESC);
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS media_transcode_jobs, engagement_saved_replies, engagement_inbox_state');
}
