export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id SERIAL PRIMARY KEY,
      platform VARCHAR(50) NOT NULL,
      event_type VARCHAR(100),
      page_id VARCHAR(100),
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      payload JSONB,
      signature_valid BOOLEAN DEFAULT TRUE,
      processed BOOLEAN DEFAULT FALSE,
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_platform ON webhook_events(platform);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_page_id ON webhook_events(page_id);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_user_id ON webhook_events(user_id);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at ON webhook_events(created_at);
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS webhook_events;`);
}
