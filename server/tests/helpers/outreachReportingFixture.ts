import type { Client } from 'pg';

/** Only call after SET search_path TO pg_temp,pg_catalog in an isolated QA DB. */
export async function installReportingFixture(client: Client) {
  await client.query(`
    CREATE TEMP TABLE IF NOT EXISTS outreach_conversations(id int,user_id int,channel text,provider_account_id text,business_profile_id int DEFAULT 1);
    ALTER TABLE outreach_conversations ADD COLUMN IF NOT EXISTS lead_id int DEFAULT 7;
    ALTER TABLE outreach_conversations ADD COLUMN IF NOT EXISTS crm_contact_id int;
    CREATE TEMP TABLE IF NOT EXISTS outreach_messages(business_profile_id int DEFAULT 1,id int,user_id int,conversation_id int,direction text,message_kind text,status text,metadata jsonb DEFAULT '{}',
      external_message_id text,provider_message_id text,waba_message_id text,rfc_message_id text,manual_review_required bool DEFAULT false,
      error_message text,updated_at timestamp DEFAULT NOW(),created_at timestamp DEFAULT NOW(),sent_at timestamp,delivered_at timestamp,read_at timestamp,provider_account_id text);
    ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS campaign_id int;
    ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS message_type text DEFAULT 'text';
    ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS is_ai_generated bool DEFAULT false;
    CREATE TEMP TABLE IF NOT EXISTS outreach_jobs(business_profile_id int DEFAULT 1,id int,user_id int,channel text,status text,sent_at timestamp,created_at timestamp DEFAULT NOW(),metadata jsonb DEFAULT '{}',attempts int,scheduled_for timestamp,error text,external_message_id text);
    ALTER TABLE outreach_jobs ADD COLUMN IF NOT EXISTS lead_id int DEFAULT 7;
    ALTER TABLE outreach_jobs ADD COLUMN IF NOT EXISTS campaign_id int;
    CREATE TEMP TABLE outreach_campaigns(id int,user_id int,business_profile_id int DEFAULT 1,name text,settings jsonb DEFAULT '{}');
    CREATE TEMP TABLE sent_messages(id int,user_id int,business_profile_id int DEFAULT 1,lead_id int,channel text,campaign_id int,sender_id text,follow_up_step int,
      status text,delivery_status text,sent_at timestamp,created_at timestamp DEFAULT NOW(),updated_at timestamp DEFAULT NOW(),delivered_at timestamp,opened_at timestamp,clicked_at timestamp,open_count int DEFAULT 0,click_count int DEFAULT 0,
      reply_received_at timestamp,reply_message_id text,is_reply bool DEFAULT false,outreach_message_id int,message_id text,gmail_message_id text,rfc_message_id text,bounce_reason text,sentiment text);
    CREATE TEMP TABLE chat_threads(id int,user_id int,business_profile_id int DEFAULT 1,title text,deleted_at timestamp);
    CREATE TEMP TABLE leads(id int,user_id int,business_profile_id int DEFAULT 1,campaign_data jsonb DEFAULT '{}',
      legacy_campaign_thread_key text GENERATED ALWAYS AS (CASE WHEN length(campaign_data->>'threadId') BETWEEN 1 AND 10 THEN campaign_data->>'threadId' END) STORED);
    CREATE TEMP TABLE crm_contacts(id int,user_id int,business_profile_id int DEFAULT 1,lead_id int,merged_into_contact_id int);
    ALTER TABLE crm_contacts ADD COLUMN deleted_at timestamp;
    ALTER TABLE crm_contacts ADD COLUMN first_name text,ADD COLUMN last_name text,ADD COLUMN email text,ADD COLUMN phone text;
    ALTER TABLE leads ADD COLUMN name text,ADD COLUMN email text,ADD COLUMN phone text,ADD COLUMN deleted_at timestamp;
    ALTER TABLE outreach_messages ADD COLUMN content text,ADD COLUMN redacted_content text,ADD COLUMN subject text;
    ALTER TABLE outreach_jobs ADD COLUMN subject text,ADD COLUMN message_body text;
    ALTER TABLE sent_messages ADD COLUMN subject text,ADD COLUMN message text,ADD COLUMN reply_content text;
    CREATE TEMP TABLE crm_contact_channel_identities(user_id int,business_profile_id int,contact_id int,lead_id int);
    CREATE TEMP TABLE sales_outcome_events(id int,user_id int,business_profile_id int,conversation_kind text,conversation_id int,kind text,verified bool,occurred_at timestamptz);
    CREATE TEMP TABLE campaign_crm_contacts(user_id int,business_profile_id int DEFAULT 1,contact_id int,thread_id int);
    CREATE TEMP TABLE crm_contact_imports(id int,user_id int,business_profile_id int DEFAULT 1,file_name text);
    CREATE TEMP TABLE crm_contact_import_details(import_id int,business_profile_id int DEFAULT 1,created_contact_id int,status text);
    CREATE TEMP TABLE campaign_lead_imports(id int,user_id int,business_profile_id int DEFAULT 1,thread_id int,file_name text);
    CREATE TEMP TABLE campaign_lead_import_members(import_id int,user_id int,business_profile_id int DEFAULT 1,lead_id int,recipient_lead_id int,contact_id int);
    CREATE TEMP TABLE dashboard_operations(id uuid,user_id int,business_profile_id int DEFAULT 1,kind text,payload jsonb DEFAULT '{}',result jsonb,created_at timestamptz DEFAULT now());
  `);
}
