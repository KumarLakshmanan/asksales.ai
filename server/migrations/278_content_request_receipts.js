export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS content_request_receipts (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_key varchar(200) NOT NULL,
    request_hash varchar(64) NOT NULL,
    state varchar(20) NOT NULL DEFAULT 'pending',
    status_code integer,
    response_body jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    completed_at timestamptz,
    PRIMARY KEY(user_id, request_key)
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS content_request_receipts_retention_idx ON content_request_receipts(user_id, completed_at) WHERE state='complete'`);
}
export async function down(client) {
  await client.query('DROP TABLE IF EXISTS content_request_receipts');
}
