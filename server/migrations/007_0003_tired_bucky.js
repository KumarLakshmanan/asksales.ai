/**
 * Migration: 0003_tired_bucky
 * Source: migrations/0003_tired_bucky.sql
 * Generated: 2026-03-06T08:18:40.714Z
 */

export async function up(client) {
    await client.query(`CREATE TABLE IF NOT EXISTS "apify_usages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"thread_id" integer,
	"workflow_id" varchar(100),
	"actor_id" varchar(255) NOT NULL,
	"actor_name" varchar(255),
	"run_id" varchar(100),
	"dataset_id" varchar(100),
	"purpose" varchar(100) NOT NULL,
	"service" varchar(100) NOT NULL,
	"action" varchar(255),
	"compute_units" numeric(10, 4),
	"data_transfer_gb" numeric(10, 6),
	"items_scraped" integer,
	"estimated_cost_cents" integer,
	"input_summary" text,
	"response_success" integer DEFAULT 1 NOT NULL,
	"error_message" text,
	"duration_ms" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
)`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0003_tired_bucky)');
}
