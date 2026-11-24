export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "whatsapp_templates" (
      "id" serial PRIMARY KEY,
      "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "name" varchar(255) NOT NULL,
      "language" varchar(50) NOT NULL DEFAULT 'en',
      "category" varchar(50) NOT NULL DEFAULT 'MARKETING',
      "status" varchar(50) NOT NULL DEFAULT 'DRAFT',
      "header" text,
      "body" text NOT NULL,
      "footer" text,
      "waba_template_id" varchar(255),
      "created_at" timestamp NOT NULL DEFAULT NOW(),
      "updated_at" timestamp NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS "whatsapp_templates_user_id_idx" ON "whatsapp_templates" ("user_id");
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS "whatsapp_templates_user_id_idx";`);
  await client.query(`DROP TABLE IF EXISTS "whatsapp_templates";`);
}
