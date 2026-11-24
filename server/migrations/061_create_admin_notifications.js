/**
 * Migration 061: Create admin_notifications table
 */

/** @param {import("postgres").client} client */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_notifications (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      category TEXT NOT NULL DEFAULT 'general',
      read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_notifications_admin_id ON admin_notifications(admin_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_notifications_read ON admin_notifications(admin_id, read);`);
}

/** @param {import("postgres").client} client */
export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS admin_notifications;`);
}
