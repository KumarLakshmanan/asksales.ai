/**
 * Migration: 0004_swift_rattler
 * Source: migrations/0004_swift_rattler.sql
 * Generated: 2026-03-06T08:18:40.859Z
 */

export async function up(client) {
    await client.query(`CREATE TABLE IF NOT EXISTS "gemini_usages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"operation_type" varchar(50) NOT NULL,
	"model" varchar(100) NOT NULL,
	"prompt" text,
	"input_tokens" integer DEFAULT 0,
	"output_tokens" integer DEFAULT 0,
	"images_generated" integer DEFAULT 0,
	"videos_generated" integer DEFAULT 0,
	"cost_cents" numeric(10, 4) DEFAULT '0',
	"service" varchar(100),
	"purpose" varchar(100),
	"status" varchar(20) DEFAULT 'success',
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "zerobounce_usages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"operation_type" varchar(50) NOT NULL,
	"emails_validated" integer DEFAULT 0,
	"valid_emails" integer DEFAULT 0,
	"invalid_emails" integer DEFAULT 0,
	"catch_all_emails" integer DEFAULT 0,
	"unknown_emails" integer DEFAULT 0,
	"credits_used" integer DEFAULT 0,
	"cost_cents" numeric(10, 4) DEFAULT '0',
	"service" varchar(100),
	"purpose" varchar(100),
	"batch_id" varchar(100),
	"status" varchar(20) DEFAULT 'success',
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`ALTER TABLE "gemini_usages" ADD CONSTRAINT "gemini_usages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "zerobounce_usages" ADD CONSTRAINT "zerobounce_usages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0004_swift_rattler)');
}
