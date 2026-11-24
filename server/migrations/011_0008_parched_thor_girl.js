/**
 * Migration: 0008_parched_thor_girl
 * Source: migrations/0008_parched_thor_girl.sql
 * Generated: 2026-03-06T08:18:41.019Z
 */

export async function up(client) {
    await client.query(`CREATE TABLE IF NOT EXISTS "admin_api_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"api_key" text NOT NULL,
	"api_secret" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" varchar(20) DEFAULT 'normal' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"last_used_at" timestamp,
	"usage_count" varchar(50) DEFAULT '0',
	"deactivation_reason" varchar(100),
	"deactivated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "admins" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" varchar(50) DEFAULT 'admin' NOT NULL,
	"is_verified" boolean DEFAULT true NOT NULL,
	"avatar" text,
	"phone" varchar(50),
	"reset_password_token" text,
	"reset_password_token_expiry" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admins_email_unique" UNIQUE("email")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "user_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"based_on_profile" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "company_size" varchar(50)`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "business_goals" jsonb`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "primary_market" varchar(100)`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "target_regions" jsonb`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "customer_type" varchar(100)`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "key_buyer_roles" jsonb`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "primary_color" varchar(7)`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "secondary_color" varchar(7)`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "accent_color" varchar(7)`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "platforms" jsonb`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "content_formats" jsonb`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "visual_style" varchar(100)`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "reference_accounts" text`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "preferred_channels" jsonb`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "brand_tone" varchar(100)`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "approval_mode" varchar(100)`);

    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "restrictions" text`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "platforms" text`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "content_formats" text`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "visual_style" varchar(100)`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "reference_accounts" text`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "business_goals" text`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "target_regions" text`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "customer_type" varchar(100)`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "key_buyer_roles" text`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "preferred_channels" text`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "brand_tone" varchar(100)`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "approval_mode" varchar(100)`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "restrictions" text`);

    await client.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_setup_complete" boolean DEFAULT false NOT NULL`);

    await client.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_approved" boolean DEFAULT false NOT NULL`);

    await client.query(`ALTER TABLE "user_suggestions" ADD CONSTRAINT "user_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0008_parched_thor_girl)');
}
