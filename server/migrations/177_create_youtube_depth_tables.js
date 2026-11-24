/** Persist provider-normalized analytics separately from raw YouTube responses. */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS youtube_analytics_snapshots (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      credential_id INTEGER NOT NULL,
      channel_id VARCHAR(255) NOT NULL,
      video_id VARCHAR(255) NOT NULL DEFAULT '__channel__',
      metric_date VARCHAR(10) NOT NULL,
      metrics JSONB NOT NULL,
      synced_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS youtube_analytics_snapshots_tenant_video_date_uq
      ON youtube_analytics_snapshots(user_id, credential_id, channel_id, video_id, metric_date);
    CREATE INDEX IF NOT EXISTS youtube_analytics_snapshots_tenant_synced_idx
      ON youtube_analytics_snapshots(user_id, credential_id, synced_at DESC);
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS youtube_analytics_snapshots;');
}
