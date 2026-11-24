/**
 * Add safe in-app destinations and prune legacy notification accumulation.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE notifications
      ADD COLUMN IF NOT EXISTS action_url TEXT;

    DELETE FROM notifications
    WHERE created_at < NOW() - INTERVAL '90 days';

    DELETE FROM notifications n
    USING (
      SELECT id
      FROM (
        SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS row_number
        FROM notifications
      ) ranked
      WHERE row_number > 1000
    ) overflow
    WHERE n.id = overflow.id;
  `);
}

export async function down(client) {
  await client.query(`ALTER TABLE notifications DROP COLUMN IF EXISTS action_url`);
}
