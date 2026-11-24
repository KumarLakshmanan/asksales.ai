import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { Client } from "pg";
// @ts-expect-error JavaScript migration
import { up as unifiedInbox } from "../migrations/297_unified_outreach_inbox.js";
// @ts-expect-error JavaScript migration
import { up as keepLinks } from "../migrations/602_keep_inbox_send_links.js";

const connectionString = process.env.OUTREACH_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
let client: Client;
const schema = `inbox_links_qa_${process.pid}`;

const linkOf = async (sentId: number) =>
  (await client.query("SELECT outreach_message_id FROM sent_messages WHERE id=$1", [sentId])).rows[0].outreach_message_id;

suite("Inbox send links (PostgreSQL)", () => {
  let conversation: number;
  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, pg_catalog`);
    await client.query(`
      CREATE TABLE outreach_conversations(id SERIAL PRIMARY KEY,user_id INTEGER,business_profile_id INTEGER,lead_id INTEGER,channel TEXT,
        last_message_at TIMESTAMP,created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE outreach_messages(id SERIAL PRIMARY KEY,conversation_id INTEGER,user_id INTEGER,direction TEXT,subject TEXT,content TEXT,
        redacted_content TEXT,external_message_id TEXT,provider_message_id TEXT,rfc_message_id TEXT,waba_message_id TEXT,
        created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE sent_messages(id SERIAL PRIMARY KEY,user_id INTEGER,business_profile_id INTEGER,lead_id INTEGER,channel TEXT,subject TEXT,
        message TEXT,status TEXT,delivery_status TEXT,sent_at TIMESTAMP,message_id TEXT,gmail_message_id TEXT,is_reply BOOLEAN,
        updated_at TIMESTAMP);
    `);
    await unifiedInbox(client);
    conversation = (await client.query(
      "INSERT INTO outreach_conversations(user_id,business_profile_id,lead_id,channel) VALUES(1,10,5,'whatsapp') RETURNING id")).rows[0].id;
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it("relinks earlier attempts to the latest matching message in the same conversation", async () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 24, 3, minutes)).toISOString();
    const first = (await client.query(
      "INSERT INTO outreach_messages(conversation_id,user_id,direction,content,created_at) VALUES($1,1,'outbound','Weekday offer',$2) RETURNING id",
      [conversation, at(35)])).rows[0].id;
    const second = (await client.query(
      "INSERT INTO outreach_messages(conversation_id,user_id,direction,content,created_at) VALUES($1,1,'outbound','Weekday offer',$2) RETURNING id",
      [conversation, at(50)])).rows[0].id;
    const attempts = (await client.query(`INSERT INTO sent_messages(user_id,business_profile_id,lead_id,channel,message,status,delivery_status,sent_at)
      VALUES(1,10,5,'whatsapp','Weekday offer','sent','failed',$1),(1,10,5,'whatsapp','Weekday offer','sent','failed',$2),
            (1,10,5,'whatsapp','Other text','sent','failed',$2) RETURNING id`, [at(36), at(51)])).rows.map(row => row.id);
    expect(await linkOf(attempts[0])).toBeNull();

    await keepLinks(client);
    expect(await linkOf(attempts[0])).toBe(first);
    expect(await linkOf(attempts[1])).toBe(second);
    expect(await linkOf(attempts[2])).toBeNull();
  });

  it("keeps an explicit link on insert and through status changes", async () => {
    await keepLinks(client);
    const message = (await client.query(
      "INSERT INTO outreach_messages(conversation_id,user_id,direction,content) VALUES($1,1,'outbound','Template send') RETURNING id",
      [conversation])).rows[0].id;
    const sent = (await client.query(`INSERT INTO sent_messages(user_id,business_profile_id,lead_id,channel,message,status,sent_at,message_id,outreach_message_id)
      VALUES(1,10,5,'whatsapp','Template send','sent',NOW(),'wamid.unknown',$1) RETURNING id`, [message])).rows[0].id;
    expect(await linkOf(sent)).toBe(message);
    await client.query("UPDATE sent_messages SET status='failed', delivery_status='failed' WHERE id=$1", [sent]);
    expect(await linkOf(sent)).toBe(message);
  });

  it("keeps the link when a WhatsApp retry clears the provider IDs", async () => {
    await keepLinks(client);
    const message = (await client.query(
      "INSERT INTO outreach_messages(conversation_id,user_id,direction,content,waba_message_id) VALUES($1,1,'outbound','Retry me','wamid.retry') RETURNING id",
      [conversation])).rows[0].id;
    const sent = (await client.query(`INSERT INTO sent_messages(user_id,business_profile_id,lead_id,channel,message,status,sent_at,message_id)
      VALUES(1,10,5,'whatsapp','Retry me','sent',NOW(),'wamid.retry') RETURNING id`)).rows[0].id;
    expect(await linkOf(sent)).toBe(message);
    await client.query(
      "UPDATE outreach_messages SET external_message_id=NULL,provider_message_id=NULL,waba_message_id=NULL WHERE id=$1", [message]);
    expect(await linkOf(sent)).toBe(message);
  });

  it("keeps a historical send separate when its text matches two conversations", async () => {
    const otherConversation = (await client.query(
      "INSERT INTO outreach_conversations(user_id,business_profile_id,lead_id,channel) VALUES(1,10,5,'whatsapp') RETURNING id",
    )).rows[0].id;
    await client.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content)
      VALUES($1,1,'outbound','Same text'),($2,1,'outbound','Same text')`, [conversation, otherConversation]);
    const sent = (await client.query(`INSERT INTO sent_messages(user_id,business_profile_id,lead_id,channel,message,status,sent_at)
      VALUES(1,10,5,'whatsapp','Same text','sent',NOW()) RETURNING id`)).rows[0].id;

    await keepLinks(client);
    expect(await linkOf(sent)).toBeNull();
  });
});
