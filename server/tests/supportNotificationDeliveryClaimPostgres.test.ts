import { describe, expect, it } from '@jest/globals';
import { Client } from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';
import { supportNotificationDeliveryClaim } from '../services/SupportNotificationDeliveryClaim.js';

const postgresTest = process.env.SUPPORT_TEMPLATE_QA_DATABASE_URL ? it : it.skip;
describe.each(['email', 'whatsapp'])('notification authorization at %s delivery claim time', (channel) => {
  postgresTest.each([
    ['current assignment', '', 'sending'],
    ['master switch off', 'UPDATE support_notification_channel_settings SET enabled=false', 'suppressed'],
    ['disabled member', 'UPDATE team_members SET is_active=false', 'suppressed'],
    ['disabled team', 'UPDATE support_teams SET is_active=false', 'suppressed'],
    ['revoked destination', "UPDATE support_notification_destinations SET verification_status='unverified'", 'suppressed'],
    ['changed destination', "UPDATE support_notification_destinations SET destination_ciphertext='replacement'", 'suppressed'],
    ['reassigned ticket', 'UPDATE support_tickets SET assigned_member_id=6', 'suppressed'],
    ['unassigned ticket', 'UPDATE support_tickets SET assigned_member_id=NULL', 'suppressed'],
    ['closed ticket', "UPDATE support_tickets SET status='closed'", 'suppressed'],
    ['foreign ticket', 'UPDATE support_tickets SET user_id=10', 'suppressed'],
    ['foreign destination', 'UPDATE support_notification_destinations SET user_id=10', 'suppressed'],
    ['accepted replay', "UPDATE support_member_notification_deliveries SET status='accepted'", null],
    ['uncertain replay', "UPDATE support_member_notification_deliveries SET status='uncertain'", null],
    ['owner test', "UPDATE support_member_notification_deliveries SET event_id=NULL,event_key='support-notification-test:fixture'", 'sending'],
  ])('%s', async (_label, mutation, expectedStatus) => {
    const connectionString = process.env.SUPPORT_TEMPLATE_QA_DATABASE_URL!;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
      throw new Error('Notification QA requires local PostgreSQL.');
    }
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      // No permanent application tables are reachable, even if a fixture is missing.
      await client.query(`SET search_path=pg_temp;
        CREATE TEMP TABLE team_members(id int,user_id int,team_id int,is_active boolean);
        CREATE TEMP TABLE support_teams(id int,user_id int,is_active boolean);
        CREATE TEMP TABLE support_notification_channel_settings(user_id int,channel text,enabled boolean);
        CREATE TEMP TABLE support_notification_destinations(id int,user_id int,member_id int,channel text,verification_status text,destination_ciphertext text);
        CREATE TEMP TABLE support_notification_events(id int,user_id int,ticket_id int);
        CREATE TEMP TABLE support_tickets(id int,user_id int,team_id int,assigned_member_id int,status text,deleted_at timestamp);
        CREATE TEMP TABLE support_member_notification_deliveries(id int PRIMARY KEY,user_id int,member_id int,event_id int,event_key text,
          channel text,destination_id int,recipient_ciphertext text,status text,attempt_count int,max_attempts int,next_attempt_at timestamp,
          updated_at timestamp,last_error text,error_code text);
        INSERT INTO team_members VALUES(5,9,2,true);
        INSERT INTO support_teams VALUES(2,9,true);
        INSERT INTO support_notification_channel_settings VALUES(9,'email',true);
        INSERT INTO support_notification_destinations VALUES(1,9,5,'email','owner_verified','encrypted-fixture');
        INSERT INTO support_notification_events VALUES(1,9,59);
        INSERT INTO support_tickets VALUES(59,9,2,5,'open',NULL);
        INSERT INTO support_member_notification_deliveries VALUES(1,9,5,1,'assignment:fixture','email',1,'encrypted-fixture','pending',0,5,NOW(),NULL,NULL,NULL);`);
      for (const table of ['support_notification_channel_settings', 'support_notification_destinations', 'support_member_notification_deliveries']) {
        await client.query(`UPDATE ${table} SET channel=$1`, [channel]);
      }
      if (mutation) await client.query(mutation);
      const foreign = new PgDialect().sqlToQuery(supportNotificationDeliveryClaim(10, 1));
      expect((await client.query(foreign.sql, foreign.params)).rows).toHaveLength(0);
      const query = new PgDialect().sqlToQuery(supportNotificationDeliveryClaim(9, 1));
      const result = await client.query(query.sql, query.params);
      if (expectedStatus === null) expect(result.rows).toHaveLength(0);
      else {
        expect(result.rows[0].status).toBe(expectedStatus);
        expect(result.rows[0].attempt_count).toBe(expectedStatus === 'sending' ? 1 : 0);
      }
      // A second worker/replayed queue job cannot claim either outcome again.
      expect((await client.query(query.sql, query.params)).rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
