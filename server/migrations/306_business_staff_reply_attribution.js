/** Keep the signed-in staff actor separate from the owner of ticket records. */
export async function up(db) {
  await db.query(
    `ALTER TABLE support_ticket_messages ADD COLUMN actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  );
}
export async function down(db) {
  await db.query(
    "ALTER TABLE support_ticket_messages DROP COLUMN actor_user_id",
  );
}
