/** Emits a transaction containing only session-owned temporary tables.
 * Pipe into psql -X -v ON_ERROR_STOP=1 against a PostgreSQL QA database. */
import { PgDialect } from 'drizzle-orm/pg-core';
import { creationMessageReconciliation } from '../models/widgetStates/creationMessageReconciliation.js';

const query = new PgDialect().sqlToQuery(creationMessageReconciliation());
if (query.params.length) throw new Error('Fixture requires a parameter-free receipt query');
process.stdout.write(`
BEGIN;
SET LOCAL search_path = pg_temp, pg_catalog;
SET LOCAL statement_timeout = '8s';
CREATE TEMP TABLE widget_states(id int primary key,user_id int,business_profile_id int,thread_id int,tool_name text,status text,execution_result jsonb,execution_error text,execution_completed_at timestamp,updated_at timestamp,submitted_values jsonb,form_values jsonb) ON COMMIT DROP;
CREATE TEMP TABLE outreach_conversations(id int primary key,user_id int,business_profile_id int,lead_id int,channel text) ON COMMIT DROP;
CREATE TEMP TABLE outreach_messages(id int primary key,conversation_id int,user_id int,business_profile_id int,direction text,message_kind text,metadata jsonb,status text,provider_call_state text) ON COMMIT DROP;
INSERT INTO widget_states
 SELECT i,7,9,42,'send_outreach_messages','queued',jsonb_build_object('success',true,'output',jsonb_build_object('channel','whatsapp','queued',2,'retrySafe',false,'results',jsonb_build_array(jsonb_build_object('messageId',i*10+1,'leadId',i*10+1),jsonb_build_object('messageId',i*10+2,'leadId',i*10+2)))),NULL,NULL,NOW(),'{"outreach_review":{"creationVersion":1}}'::jsonb,NULL
 FROM generate_series(1,17) i;
INSERT INTO outreach_conversations SELECT i,7,9,i,'whatsapp' FROM generate_series(11,172) i;
INSERT INTO outreach_messages
 SELECT i*10+j,i*10+j,7,9,'outbound','outreach',jsonb_build_object('outreachCreation',jsonb_build_object('delivery',jsonb_build_object('widgetId',i,'threadId',42))),'sent','confirmed'
 FROM generate_series(1,17) i CROSS JOIN generate_series(1,2) j;
-- 18 a reviewed batch larger than the old 500-recipient UI limit.
INSERT INTO widget_states
 SELECT 18,7,9,42,'send_outreach_messages','queued',jsonb_build_object('success',true,'output',jsonb_build_object('channel','whatsapp','queued',575,'retrySafe',false,'results',jsonb_agg(jsonb_build_object('messageId',18000+i,'leadId',18000+i)))),NULL,NULL,NOW(),'{"outreach_review":{"creationVersion":1}}'::jsonb,NULL
 FROM generate_series(1,575) i;
INSERT INTO outreach_conversations SELECT 18000+i,7,9,18000+i,'whatsapp' FROM generate_series(1,575) i;
INSERT INTO outreach_messages
 SELECT 18000+i,18000+i,7,9,'outbound','outreach',jsonb_build_object('outreachCreation',jsonb_build_object('delivery',jsonb_build_object('widgetId',18,'threadId',42))),'sent','confirmed'
 FROM generate_series(1,575) i;
-- 19 a definite provider failure with a durable next-day retry awaiting enqueue.
INSERT INTO widget_states SELECT 19,7,9,42,'send_outreach_messages','queued',jsonb_build_object('output',jsonb_build_object('channel','whatsapp','results',jsonb_build_array(jsonb_build_object('messageId',191,'leadId',191)))),NULL,NULL,NOW(),'{"outreach_review":{"creationVersion":1}}'::jsonb,NULL;
INSERT INTO outreach_conversations VALUES(191,7,9,191,'whatsapp');
INSERT INTO outreach_messages VALUES(191,191,7,9,'outbound','outreach','{"outreachCreation":{"delivery":{"widgetId":19,"threadId":42}},"outreachQueue":{"enqueueNeeded":true}}'::jsonb,'failed','confirmed');
-- 1 successful; 2 partial provider failure; 3 pending; 4 missing receipt;
-- 5 foreign owner; 6 foreign business; 7 wrong review; 8 wrong chat;
-- 9 follow-up; 10 duplicate receipt; 11 uncertain; 12 malformed ID.
-- 13 foreign conversation owner; 14 foreign conversation business;
-- 15 wrong channel; 16 malformed result list.
-- 17 legacy review (not a shared-composer receipt).
UPDATE outreach_messages SET status='delivered' WHERE id=11;
UPDATE outreach_messages SET status='failed' WHERE id=22;
UPDATE outreach_messages SET status='pending',provider_call_state='not_started' WHERE id=32;
DELETE FROM outreach_messages WHERE id=42;
UPDATE outreach_messages SET user_id=8 WHERE id=52;
UPDATE outreach_messages SET business_profile_id=10 WHERE id=62;
UPDATE outreach_messages SET metadata=jsonb_set(metadata,'{outreachCreation,delivery,widgetId}','999') WHERE id=72;
UPDATE outreach_messages SET metadata=jsonb_set(metadata,'{outreachCreation,delivery,threadId}','999') WHERE id=82;
UPDATE outreach_messages SET message_kind='follow_up' WHERE id=92;
UPDATE widget_states SET execution_result=jsonb_set(execution_result,'{output,results,1}',execution_result#>'{output,results,0}') WHERE id=10;
UPDATE outreach_messages SET status='manual_review',provider_call_state='unknown' WHERE id=112;
UPDATE widget_states SET execution_result=jsonb_set(execution_result,'{output,results,1,messageId}','"invalid"') WHERE id=12;
UPDATE outreach_conversations SET user_id=8 WHERE id=132;
UPDATE outreach_conversations SET business_profile_id=10 WHERE id=142;
UPDATE outreach_conversations SET channel='email' WHERE id=152;
UPDATE widget_states SET execution_result=jsonb_set(execution_result,'{output,results}','{}') WHERE id=16;
UPDATE widget_states SET submitted_values=NULL WHERE id=17;
${query.sql};
DO $$ BEGIN
 IF (SELECT status FROM widget_states WHERE id=1) <> 'succeeded' THEN RAISE EXCEPTION 'Successful batch did not reconcile'; END IF;
 IF (SELECT execution_result#>>'{reconciliation,deliveredCount}' FROM widget_states WHERE id=1) <> '1' THEN RAISE EXCEPTION 'Accepted was confused with delivered'; END IF;
 IF (SELECT status FROM widget_states WHERE id=2) <> 'failed' OR (SELECT execution_result#>>'{output,failCount}' FROM widget_states WHERE id=2) <> '1' THEN RAISE EXCEPTION 'Partial failure hidden'; END IF;
 IF EXISTS(SELECT 1 FROM widget_states WHERE id IN (3,10,12,16,17) AND status <> 'queued') THEN RAISE EXCEPTION 'Pending, ambiguous or legacy receipt incorrectly completed'; END IF;
 IF EXISTS(SELECT 1 FROM widget_states WHERE id IN (4,5,6,7,8,9,13,14,15) AND (execution_result#>>'{output,status}' <> 'needs_attention' OR execution_result#>>'{output,unavailableCount}' <> '1' OR execution_result#>>'{output,retrySafe}' <> 'false')) THEN RAISE EXCEPTION 'Missing or unrelated receipt not safely unavailable'; END IF;
 IF (SELECT execution_result#>>'{output,status}' FROM widget_states WHERE id=11) <> 'needs_attention' THEN RAISE EXCEPTION 'Unknown outcome lost'; END IF;
 IF (SELECT execution_result#>>'{output,retrySafe}' FROM widget_states WHERE id=11) <> 'false' THEN RAISE EXCEPTION 'Unsafe retry allowed'; END IF;
 IF (SELECT status FROM widget_states WHERE id=19) <> 'queued' THEN RAISE EXCEPTION 'Provider retry was incorrectly finalized before enqueue'; END IF;
 IF (SELECT status FROM widget_states WHERE id=12) <> 'queued' THEN RAISE EXCEPTION 'Malformed receipt matched'; END IF;
 IF (SELECT status FROM widget_states WHERE id=18) <> 'succeeded' OR (SELECT execution_result#>>'{output,successCount}' FROM widget_states WHERE id=18) <> '575' THEN RAISE EXCEPTION 'Large reviewed batch did not reconcile all exact receipts'; END IF;
END $$;
-- A repeated reconciliation is read-only for already finalised reviews.
${query.sql};
DO $$ BEGIN
 IF (SELECT COUNT(*) FROM widget_states WHERE status <> 'queued') <> 13 THEN RAISE EXCEPTION 'Replay changed terminal scope'; END IF;
END $$;
ROLLBACK;
SELECT '19 receipt scenarios including provider retry and 575 recipients and idempotent replay passed; temporary transaction rolled back' AS result;
`);
