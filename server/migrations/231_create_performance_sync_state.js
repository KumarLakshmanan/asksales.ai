/** Durable cadence and leases for read-only provider synchronization. */
export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS performance_sync_state (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind VARCHAR(24) NOT NULL CHECK (kind IN ('paid_meta', 'social')),
    resource_key VARCHAR(255) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'pending',
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    last_attempt_at TIMESTAMPTZ,
    last_succeeded_at TIMESTAMPTZ,
    next_due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    error_code VARCHAR(100),
    PRIMARY KEY (user_id, kind, resource_key)
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS performance_sync_due_idx ON performance_sync_state(kind, next_due_at)`);
  const runtimeRole = process.env.DB_RUNTIME_USER;
  if (runtimeRole) {
    const quotedRole = `"${runtimeRole.replaceAll('"', '""')}"`;
    await client.query(`GRANT SELECT, INSERT, UPDATE ON performance_sync_state TO ${quotedRole}`);
  }
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS performance_sync_state');
}
