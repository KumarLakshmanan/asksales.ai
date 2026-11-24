/**
 * Migration 123: Guarantee exactly one default brand toolkit per user when
 * toolkits exist, and prevent concurrent writes from creating two defaults.
 */

export async function up(client) {
  await client.query(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id
          ORDER BY is_default DESC, updated_at DESC, id DESC
        ) AS position
      FROM brand_toolkits
    )
    UPDATE brand_toolkits AS toolkit
    SET is_default = (ranked.position = 1)
    FROM ranked
    WHERE toolkit.id = ranked.id
      AND toolkit.is_default IS DISTINCT FROM (ranked.position = 1)
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS brand_toolkits_one_default_per_user_uq
    ON brand_toolkits(user_id)
    WHERE is_default = TRUE
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS brand_toolkits_one_default_per_user_uq`);
}
