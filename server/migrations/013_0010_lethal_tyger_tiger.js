/**
 * Migration: 0010_lethal_tyger_tiger
 * Source: migrations/0010_lethal_tyger_tiger.sql
 * Generated: 2026-03-06T08:18:41.081Z
 */

export async function up(client) {
    await client.query(`ALTER TABLE "ai_settings" DROP CONSTRAINT "ai_settings_user_id_users_id_fk"`);

    await client.query(`ALTER TABLE "brand_toolkits" DROP CONSTRAINT "brand_toolkits_user_id_users_id_fk"`);

    await client.query(`ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_user_id_users_id_fk"`);

    await client.query(`ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_user_id_users_id_fk"`);

    await client.query(`ALTER TABLE "company_profiles" DROP CONSTRAINT "company_profiles_user_id_users_id_fk"`);

    await client.query(`ALTER TABLE "company_settings" DROP CONSTRAINT "company_settings_user_id_users_id_fk"`);

    await client.query(`ALTER TABLE "content_templates" DROP CONSTRAINT "content_templates_approved_by_users_id_fk"`);

    await client.query(`ALTER TABLE "lead_settings" DROP CONSTRAINT "lead_settings_user_id_users_id_fk"`);

    await client.query(`ALTER TABLE "outreach_settings" DROP CONSTRAINT "outreach_settings_user_id_users_id_fk"`);

    await client.query(`ALTER TABLE "user_preferences" DROP CONSTRAINT "user_preferences_user_id_users_id_fk"`);

    await client.query(`ALTER TABLE "lead_settings" ALTER COLUMN "lead_sources" SET DEFAULT '{"linkedin","google","justdial"}'`);

    await client.query(`ALTER TABLE "lead_inputs" ADD COLUMN IF NOT EXISTS "recommended_sub_workflows" jsonb`);

    await client.query(`ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "brand_toolkits" ADD CONSTRAINT "brand_toolkits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "content_templates" ADD CONSTRAINT "content_templates_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`ALTER TABLE "lead_settings" ADD CONSTRAINT "lead_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "outreach_settings" ADD CONSTRAINT "outreach_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0010_lethal_tyger_tiger)');
}
