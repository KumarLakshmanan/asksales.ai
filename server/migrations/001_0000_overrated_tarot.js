/**
 * Migration: 0000_overrated_tarot
 * Source: migrations/0000_overrated_tarot.sql
 * Generated: 2026-03-06T08:18:40.481Z
 */

export async function up(client) {
    await client.query(`CREATE TABLE IF NOT EXISTS "ad_platform_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"platform" varchar(50) NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp,
	"ad_account_id" varchar(255),
	"customer_id" varchar(255),
	"developer_token" text,
	"account_name" varchar(255),
	"currency" varchar(10),
	"timezone" varchar(100),
	"is_active" boolean DEFAULT true,
	"connected_at" timestamp DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "ads" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"platform" varchar(50) NOT NULL,
	"ad_name" text NOT NULL,
	"status" varchar(50) NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"spend" numeric(10, 2) DEFAULT '0' NOT NULL,
	"ctr" numeric(5, 2) DEFAULT '0' NOT NULL,
	"cpc" numeric(10, 2) DEFAULT '0' NOT NULL,
	"creative_url" text,
	"targeting" text,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "agent_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"agent_type" varchar(50),
	"action" varchar(255),
	"input" jsonb,
	"output" jsonb,
	"thread_id" integer,
	"status" varchar(20),
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"agent_type" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'idle',
	"capabilities" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "ai_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"ai_model" text DEFAULT 'gpt-4',
	"temperature" real DEFAULT 0.7,
	"max_tokens" integer DEFAULT 2000,
	"enable_auto_response" boolean DEFAULT true,
	"enable_learning" boolean DEFAULT true,
	"response_delay" real DEFAULT 1,
	"confidence_threshold" real DEFAULT 0.8,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "ai_settings_user_id_unique" UNIQUE("user_id")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "approval_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"approval_type" varchar(50),
	"status" varchar(20) DEFAULT 'pending',
	"details" jsonb,
	"user_decision" varchar(20),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "array_iteration_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_mapping_id" integer NOT NULL,
	"source_array_path" text NOT NULL,
	"iteration_mode" varchar(50) DEFAULT 'sequential',
	"batch_size" integer,
	"item_reference_variable" text DEFAULT '_current_item',
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "brand_toolkits" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"tagline" text,
	"mission_statement" text,
	"brand_values" jsonb,
	"brand_keywords" jsonb,
	"logo_url" text,
	"logo_urls" jsonb,
	"logo_file_name" varchar(255),
	"logo_visibility" boolean DEFAULT true,
	"primary_brand_color" varchar(20),
	"secondary_brand_color" varchar(20),
	"accent_color" varchar(20),
	"primary_colors" jsonb,
	"secondary_colors" jsonb,
	"additional_colors" jsonb,
	"font_family" varchar(100),
	"fonts" jsonb,
	"image_style_reference" varchar(100),
	"voice_type" varchar(100),
	"custom_tone_guidelines" text,
	"voice_personality_traits" jsonb,
	"voice_dos" jsonb,
	"voice_donts" jsonb,
	"voice_keywords" jsonb,
	"default_ctas" jsonb,
	"default_hashtags" jsonb,
	"sample_content" jsonb,
	"content_pillars" jsonb,
	"content_formats" jsonb,
	"audience_pain_points" jsonb,
	"audience_goals" jsonb,
	"audience_language_style" jsonb,
	"audience_triggers" jsonb,
	"integration_tools" jsonb,
	"is_default" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "budget_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"workflow_id" integer,
	"name" varchar(255) NOT NULL,
	"description" text,
	"total_budget" numeric(12, 2) NOT NULL,
	"currency" varchar(10) DEFAULT 'USD',
	"start_date" timestamp NOT NULL,
	"end_date" timestamp NOT NULL,
	"channel_allocations" jsonb NOT NULL,
	"primary_objective" varchar(100) NOT NULL,
	"kpis" jsonb,
	"recommended_campaigns" jsonb,
	"recommended_budget_split" jsonb,
	"spent_amount" numeric(12, 2) DEFAULT '0',
	"remaining_budget" numeric(12, 2),
	"status" varchar(50) DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"status" varchar(50) NOT NULL,
	"budget" integer NOT NULL,
	"spent" integer NOT NULL,
	"metrics" jsonb NOT NULL,
	"user_id" integer NOT NULL,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "channel_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"platform" varchar(50) NOT NULL,
	"credential_type" varchar(50) NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"token_expiry" timestamp,
	"session_cookies" text,
	"session_data" jsonb,
	"api_key" text,
	"api_secret" text,
	"account_identifier" varchar(255),
	"account_name" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp,
	"last_refreshed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"thread_id" integer,
	"role" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"agent_type" varchar(100),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "chat_tab_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"tab_id" varchar(100) NOT NULL,
	"tab_type" varchar(50) NOT NULL,
	"tab_label" varchar(255) NOT NULL,
	"tab_order" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_tab_configs_thread_tab_id_unique" UNIQUE("thread_id","tab_id")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "chat_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"business_id" integer,
	"title" varchar(255),
	"selected_agent" varchar(255),
	"metadata" jsonb DEFAULT '{}',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "company_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"company_name" varchar(255) NOT NULL,
	"industry" varchar(255),
	"website" text,
	"email" varchar(255),
	"phone" varchar(50),
	"address" text,
	"description" text,
	"employees" varchar(50),
	"founded_year" varchar(10),
	"logo" text,
	"social_links" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "company_profiles_user_id_unique" UNIQUE("user_id")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "company_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(255),
	"business_type" varchar(10),
	"company_name" text,
	"industry" text,
	"sub_industry" text,
	"website" text,
	"company_size" varchar(50),
	"annual_revenue" varchar(50),
	"owner_name" text,
	"business_name" text,
	"business_category" text,
	"established_year" varchar(10),
	"business_hours" text,
	"phone" text,
	"email" text,
	"address" text,
	"city" text,
	"state" text,
	"country" text,
	"postal_code" text,
	"description" text,
	"target_market" text,
	"value_proposition" text,
	"linkedin_url" text,
	"twitter_url" text,
	"facebook_url" text,
	"instagram_url" text,
	"youtube_url" text,
	"is_default" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "connection_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"workflow_id" integer NOT NULL,
	"source_node_id" text NOT NULL,
	"target_node_id" text NOT NULL,
	"mappings" jsonb NOT NULL,
	"array_iteration_config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "content_asset_previews" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" varchar(50) NOT NULL,
	"message" text NOT NULL,
	"image_url" text,
	"video_url" text,
	"channel" varchar(50) NOT NULL,
	"lead_id" integer NOT NULL,
	"lead_name" text NOT NULL,
	"status" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "content_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"thread_id" integer,
	"type" varchar(50) NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"channel" varchar(50) NOT NULL,
	"status" varchar(50) NOT NULL,
	"image_url" text,
	"video_url" text,
	"image_urls" jsonb,
	"video_urls" jsonb,
	"performance" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "content_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"workflow_id" integer,
	"name" varchar(255) NOT NULL,
	"description" text,
	"content_type" varchar(100) NOT NULL,
	"target_audience" jsonb,
	"channels" jsonb,
	"topics" jsonb,
	"keywords" jsonb,
	"content_calendar" jsonb,
	"tone" varchar(100),
	"length" varchar(50),
	"format" varchar(100),
	"status" varchar(50) DEFAULT 'draft' NOT NULL,
	"generated_content" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "content_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"brand_toolkit_id" integer,
	"name" varchar(255) NOT NULL,
	"type" varchar(50) NOT NULL,
	"subject" text,
	"content" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb,
	"category" varchar(100),
	"tags" jsonb DEFAULT '[]'::jsonb,
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp,
	"is_approved" boolean DEFAULT false,
	"approved_by" integer,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "conversation_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"channel" varchar(20) NOT NULL,
	"platform_thread_id" varchar(255),
	"last_message_at" timestamp DEFAULT now() NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "db_save_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"workflow_id" integer NOT NULL,
	"db_save_node_id" text NOT NULL,
	"database_table" text NOT NULL,
	"field_mappings" jsonb NOT NULL,
	"batch_insert" boolean DEFAULT false,
	"on_conflict" varchar(50) DEFAULT 'skip',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "field_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_mapping_id" integer NOT NULL,
	"source_field_path" text NOT NULL,
	"target_field_path" text NOT NULL,
	"transformation_type" varchar(50) DEFAULT 'direct',
	"transformation_logic" text,
	"error_strategy" varchar(20) DEFAULT 'skip',
	"default_value" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "followup_sequences" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"campaign_id" integer,
	"recipient_email" varchar(255) NOT NULL,
	"recipient_name" varchar(255),
	"initial_subject" text NOT NULL,
	"initial_body" text NOT NULL,
	"initial_sent_at" timestamp NOT NULL,
	"thread_key" varchar(512) NOT NULL,
	"steps" jsonb NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"dead_lead" boolean DEFAULT false NOT NULL,
	"replied_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "icp_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"business_id" integer,
	"prompt_id" integer,
	"thread_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"campaign_name" varchar(255),
	"campaign_objective" text,
	"target_audience" text,
	"summary" text,
	"industry" varchar(255),
	"sub_industry" varchar(255),
	"company_size_range" varchar(100),
	"company_revenue" varchar(100),
	"business_model" varchar(100),
	"company_address" text,
	"company_website" varchar(500),
	"company_start_date" date,
	"company_age" varchar(50),
	"company_growth_stage" varchar(50),
	"primary_regions" jsonb,
	"primary_job_titles" jsonb,
	"budget_range" varchar(100),
	"primary_channels" jsonb,
	"fit_score" integer,
	"user_intent" varchar(100),
	"recommended_agent_scores" jsonb,
	"primary_value_proposition" text,
	"primary_pain_point" text,
	"status" varchar(50) DEFAULT 'active',
	"approved" boolean DEFAULT false,
	"approved_by" integer,
	"approved_at" timestamp,
	CONSTRAINT "icp_profiles_uuid_unique" UNIQUE("uuid")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "instagram_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"page_id" text,
	"sender_id" text,
	"recipient_id" text,
	"message_id" text,
	"message_text" text,
	"comment_id" text,
	"comment_text" text,
	"media_id" text,
	"timestamp" timestamp,
	"raw_data" jsonb,
	"processed_at" timestamp DEFAULT now(),
	"is_processed" boolean DEFAULT false,
	"ai_reply_generated" boolean DEFAULT false,
	"ai_reply_text" text,
	"created_at" timestamp DEFAULT now()
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "lead_gen_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"status" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"leads_found" integer DEFAULT 0 NOT NULL,
	"enriched" integer DEFAULT 0 NOT NULL,
	"outreached" integer DEFAULT 0 NOT NULL,
	"icp_data" jsonb,
	"strategy_data" jsonb,
	"channels" jsonb,
	"leads" jsonb,
	"sent_messages" jsonb
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "lead_inputs" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer,
	"thread_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"platform" varchar(50) NOT NULL,
	"inputs" jsonb NOT NULL,
	"schema" jsonb,
	"actor_id" varchar(255),
	"actor_name" varchar(255),
	"workflow_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "lead_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"min_lead_score" integer DEFAULT 70,
	"auto_qualify" boolean DEFAULT true,
	"enable_duplicate_check" boolean DEFAULT true,
	"auto_enrich" boolean DEFAULT true,
	"lead_sources" text[] DEFAULT '{"linkedin","google"}',
	"max_leads_per_day" integer DEFAULT 500,
	"notify_on_high_score" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "lead_settings_user_id_unique" UNIQUE("user_id")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"lead_code" varchar(50),
	"prompt_id" integer,
	"user_id" integer,
	"source" varchar(255) NOT NULL,
	"actor_id" varchar(255),
	"lead_type" varchar(100),
	"platform_type" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"scraped_at" timestamp,
	"registered_at" timestamp,
	"name" text,
	"first_name" varchar(255),
	"last_name" varchar(255),
	"full_name" text,
	"middle_name" varchar(255),
	"gender" varchar(50),
	"preferred_name" varchar(255),
	"profile_picture" text,
	"headline" text,
	"bio" text,
	"language" varchar(100),
	"timezone" varchar(255),
	"location" jsonb,
	"age_group" varchar(50),
	"email" text NOT NULL,
	"email_type" varchar(20),
	"email_status" varchar(20),
	"phone" text,
	"phone_type" varchar(20),
	"phone_country_code" varchar(10),
	"secondary_phone" text,
	"whatsapp" text,
	"telegram" text,
	"skype" text,
	"discord" text,
	"website" text,
	"calendar_link" text,
	"profile_id" varchar(255),
	"public_id" varchar(255),
	"profile_url" text,
	"post_url" text,
	"linkedin" text,
	"linkedin_url" text,
	"linkedin_username" varchar(255),
	"linkedin_follower_count" integer,
	"twitter" text,
	"twitter_url" text,
	"twitter_handle" varchar(255),
	"twitter_username" varchar(255),
	"twitter_followers" integer,
	"facebook" text,
	"facebook_url" text,
	"instagram" text,
	"instagram_url" text,
	"instagram_handle" varchar(255),
	"github" text,
	"youtube" text,
	"youtube_url" text,
	"medium" text,
	"tiktok" text,
	"behance" text,
	"dribbble" text,
	"followers_count" integer,
	"following_count" integer,
	"connections_count" integer,
	"posts_count" integer,
	"engagement_rate" numeric(5, 2),
	"verified" boolean DEFAULT false,
	"view_count" integer,
	"like_count" integer,
	"retweet_count" integer,
	"reply_count" integer,
	"quote_count" integer,
	"video_duration" varchar(20),
	"role" text,
	"seniority" varchar(100),
	"department" varchar(255),
	"function" varchar(255),
	"years_of_experience" integer,
	"current_job_started_at" timestamp,
	"previous_roles" jsonb,
	"skills" jsonb,
	"certifications" text,
	"education" jsonb,
	"company" text,
	"company_name" text,
	"company_legal_name" text,
	"company_domain" text,
	"company_linkedin" text,
	"company_size" varchar(100),
	"company_revenue" varchar(255),
	"industry" varchar(255),
	"sub_industry" varchar(255),
	"company_founded_year" integer,
	"company_phone" text,
	"company_emails" jsonb,
	"company_headquarters" jsonb,
	"company_locations" jsonb,
	"company_description" text,
	"company_tech_stack" jsonb,
	"funding_stage" varchar(100),
	"total_funding" varchar(255),
	"last_funding_date" timestamp,
	"investors" jsonb,
	"valuation" varchar(255),
	"public_company" boolean,
	"stock_symbol" varchar(20),
	"intent_score" integer,
	"intent_topics" jsonb,
	"website_visits" integer,
	"ad_clicks" integer,
	"search_keywords" jsonb,
	"recent_activity" jsonb,
	"fit_score" integer,
	"tier" varchar(50),
	"decision_maker" boolean,
	"budget_range" varchar(255),
	"pain_points" jsonb,
	"use_cases" jsonb,
	"address" text,
	"place_id" varchar(255),
	"rating" numeric(3, 2),
	"review_count" integer,
	"price_level" varchar(10),
	"opening_hours" jsonb,
	"permanently_closed" boolean DEFAULT false,
	"temporarily_closed" boolean DEFAULT false,
	"categories" jsonb,
	"google_url" text,
	"image_url" text,
	"plus_code" varchar(50),
	"google_maps_extended" jsonb,
	"about" text,
	"photo" text,
	"background_image" text,
	"premium" boolean DEFAULT false,
	"influencer" boolean DEFAULT false,
	"open_to_work" boolean DEFAULT false,
	"hiring" boolean DEFAULT false,
	"post_text" text,
	"hashtags" jsonb,
	"media_urls" jsonb,
	"platform_extended" jsonb,
	"relevance_score" integer,
	"quality_score" integer,
	"lead_status" varchar(50) DEFAULT 'new',
	"search_string" varchar(255),
	"search_rank" integer,
	"campaign_data" jsonb,
	"status" varchar(50) NOT NULL,
	"last_contacted_at" timestamp,
	"first_contacted_at" timestamp,
	"next_follow_up_at" timestamp,
	"opened_emails" integer DEFAULT 0,
	"clicked_links" integer DEFAULT 0,
	"replied_emails" integer DEFAULT 0,
	"email_sequence_step" integer,
	"sms_sent" integer DEFAULT 0,
	"linkedin_messages_sent" integer DEFAULT 0,
	"notes" text,
	"email_sequence_id" integer,
	"email_unsubscribed" boolean DEFAULT false,
	"connection_request_sent" boolean DEFAULT false,
	"connection_accepted" boolean DEFAULT false,
	"messages_sent" integer DEFAULT 0,
	"messages_received" integer DEFAULT 0,
	"call_attempts" integer DEFAULT 0,
	"call_status" varchar(50),
	"last_call_at" timestamp,
	"sms_replied" boolean DEFAULT false,
	"tags" jsonb,
	"priority" varchar(20),
	"score" integer DEFAULT 0 NOT NULL,
	"assigned_to" integer,
	"assigned_team" varchar(255),
	"created_by" integer,
	"updated_by" integer,
	"attachments" jsonb,
	"profile_snapshot" jsonb,
	"gdpr_consent" boolean DEFAULT false,
	"do_not_contact" boolean DEFAULT false,
	"blacklisted" boolean DEFAULT false,
	"email_verified" boolean DEFAULT false,
	"phone_verified" boolean DEFAULT false,
	"ai_confidence_score" real,
	"ai_source" varchar(255),
	"ai_extracted_fields" jsonb,
	"raw_scrape_data" jsonb,
	"enriched_data" jsonb,
	"retry_count" integer DEFAULT 0,
	"execution_id" uuid,
	"import_batch_id" varchar(255),
	"raw_data" jsonb,
	CONSTRAINT "leads_uuid_unique" UNIQUE("uuid")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "message_sequences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"campaign_id" integer,
	"name" varchar(255) NOT NULL,
	"description" text,
	"channel" varchar(20) NOT NULL,
	"steps" jsonb NOT NULL,
	"pause_on_reply" boolean DEFAULT true NOT NULL,
	"pause_on_click" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"type" text DEFAULT 'info' NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "openai_usages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"thread_id" integer,
	"workflow_id" varchar(100),
	"model" varchar(100) NOT NULL,
	"provider" varchar(50) DEFAULT 'openai' NOT NULL,
	"purpose" varchar(100) NOT NULL,
	"service" varchar(100) NOT NULL,
	"action" varchar(255),
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"estimated_cost_cents" integer,
	"request_summary" text,
	"response_success" integer DEFAULT 1 NOT NULL,
	"error_message" text,
	"duration_ms" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "outreach_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"campaign_type" varchar(50) NOT NULL,
	"target_audience" jsonb,
	"lead_list_ids" jsonb,
	"sequence_steps" jsonb NOT NULL,
	"start_date" timestamp,
	"end_date" timestamp,
	"timezone" varchar(100) DEFAULT 'UTC',
	"status" varchar(50) DEFAULT 'draft' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"total_leads" integer DEFAULT 0,
	"messages_sent" integer DEFAULT 0,
	"messages_delivered" integer DEFAULT 0,
	"messages_failed" integer DEFAULT 0,
	"opens" integer DEFAULT 0,
	"clicks" integer DEFAULT 0,
	"replies" integer DEFAULT 0,
	"conversions" integer DEFAULT 0,
	"settings" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"launched_at" timestamp,
	"completed_at" timestamp
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "outreach_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"lead_id" integer NOT NULL,
	"channel" varchar(50) NOT NULL,
	"lead_name" varchar(255),
	"lead_email" varchar(255),
	"lead_instagram" varchar(255),
	"lead_avatar" text,
	"lead_company" varchar(255),
	"external_thread_id" varchar(255),
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"last_message_at" timestamp,
	"last_message_by" varchar(50),
	"last_message_preview" text,
	"total_messages" integer DEFAULT 0,
	"unread_count" integer DEFAULT 0,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "outreach_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"lead_id" integer NOT NULL,
	"campaign_id" integer,
	"sequence_step_id" integer,
	"channel" varchar(20) NOT NULL,
	"recipient_email" varchar(255),
	"recipient_phone" varchar(50),
	"subject" varchar(500),
	"message_body" text NOT NULL,
	"scheduled_for" timestamp NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_attempt_at" timestamp,
	"sent_at" timestamp,
	"external_message_id" varchar(255),
	"error" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "outreach_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"user_id" integer,
	"direction" varchar(20) NOT NULL,
	"subject" text,
	"content" text NOT NULL,
	"html_content" text,
	"attachments" jsonb,
	"image_url" text,
	"video_url" text,
	"external_message_id" varchar(255),
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp,
	"delivered_at" timestamp,
	"read_at" timestamp,
	"failed_at" timestamp,
	"error_message" text,
	"campaign_id" integer,
	"sequence_step" integer,
	"is_automatic" boolean DEFAULT false,
	"is_ai_generated" boolean DEFAULT false,
	"ai_prompt" text,
	"is_read" boolean DEFAULT false,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "outreach_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"email_provider" text DEFAULT 'gmail',
	"sender_name" text,
	"sender_email" text,
	"reply_to_email" text,
	"email_signature" text,
	"enable_auto_follow_up" boolean DEFAULT true,
	"follow_up_delay" integer DEFAULT 3,
	"follow_up_delay_hours" integer DEFAULT 72,
	"max_follow_ups" integer DEFAULT 3,
	"enable_tracking" boolean DEFAULT true,
	"personalize_messages" boolean DEFAULT true,
	"send_time_optimization" boolean DEFAULT true,
	"daily_email_limit" integer DEFAULT 200,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "outreach_settings_user_id_unique" UNIQUE("user_id")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "performance_ad_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"objective" varchar(100) NOT NULL,
	"ad_platform" varchar(50) NOT NULL,
	"platform_campaign_id" varchar(255),
	"ad_account_id" varchar(255),
	"budget_type" varchar(50) NOT NULL,
	"budget_amount" numeric(12, 2) NOT NULL,
	"currency" varchar(10) DEFAULT 'USD',
	"spent_amount" numeric(12, 2) DEFAULT '0',
	"targeting" jsonb NOT NULL,
	"ad_creatives" jsonb,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp,
	"status" varchar(50) DEFAULT 'draft' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"impressions" integer DEFAULT 0,
	"clicks" integer DEFAULT 0,
	"conversions" integer DEFAULT 0,
	"reach" integer DEFAULT 0,
	"ctr" numeric(5, 2) DEFAULT '0',
	"cpc" numeric(10, 2) DEFAULT '0',
	"cpa" numeric(10, 2) DEFAULT '0',
	"roas" numeric(10, 2) DEFAULT '0',
	"bid_strategy" varchar(100),
	"optimization_goal" varchar(100),
	"settings" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"launched_at" timestamp,
	"last_synced_at" timestamp
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "performance_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"platform" varchar(50) NOT NULL,
	"platform_campaign_id" varchar(255) NOT NULL,
	"user_id" integer,
	"date" date NOT NULL,
	"hour" integer,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"spend" numeric(12, 2) DEFAULT '0' NOT NULL,
	"reach" integer DEFAULT 0,
	"conversions" integer DEFAULT 0,
	"conversion_value" numeric(12, 2) DEFAULT '0',
	"video_views" integer DEFAULT 0,
	"video_views_complete" integer DEFAULT 0,
	"link_clicks" integer DEFAULT 0,
	"post_engagements" integer DEFAULT 0,
	"leads" integer DEFAULT 0,
	"lead_value" numeric(12, 2) DEFAULT '0',
	"ctr" numeric(5, 4) DEFAULT '0',
	"cpc" numeric(10, 2) DEFAULT '0',
	"cpm" numeric(10, 2) DEFAULT '0',
	"cpa" numeric(10, 2) DEFAULT '0',
	"roas" numeric(10, 2) DEFAULT '0',
	"platform_data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "performance_metrics_campaign_id_date_hour_unique" UNIQUE("campaign_id","date","hour")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"prompt_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"source" varchar(50) NOT NULL,
	"actor_id" varchar(100),
	"platform" varchar(50) NOT NULL,
	"post_id" varchar(100) NOT NULL,
	"post_url" text,
	"author_id" varchar(100),
	"author_username" varchar(100),
	"author_name" varchar(255),
	"author_profile_url" text,
	"text" text,
	"caption" text,
	"hashtags" text,
	"mentions" text,
	"media_urls" text,
	"media_types" text,
	"post_type" varchar(50),
	"created_at" timestamp,
	"timestamp" timestamp,
	"scraped_at" timestamp DEFAULT now(),
	"likes_count" integer DEFAULT 0,
	"comments_count" integer DEFAULT 0,
	"shares_count" integer DEFAULT 0,
	"retweet_count" integer DEFAULT 0,
	"reply_count" integer DEFAULT 0,
	"quote_count" integer DEFAULT 0,
	"bookmark_count" integer DEFAULT 0,
	"view_count" integer DEFAULT 0,
	"reaction_count" integer DEFAULT 0,
	"top_reactions" text,
	"video_view_count" integer DEFAULT 0,
	"video_duration" varchar(20),
	"is_reply" boolean DEFAULT false,
	"is_retweet" boolean DEFAULT false,
	"is_quote" boolean DEFAULT false,
	"lang" varchar(10),
	"source_app" varchar(100),
	"owner_full_name" varchar(255),
	"owner_id" varchar(100),
	"carousel_media_count" integer DEFAULT 0,
	"video_play_count" integer DEFAULT 0,
	"location_name" varchar(255),
	"location_lat" varchar(50),
	"location_lng" varchar(50),
	"search_hashtag" varchar(100),
	"search_query" varchar(255),
	"search_location" varchar(100),
	"processed_for_leads" boolean DEFAULT false,
	"lead_extraction_attempts" integer DEFAULT 0,
	"raw_data" jsonb,
	"created_at_db" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "scraping_details" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"thread_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"execution_id" varchar(255),
	"platform" varchar(50) NOT NULL,
	"total_leads_needed" integer DEFAULT 0,
	"estimated_leads" integer DEFAULT 0,
	"total_leads_found" integer DEFAULT 0,
	"progress" numeric(5, 2) DEFAULT '0.00',
	"status" varchar(50) DEFAULT 'pending',
	"error" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "scraping_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"channel_name" varchar(50),
	"status" varchar(20) DEFAULT 'pending',
	"progress" integer DEFAULT 0,
	"leads_found" integer DEFAULT 0,
	"estimated_leads" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "sent_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"user_id" integer,
	"lead_name" text NOT NULL,
	"channel" text NOT NULL,
	"message" text NOT NULL,
	"image_url" text,
	"video_url" text,
	"sent_at" timestamp NOT NULL,
	"status" varchar(50) NOT NULL,
	"message_id" varchar(255),
	"gmail_thread_id" varchar(255),
	"gmail_message_id" varchar(255),
	"campaign_id" integer,
	"sequence_step" integer,
	"is_reply" boolean DEFAULT false,
	"delivery_status" varchar(50) DEFAULT 'pending',
	"delivered_at" timestamp,
	"opened_at" timestamp,
	"open_count" integer DEFAULT 0,
	"clicked_at" timestamp,
	"click_count" integer DEFAULT 0,
	"bounced_at" timestamp,
	"bounce_reason" text,
	"reply_received_at" timestamp,
	"reply_message_id" varchar(255),
	"reply_content" text,
	"smart_reply" text,
	"smart_reply_generated_at" timestamp,
	"smart_reply_approved" boolean DEFAULT false,
	"smart_reply_sent_at" timestamp,
	"sentiment" varchar(50),
	"sentiment_confidence" double precision,
	"sentiment_analysis" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "sequence_executions" (
	"id" serial PRIMARY KEY NOT NULL,
	"sequence_id" integer NOT NULL,
	"lead_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"next_scheduled_at" timestamp,
	"completed_at" timestamp,
	"paused_at" timestamp,
	"total_messages_sent" integer DEFAULT 0 NOT NULL,
	"replies_received" integer DEFAULT 0 NOT NULL,
	"links_clicked" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "strategy_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"workflow_id" uuid,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"expected_outcome" text NOT NULL,
	"agents" jsonb NOT NULL,
	"estimated_time" text NOT NULL,
	"success_rate" integer,
	"expected_impact" text,
	"benefits" jsonb,
	"recommended" boolean,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "system_integrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"integration_id" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(50) NOT NULL,
	"type" varchar(50) NOT NULL,
	"status" varchar(50) DEFAULT 'available' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb,
	"config_schema" jsonb,
	"default_config" jsonb,
	"oauth_settings" jsonb,
	"automation_settings" jsonb,
	"documentation_url" text,
	"icon_name" varchar(50),
	"rate_limit" jsonb,
	"version" varchar(20) DEFAULT '1.0.0',
	"last_tested_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "system_integrations_integration_id_unique" UNIQUE("integration_id")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "user_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"language" text DEFAULT 'en',
	"timezone" text DEFAULT 'America/New_York',
	"date_format" text DEFAULT 'MM/DD/YYYY',
	"time_format" text DEFAULT '12h',
	"email_notifications" boolean DEFAULT true,
	"push_notifications" boolean DEFAULT false,
	"dark_mode" boolean DEFAULT false,
	"compact_view" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "user_preferences_user_id_unique" UNIQUE("user_id")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" varchar(50) DEFAULT 'user' NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verification_token" text,
	"verification_token_expiry" timestamp,
	"reset_password_token" text,
	"reset_password_token_expiry" timestamp,
	"avatar" text,
	"bio" text,
	"phone" varchar(50),
	"timezone" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "workflow_executions" (
	"id" serial PRIMARY KEY NOT NULL,
	"workflow_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"status" text NOT NULL,
	"logs" jsonb NOT NULL,
	"results" jsonb NOT NULL,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "workflow_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"user_prompt" text NOT NULL,
	"stage" varchar(50) DEFAULT 'initial',
	"progress" integer DEFAULT 0,
	"current_task" varchar(255),
	"thread_id" integer,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS "workflows" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"nodes" jsonb NOT NULL,
	"edges" jsonb NOT NULL,
	"mappings" jsonb NOT NULL,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`);

    await client.query(`ALTER TABLE "ad_platform_credentials" ADD CONSTRAINT "ad_platform_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "ads" ADD CONSTRAINT "ads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_workflow_id_workflow_sessions_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_sessions"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "approval_checkpoints" ADD CONSTRAINT "approval_checkpoints_workflow_id_workflow_sessions_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_sessions"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "brand_toolkits" ADD CONSTRAINT "brand_toolkits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "chat_tab_configs" ADD CONSTRAINT "chat_tab_configs_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_business_id_company_settings_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."company_settings"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "content_asset_previews" ADD CONSTRAINT "content_asset_previews_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "content_templates" ADD CONSTRAINT "content_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "content_templates" ADD CONSTRAINT "content_templates_brand_toolkit_id_brand_toolkits_id_fk" FOREIGN KEY ("brand_toolkit_id") REFERENCES "public"."brand_toolkits"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`ALTER TABLE "content_templates" ADD CONSTRAINT "content_templates_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "followup_sequences" ADD CONSTRAINT "followup_sequences_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "followup_sequences" ADD CONSTRAINT "followup_sequences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "icp_profiles" ADD CONSTRAINT "icp_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "icp_profiles" ADD CONSTRAINT "icp_profiles_business_id_company_settings_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."company_settings"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`ALTER TABLE "icp_profiles" ADD CONSTRAINT "icp_profiles_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`ALTER TABLE "lead_inputs" ADD CONSTRAINT "lead_inputs_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "lead_inputs" ADD CONSTRAINT "lead_inputs_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "lead_inputs" ADD CONSTRAINT "lead_inputs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "lead_settings" ADD CONSTRAINT "lead_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "leads" ADD CONSTRAINT "leads_prompt_id_icp_profiles_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."icp_profiles"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`ALTER TABLE "leads" ADD CONSTRAINT "leads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`ALTER TABLE "leads" ADD CONSTRAINT "leads_execution_id_agent_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."agent_executions"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "outreach_conversations" ADD CONSTRAINT "outreach_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "outreach_conversations" ADD CONSTRAINT "outreach_conversations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "outreach_jobs" ADD CONSTRAINT "outreach_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "outreach_jobs" ADD CONSTRAINT "outreach_jobs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "outreach_jobs" ADD CONSTRAINT "outreach_jobs_campaign_id_outreach_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."outreach_campaigns"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_conversation_id_outreach_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."outreach_conversations"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`ALTER TABLE "outreach_settings" ADD CONSTRAINT "outreach_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "posts" ADD CONSTRAINT "posts_prompt_id_icp_profiles_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."icp_profiles"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "posts" ADD CONSTRAINT "posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "scraping_details" ADD CONSTRAINT "scraping_details_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "scraping_details" ADD CONSTRAINT "scraping_details_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "scraping_details" ADD CONSTRAINT "scraping_details_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "scraping_progress" ADD CONSTRAINT "scraping_progress_workflow_id_workflow_sessions_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_sessions"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "sent_messages" ADD CONSTRAINT "sent_messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "sent_messages" ADD CONSTRAINT "sent_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action`);

    await client.query(`ALTER TABLE "strategy_options" ADD CONSTRAINT "strategy_options_workflow_id_workflow_sessions_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_sessions"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action`);

    await client.query(`ALTER TABLE "workflow_sessions" ADD CONSTRAINT "workflow_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`ALTER TABLE "workflow_sessions" ADD CONSTRAINT "workflow_sessions_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action`);

    await client.query(`CREATE INDEX IF NOT EXISTS "ads_campaign_id_idx" ON "ads" USING btree ("campaign_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "ads_platform_idx" ON "ads" USING btree ("platform")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "ads_status_idx" ON "ads" USING btree ("status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "campaigns_status_idx" ON "campaigns" USING btree ("status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "campaigns_start_date_idx" ON "campaigns" USING btree ("start_date")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "campaigns_user_id_idx" ON "campaigns" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "chat_messages_user_id_idx" ON "chat_messages" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "chat_messages_thread_id_idx" ON "chat_messages" USING btree ("thread_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "chat_messages_created_at_idx" ON "chat_messages" USING btree ("created_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "chat_tab_configs_thread_id_idx" ON "chat_tab_configs" USING btree ("thread_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "chat_threads_user_id_idx" ON "chat_threads" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "chat_threads_business_id_idx" ON "chat_threads" USING btree ("business_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "chat_threads_created_at_idx" ON "chat_threads" USING btree ("created_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "company_profiles_user_id_idx" ON "company_profiles" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "company_settings_user_id_idx" ON "company_settings" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "company_settings_business_type_idx" ON "company_settings" USING btree ("business_type")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "content_asset_previews_lead_id_idx" ON "content_asset_previews" USING btree ("lead_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "content_asset_previews_status_idx" ON "content_asset_previews" USING btree ("status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "content_assets_status_idx" ON "content_assets" USING btree ("status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "content_assets_type_idx" ON "content_assets" USING btree ("type")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "content_assets_channel_idx" ON "content_assets" USING btree ("channel")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "content_assets_user_idx" ON "content_assets" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "content_assets_thread_idx" ON "content_assets" USING btree ("thread_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "followup_sequences_lead_id_idx" ON "followup_sequences" USING btree ("lead_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "followup_sequences_user_id_idx" ON "followup_sequences" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "followup_sequences_thread_key_idx" ON "followup_sequences" USING btree ("thread_key")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "followup_sequences_completed_idx" ON "followup_sequences" USING btree ("completed")`);

    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS "icp_profiles_uuid_idx" ON "icp_profiles" USING btree ("uuid")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_user_id_idx" ON "icp_profiles" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_business_id_idx" ON "icp_profiles" USING btree ("business_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_prompt_id_idx" ON "icp_profiles" USING btree ("prompt_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_thread_id_idx" ON "icp_profiles" USING btree ("thread_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_user_prompt_idx" ON "icp_profiles" USING btree ("user_id","prompt_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_status_idx" ON "icp_profiles" USING btree ("status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_approved_idx" ON "icp_profiles" USING btree ("approved")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_campaign_name_idx" ON "icp_profiles" USING btree ("campaign_name")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_industry_idx" ON "icp_profiles" USING btree ("industry")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_company_size_idx" ON "icp_profiles" USING btree ("company_size_range")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_growth_stage_idx" ON "icp_profiles" USING btree ("company_growth_stage")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_created_at_idx" ON "icp_profiles" USING btree ("created_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "icp_profiles_fit_score_idx" ON "icp_profiles" USING btree ("fit_score")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "lead_gen_campaigns_status_idx" ON "lead_gen_campaigns" USING btree ("status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "lead_gen_campaigns_created_at_idx" ON "lead_gen_campaigns" USING btree ("created_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "idx_lead_inputs_thread_id" ON "lead_inputs" USING btree ("thread_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "idx_lead_inputs_message_id" ON "lead_inputs" USING btree ("message_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "idx_lead_inputs_created_at" ON "lead_inputs" USING btree ("created_at")`);

    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS "leads_uuid_idx" ON "leads" USING btree ("uuid")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_status_idx" ON "leads" USING btree ("status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_lead_type_idx" ON "leads" USING btree ("lead_type")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_priority_idx" ON "leads" USING btree ("priority")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_company_industry_idx" ON "leads" USING btree ("company_name","industry")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_industry_idx" ON "leads" USING btree ("industry")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_company_size_idx" ON "leads" USING btree ("company_size")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_source_idx" ON "leads" USING btree ("source")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_campaign_idx" ON "leads" USING btree ("campaign_data")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_platform_idx" ON "leads" USING btree ("platform_type")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_email_status_idx" ON "leads" USING btree ("email_status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_next_followup_idx" ON "leads" USING btree ("next_follow_up_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_last_contacted_idx" ON "leads" USING btree ("last_contacted_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_fit_score_idx" ON "leads" USING btree ("fit_score")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_tier_idx" ON "leads" USING btree ("tier")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_assigned_to_idx" ON "leads" USING btree ("assigned_to")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_user_id_idx" ON "leads" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_prompt_id_idx" ON "leads" USING btree ("prompt_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_created_at_idx" ON "leads" USING btree ("created_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_scraped_at_idx" ON "leads" USING btree ("scraped_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_do_not_contact_idx" ON "leads" USING btree ("do_not_contact")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_blacklisted_idx" ON "leads" USING btree ("blacklisted")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_company_role_idx" ON "leads" USING btree ("company_name","role")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_execution_id_idx" ON "leads" USING btree ("execution_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_source_status_idx" ON "leads" USING btree ("source","status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_place_id_idx" ON "leads" USING btree ("place_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_rating_idx" ON "leads" USING btree ("rating")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_twitter_handle_idx" ON "leads" USING btree ("twitter_handle")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_instagram_handle_idx" ON "leads" USING btree ("instagram_handle")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_lead_type_platform_idx" ON "leads" USING btree ("lead_type","platform_type")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_relevance_score_idx" ON "leads" USING btree ("relevance_score")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "leads_quality_score_idx" ON "leads" USING btree ("quality_score")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_conversations_user_id_idx" ON "outreach_conversations" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_conversations_lead_id_idx" ON "outreach_conversations" USING btree ("lead_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_conversations_channel_idx" ON "outreach_conversations" USING btree ("channel")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_conversations_status_idx" ON "outreach_conversations" USING btree ("status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_conversations_last_message_at_idx" ON "outreach_conversations" USING btree ("last_message_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_conversations_external_thread_id_idx" ON "outreach_conversations" USING btree ("external_thread_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_messages_conversation_id_idx" ON "outreach_messages" USING btree ("conversation_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_messages_user_id_idx" ON "outreach_messages" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_messages_direction_idx" ON "outreach_messages" USING btree ("direction")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_messages_status_idx" ON "outreach_messages" USING btree ("status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_messages_sent_at_idx" ON "outreach_messages" USING btree ("sent_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_messages_campaign_id_idx" ON "outreach_messages" USING btree ("campaign_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "outreach_messages_external_message_id_idx" ON "outreach_messages" USING btree ("external_message_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_post_id_idx" ON "posts" USING btree ("post_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_platform_idx" ON "posts" USING btree ("platform")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_prompt_id_idx" ON "posts" USING btree ("prompt_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_user_id_idx" ON "posts" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_author_id_idx" ON "posts" USING btree ("author_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_author_username_idx" ON "posts" USING btree ("author_username")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_hashtag_idx" ON "posts" USING btree ("search_hashtag")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_likes_count_idx" ON "posts" USING btree ("likes_count")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_created_at_idx" ON "posts" USING btree ("created_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_scraped_at_idx" ON "posts" USING btree ("scraped_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_processed_for_leads_idx" ON "posts" USING btree ("processed_for_leads")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_platform_author_idx" ON "posts" USING btree ("platform","author_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "posts_prompt_platform_idx" ON "posts" USING btree ("prompt_id","platform")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "idx_scraping_details_thread_id" ON "scraping_details" USING btree ("thread_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "idx_scraping_details_message_id" ON "scraping_details" USING btree ("message_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "idx_scraping_details_execution_id" ON "scraping_details" USING btree ("execution_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "idx_scraping_details_status" ON "scraping_details" USING btree ("status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "idx_scraping_details_updated_at" ON "scraping_details" USING btree ("updated_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "sent_messages_lead_id_idx" ON "sent_messages" USING btree ("lead_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "sent_messages_user_id_idx" ON "sent_messages" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "sent_messages_status_idx" ON "sent_messages" USING btree ("status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "sent_messages_sent_at_idx" ON "sent_messages" USING btree ("sent_at")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "sent_messages_channel_idx" ON "sent_messages" USING btree ("channel")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "sent_messages_is_reply_idx" ON "sent_messages" USING btree ("is_reply")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "sent_messages_sentiment_idx" ON "sent_messages" USING btree ("sentiment")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "sent_messages_delivery_status_idx" ON "sent_messages" USING btree ("delivery_status")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "sent_messages_gmail_thread_id_idx" ON "sent_messages" USING btree ("gmail_thread_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "strategy_options_recommended_idx" ON "strategy_options" USING btree ("recommended")`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0000_overrated_tarot)');
}
