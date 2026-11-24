export async function up(client) {
  await client.query(`
    ALTER TABLE "outreach_messages" 
    ADD COLUMN IF NOT EXISTS "waba_message_id" varchar(255),
    ADD COLUMN IF NOT EXISTS "phone_number_id" varchar(255),
    ADD COLUMN IF NOT EXISTS "message_type" varchar(50);
  `);
  
  await client.query(`
    ALTER TABLE "outreach_messages"
    ADD CONSTRAINT "outreach_messages_waba_message_id_unique" UNIQUE ("waba_message_id");
  `);
  
  await client.query(`
    CREATE INDEX IF NOT EXISTS "outreach_messages_waba_message_id_idx" ON "outreach_messages" ("waba_message_id");
  `);
  
  await client.query(`
    CREATE INDEX IF NOT EXISTS "outreach_messages_phone_number_id_idx" ON "outreach_messages" ("phone_number_id");
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE "outreach_messages"
    DROP CONSTRAINT IF EXISTS "outreach_messages_waba_message_id_unique";
  `);

  await client.query(`
    DROP INDEX IF EXISTS "outreach_messages_waba_message_id_idx";
  `);

  await client.query(`
    DROP INDEX IF EXISTS "outreach_messages_phone_number_id_idx";
  `);

  await client.query(`
    ALTER TABLE "outreach_messages"
    DROP COLUMN IF EXISTS "waba_message_id",
    DROP COLUMN IF EXISTS "phone_number_id",
    DROP COLUMN IF EXISTS "message_type";
  `);
}
