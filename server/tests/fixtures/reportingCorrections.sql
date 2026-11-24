-- Disposable synthetic schema. No production application database or migrations.
CREATE TABLE performance_ad_campaigns (id integer PRIMARY KEY,user_id integer,name text,status text,local_status text,provider_status text,objective text,ad_platform text,currency text,budget_type text,budget_amount numeric(12,2),platform_campaign_id text,ad_account_id text,created_at timestamp,impressions integer,clicks integer,conversions numeric(18,6),reach integer,spent_amount numeric(12,2),ctr numeric(5,2),cpc numeric(10,2),cpa numeric(10,2),roas numeric(10,2),last_synced_at timestamp,updated_at timestamp);
CREATE TABLE performance_metrics (id serial PRIMARY KEY,campaign_id integer,user_id integer,platform_campaign_id text,platform text,date date,hour integer,impressions integer,clicks integer,spend numeric(12,2),conversions numeric(18,6),leads integer,conversion_value numeric(12,2),post_engagements integer,cpc numeric(10,2),cpm numeric(10,2),ctr numeric(5,4),cpa numeric(10,2),roas numeric(10,2),reach integer,platform_data jsonb,source_scope text,sync_status text,sync_error text,provider_status text,updated_at timestamp);
CREATE UNIQUE INDEX daily_metrics_unique ON performance_metrics(campaign_id,platform,date) WHERE hour IS NULL;
CREATE TABLE ad_performance_evaluations(campaign_id integer,user_id integer,state text,created_at timestamp,baseline_metrics jsonb,rule_results jsonb);
CREATE TABLE ad_campaign_autonomy_policies(campaign_id integer,user_id integer,enabled boolean);
CREATE TABLE ad_recommendations(campaign_id integer,user_id integer,status text);
CREATE TABLE ad_analytics_sync_runs(campaign_id integer,user_id integer,platform text,status text,completed_at timestamp,error text);
CREATE TABLE meta_page_connections(user_id integer,is_active boolean,ad_account_currency text);
CREATE TABLE api_credentials(user_id integer,is_active boolean,service_name text,config jsonb);
CREATE TABLE paid_ad_accounts(id integer,user_id integer,platform text,provider_account_id text,currency text,is_active boolean);
CREATE TABLE campaign_performance_cache(id integer,user_id integer,platform text,ad_account_id text,entity_type text,last_refreshed_at timestamp);
CREATE TABLE pixel_events(id serial, user_id integer, lead_id integer, campaign_id integer, timestamp timestamp,utm_campaign text,properties jsonb);
CREATE TABLE leads(id integer,user_id integer,deleted_at timestamp,lead_status text,status text);
CREATE TABLE crm_contacts(id integer,user_id integer,lead_id integer,deleted_at timestamp,pipeline_status text,status text,deal_value numeric(12,2),currency text,updated_at timestamp);
CREATE TABLE bookings(id integer,user_id integer,lead_id integer,total_price numeric(12,2),currency text,status text,payment_status text);
INSERT INTO performance_ad_campaigns(id,user_id,name,local_status,provider_status,objective,ad_platform,currency,budget_type,budget_amount,platform_campaign_id,ad_account_id,created_at) VALUES
(1,9,'Synthetic multi','active','ACTIVE','sales','multi','USD','lifetime',1000,'parent-1','123','2026-08-01'),
(2,9,'Synthetic INR','active','ENABLED','sales','google','INR','daily',100,'parent-2','456','2026-08-01');
INSERT INTO performance_metrics(campaign_id,user_id,platform,platform_campaign_id,date,hour,impressions,clicks,spend,conversions,reach,conversion_value,post_engagements,updated_at) VALUES
(1,9,'meta','meta-1','2026-09-12',NULL,1000,10,10,1.75,500,40,10,'2026-09-12'),
(1,9,'google','google-1','2026-09-12',NULL,1000,10,20,2.25,500,60,10,'2026-09-12'),
(2,9,'google','google-2','2026-09-12',NULL,1000,10,800,1.75,500,1600,10,'2026-09-12');
INSERT INTO leads VALUES (1,9,NULL,'won','converted'),(2,9,NULL,'won','converted');
INSERT INTO pixel_events(user_id,lead_id,campaign_id,timestamp,utm_campaign) VALUES (9,1,1,'2026-09-10','meta-1'),(9,2,1,'2026-09-10','meta-1');
INSERT INTO crm_contacts VALUES (1,9,1,NULL,'won','won',10,'USD','2026-09-10'),(2,9,2,NULL,'won','won',800,'INR','2026-09-10');
INSERT INTO bookings VALUES (1,9,1,10,'USD','confirmed','paid'),(2,9,2,800,'INR','confirmed','paid');

CREATE TABLE ad_unit_metrics(id serial,campaign_id integer,user_id integer,platform text,target_type text,target_key text,provider_resource text,date date,impressions integer,clicks integer,spend numeric,conversions numeric,conversion_value numeric,reach integer,updated_at timestamp);
INSERT INTO ad_unit_metrics(campaign_id,user_id,platform,target_type,target_key,provider_resource,date,impressions,clicks,spend,conversions,conversion_value,reach)
SELECT 1,9,'meta','ad_set','child-'||n,'provider-'||n,'2026-09-12',1000,10,1,1.75,10,100 FROM generate_series(1,110) n;

ALTER TABLE leads ADD COLUMN created_at timestamp DEFAULT '2026-09-10', ADD COLUMN updated_at timestamp DEFAULT '2026-09-10', ADD COLUMN lead_type text, ADD COLUMN platform_type text;
CREATE TABLE sent_messages(id integer,lead_id integer,user_id integer,channel text,status text,is_reply boolean,sent_at timestamp,delivery_status text,delivered_at timestamp,opened_at timestamp,open_count integer,clicked_at timestamp,click_count integer,reply_received_at timestamp);
INSERT INTO sent_messages VALUES
(1,1,9,'email','replied',false,'2026-09-10','delivered','2026-09-10','2026-09-10',1,'2026-09-10',1,'2026-09-10'),
(2,1,9,'email','queued',false,'2026-09-10','pending',NULL,NULL,0,NULL,0,NULL),
(3,1,9,'email','failed',false,'2026-09-10','failed',NULL,NULL,0,NULL,0,NULL),
(4,1,9,'email','sent',true,'2026-09-10','pending',NULL,NULL,0,NULL,0,NULL),
(5,1,9,'sms','sent',false,'2026-09-10','delivered','2026-09-10',NULL,0,NULL,0,NULL),
(6,1,9,'email','clicked',false,'2026-09-10','delivered','2026-09-10',NULL,0,'2026-09-10',1,NULL);
