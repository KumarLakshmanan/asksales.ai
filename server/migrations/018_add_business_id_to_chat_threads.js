/**
 * Migration: add_business_id_to_chat_threads
 * Source: migrations/add_business_id_to_chat_threads.sql
 * Generated: 2026-03-06
 */

export async function up(client) {
    await client.query(`
        ALTER TABLE "chat_threads"
        ADD COLUMN IF NOT EXISTS "business_id" integer,
        ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'
    `);

    // Add FK constraint (ignore if already exists)
    await client.query(`
        DO $$ BEGIN
            ALTER TABLE "chat_threads"
            ADD CONSTRAINT "chat_threads_business_id_company_settings_id_fk"
            FOREIGN KEY ("business_id") REFERENCES "public"."company_settings"("id")
            ON DELETE no action ON UPDATE no action;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
    `);

    await client.query(`
        CREATE INDEX IF NOT EXISTS "chat_threads_business_id_idx"
        ON "chat_threads" USING btree ("business_id")
    `);
}

export async function down(client) {
    await client.query(`DROP INDEX IF EXISTS "chat_threads_business_id_idx"`);
    await client.query(`ALTER TABLE "chat_threads" DROP CONSTRAINT IF EXISTS "chat_threads_business_id_company_settings_id_fk"`);
    await client.query(`ALTER TABLE "chat_threads" DROP COLUMN IF EXISTS "metadata"`);
    await client.query(`ALTER TABLE "chat_threads" DROP COLUMN IF EXISTS "business_id"`);
}
