/**
 * Migration: 0001_flimsy_shen
 * Source: migrations/0001_flimsy_shen.sql
 * Generated: 2026-03-06T08:18:40.538Z
 */

export async function up(client) {
    await client.query(`CREATE TYPE "public"."workflow_log_status" AS ENUM('pending', 'running', 'completed', 'error', 'paused', 'cancelled')`);

    await client.query(`CREATE TYPE "public"."workflow_log_type" AS ENUM('workflow_start', 'workflow_complete', 'workflow_error', 'actor_start', 'actor_progress', 'actor_complete', 'actor_error', 'lead_saved', 'step', 'warning', 'info')`);

    await client.query(`CREATE TABLE IF NOT EXISTS "api_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"service_name" varchar(100) NOT NULL,
	"api_key" text,
	"api_secret" text,
	"config" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_credentials_user_id_service_name_unique" UNIQUE("user_id","service_name")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "campaign_performance_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"platform" varchar(50) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"platform_entity_id" varchar(255) NOT NULL,
	"name" varchar(500),
	"status" varchar(50),
	"parent_entity_id" varchar(255),
	"impressions" integer DEFAULT 0,
	"clicks" integer DEFAULT 0,
	"spend" numeric(12, 2) DEFAULT '0',
	"reach" integer DEFAULT 0,
	"ctr" numeric(8, 4) DEFAULT '0',
	"cpc" numeric(10, 2) DEFAULT '0',
	"cpm" numeric(10, 2) DEFAULT '0',
	"conversions" integer DEFAULT 0,
	"conversion_value" numeric(12, 2) DEFAULT '0',
	"raw_data" jsonb,
	"last_refreshed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "knowledge_base" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" varchar(500),
	"content" text,
	"type" varchar(50) DEFAULT 'document' NOT NULL,
	"file_name" varchar(255),
	"file_type" varchar(100),
	"file_size" integer,
	"question" text,
	"answer" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "workflow_activity_executions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"thread_id" integer,
	"execution_id" varchar(255) NOT NULL,
	"workflow_name" varchar(255),
	"platforms" json,
	"status" "workflow_log_status" DEFAULT 'pending' NOT NULL,
	"total_leads_expected" integer,
	"total_leads_generated" integer DEFAULT 0,
	"platforms_completed" integer DEFAULT 0,
	"platforms_total" integer,
	"input_params" json,
	"result" json,
	"error_message" text,
	"is_paused" boolean DEFAULT false,
	"paused_at" timestamp,
	"resumed_at" timestamp,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "workflow_activity_executions_execution_id_unique" UNIQUE("execution_id")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "workflow_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"thread_id" integer,
	"execution_id" varchar(255) NOT NULL,
	"log_type" "workflow_log_type" DEFAULT 'info' NOT NULL,
	"status" "workflow_log_status" DEFAULT 'running',
	"platform" varchar(100),
	"actor_id" varchar(255),
	"actor_name" varchar(255),
	"node_id" varchar(255),
	"message" text NOT NULL,
	"details" json,
	"leads_count" integer,
	"total_leads" integer,
	"progress_percent" integer,
	"error_message" text,
	"error_stack" text,
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`ALTER TABLE "ad_platform_credentials" DISABLE ROW LEVEL SECURITY`);

    await client.query(`DROP TABLE "ad_platform_credentials" CASCADE`);

    await client.query(`DROP INDEX "company_settings_business_type_idx"`);

    await client.query(`DROP INDEX "icp_profiles_growth_stage_idx"`);

    await client.query(`DROP INDEX "icp_profiles_company_size_idx"`);

    await client.query(`ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "profile_type" varchar(50)`);

    await client.query(`ALTER TABLE "icp_profiles" ADD COLUMN IF NOT EXISTS "target_company_size_range" varchar(100)`);

    await client.query(`ALTER TABLE "icp_profiles" ADD COLUMN IF NOT EXISTS "target_revenue_range" varchar(100)`);

    await client.query(`ALTER TABLE "icp_profiles" ADD COLUMN IF NOT EXISTS "target_business_model" varchar(100)`);

    await client.query(`ALTER TABLE "outreach_settings" ADD COLUMN IF NOT EXISTS "follow_up_steps" jsonb DEFAULT '[]'::jsonb`);

    await client.query(`ALTER TABLE "sent_messages" ADD COLUMN IF NOT EXISTS "subject" text`);

    await client.query(`ALTER TABLE "sent_messages" ADD COLUMN IF NOT EXISTS "follow_up_step" integer`);

    await client.query(`ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "workflow_activity_executions" ADD CONSTRAINT "workflow_activity_executions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "workflow_activity_executions" ADD CONSTRAINT "workflow_activity_executions_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`ALTER TABLE "workflow_logs" ADD CONSTRAINT "workflow_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "workflow_logs" ADD CONSTRAINT "workflow_logs_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`CREATE INDEX IF NOT EXISTS "company_settings_profile_type_idx" ON "company_settings" USING btree ("profile_type")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "sent_messages_follow_up_step_idx" ON "sent_messages" USING btree ("follow_up_step")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_company_size_idx" ON "icp_profiles" USING btree ("target_company_size_range")`);

    await client.query(`ALTER TABLE "company_settings" DROP COLUMN IF EXISTS "business_type"`);

    await client.query(`ALTER TABLE "icp_profiles" DROP COLUMN IF EXISTS "company_size_range"`);

    await client.query(`ALTER TABLE "icp_profiles" DROP COLUMN IF EXISTS "company_revenue"`);

    await client.query(`ALTER TABLE "icp_profiles" DROP COLUMN IF EXISTS "business_model"`);

    await client.query(`ALTER TABLE "icp_profiles" DROP COLUMN IF EXISTS "company_address"`);

    await client.query(`ALTER TABLE "icp_profiles" DROP COLUMN IF EXISTS "company_website"`);

    await client.query(`ALTER TABLE "icp_profiles" DROP COLUMN IF EXISTS "company_start_date"`);

    await client.query(`ALTER TABLE "icp_profiles" DROP COLUMN IF EXISTS "company_age"`);

    await client.query(`ALTER TABLE "icp_profiles" DROP COLUMN IF EXISTS "company_growth_stage"`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0001_flimsy_shen)');
}
