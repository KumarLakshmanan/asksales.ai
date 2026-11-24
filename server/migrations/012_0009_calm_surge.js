/**
 * Migration: 0009_calm_surge
 * Source: migrations/0009_calm_surge.sql
 * Generated: 2026-03-06T08:18:41.075Z
 */

export async function up(client) {
    await client.query(`CREATE TABLE IF NOT EXISTS "credit_event_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"event_key" varchar(100) NOT NULL,
	"credits_used" numeric(10, 2) NOT NULL,
	"balance_after" numeric(12, 2) NOT NULL,
	"description" text,
	"service" varchar(100),
	"reference_type" varchar(100),
	"reference_id" varchar(255),
	"api_provider" varchar(50),
	"api_cost_cents" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "credit_pricing" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_key" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(50) NOT NULL,
	"credits_per_unit" numeric(10, 2) DEFAULT '1' NOT NULL,
	"unit_label" varchar(100),
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_pricing_event_key_unique" UNIQUE("event_key")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "wallet_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" varchar(50) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"balance_after" numeric(12, 2) NOT NULL,
	"description" text NOT NULL,
	"category" varchar(100),
	"reference_type" varchar(100),
	"reference_id" varchar(255),
	"payment_provider" varchar(50),
	"payment_id" varchar(255),
	"payment_order_id" varchar(255),
	"amount_paid" numeric(12, 2),
	"currency" varchar(10) DEFAULT 'INR',
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_credits_added" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_credits_used" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_user_id_unique" UNIQUE("user_id")
)`);

    await client.query(`ALTER TABLE "credit_event_logs" ADD CONSTRAINT "credit_event_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0009_calm_surge)');
}
