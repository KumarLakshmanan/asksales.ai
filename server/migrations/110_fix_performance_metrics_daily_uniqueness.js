/**
 * Migration 110: align daily ad metrics with the canonical schema and make
 * repeated ingestion idempotent when hour is NULL.
 */
export async function up(client) {
  await client.query(`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY campaign_id, date
               ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
             ) AS row_number
      FROM performance_metrics
      WHERE hour IS NULL
    )
    DELETE FROM performance_metrics metrics
    USING ranked
    WHERE metrics.id = ranked.id
      AND ranked.row_number > 1
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS performance_metrics_daily_unique
      ON performance_metrics(campaign_id, date)
      WHERE hour IS NULL
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS performance_metrics_daily_unique`);
}
