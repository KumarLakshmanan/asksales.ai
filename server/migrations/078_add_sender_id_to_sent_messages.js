export async function up(client) {
  await client.query(`ALTER TABLE "sent_messages" ADD COLUMN IF NOT EXISTS "sender_id" integer REFERENCES "email_senders"("id") ON DELETE SET NULL`);
  await client.query(`CREATE INDEX IF NOT EXISTS "sent_messages_sender_id_idx" ON "sent_messages" USING btree ("sender_id")`);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS "sent_messages_sender_id_idx"`);
  await client.query(`ALTER TABLE "sent_messages" DROP COLUMN IF EXISTS "sender_id"`);
}
