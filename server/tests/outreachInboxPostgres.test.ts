import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { Client, types } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
// @ts-expect-error JavaScript migration
import { up } from "../migrations/297_unified_outreach_inbox.js";

// @ts-expect-error JavaScript migration
import { up as addEmailFormat, down as removeEmailFormat } from "../migrations/324_email_body_format.js";

const connectionString = process.env.OUTREACH_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
jest.unstable_mockModule("../models/db.js", () => ({
  db: new Proxy(
    {},
    {
      get(_target, key) {
        const value = (database as unknown as Record<PropertyKey, unknown>)[
          key
        ];
        return typeof value === "function" ? value.bind(database) : value;
      },
    },
  ),
}));
jest.unstable_mockModule(
  "../services/outreach/ProviderBindingService.js",
  () => ({
    resolveOfficialProviderBinding: jest.fn(
      async (
        _userId: number,
        _channel: string,
        options: { providerAccountId: string },
      ) =>
        options.providerAccountId === "disconnected"
          ? null
          : {
              providerAccountId: options.providerAccountId,
              accountName: "Original account",
            },
    ),
  }),
);
// Assistant readiness has its own tests; here every account may reply.
jest.unstable_mockModule("../services/assistants/CustomerDeliveryGate.js", () => ({
  customerDeliveryReadiness: jest.fn(async () => ({ ready: true, setupUrl: "", accountId: "", channel: "" })),
}));
jest.unstable_mockModule("../services/whatsappServiceWindow.js", () => ({
  hasActiveWhatsAppWindow: jest.fn(async () => false),
  activeWhatsAppWindows: jest.fn(async () => new Set()),
}));
const { listInbox, getInboxItem, parseInboxQuery, prepareInboxSearch } =
  await import("../services/outreach/InboxService.js");
const { privacyVaultService } = await import('../services/agents/orchestration/PrivacyVaultService.js');

suite("Unified inbox PostgreSQL integration", () => {
  it('restores contact details only for an owner viewing an exact retained inbound email', async () => {
    const original = "Yes, I'm interested in a conversation. Priya Shah <priya@example.com> wrote:";
    const protectedText = "Yes, I'm [NAME_123] a conversation. Priya Shah <[EMAIL_456]> wrote:";
    const conversation = (await client.query("INSERT INTO outreach_conversations(user_id,lead_id,channel,last_message_at) VALUES(1,1,'gmail',NOW()) RETURNING id")).rows[0].id;
    const message = (await client.query("INSERT INTO outreach_messages(conversation_id,user_id,direction,content,redacted_content,privacy_vault_id) VALUES($1,1,'inbound',$2,$2,731) RETURNING id", [conversation, protectedText])).rows[0].id;
    await client.query('INSERT INTO support_privacy_vault(id,user_id,conversation_id,message_id) VALUES(731,1,$1,$2)', [conversation, message]);
    const reveal = jest.spyOn(privacyVaultService, 'reveal').mockResolvedValue({ rawText: original, piiTypes: ['email'], expiresAt: new Date(Date.now() + 60000) });
    try {
      expect((await getInboxItem(1, 'conversation', conversation, 1))?.item.preview).toBe(original);
      expect((await listInbox(1, parseInboxQuery({}), 1)).items.find(item => item.id === conversation && item.kind === 'conversation')?.preview).toBe(original);
      expect((await getInboxItem(1, 'conversation', conversation))?.item.preview).toBe(protectedText);
      expect((await getInboxItem(1, 'conversation', conversation, 2))?.item.preview).toBe(protectedText);
      expect(await getInboxItem(2, 'conversation', conversation, 2)).toBeNull();
      await prepareInboxSearch(1);
      const stored = (await client.query('SELECT content,redacted_content,inbox_search_text FROM outreach_messages WHERE id=$1', [message])).rows[0];
      expect(stored.content).toBe(protectedText);
      expect(stored.redacted_content).toBe(protectedText);
      expect(stored.inbox_search_text).not.toContain('priya@example.com');
      await client.query('UPDATE support_privacy_vault SET message_id=$1 WHERE id=731', [message + 1]);
      expect((await getInboxItem(1, 'conversation', conversation, 1))?.item.preview).toBe(protectedText);
    } finally {
      reveal.mockRestore();
      await client.query('DELETE FROM support_privacy_vault WHERE id=731');
      await client.query('DELETE FROM outreach_messages WHERE conversation_id=$1', [conversation]);
      await client.query('DELETE FROM outreach_conversations WHERE id=$1', [conversation]);
    }
  });

  it('projects historical HTML receipts and explicit plain text into safe previews and search', async () => {
    const html = '<style>body {color:red}</style><p>Historic orchidtemplate message</p><script>legacyScriptSource()</script>';
    const ids: number[] = [];
    try {
      for (const [body, format, key] of [[html, null, 'legacy-html-qa'], ['<p>Literal plain example</p> Contact <sales@example.com> <script>', 'text', 'legacy-text-qa']] as const) {
        const result = await client.query(`INSERT INTO sent_messages(user_id,lead_id,channel,message,message_format,status,sent_at,message_id) VALUES(1,1,'gmail',$1,$2,'sent',NOW(),$3) RETURNING id`, [body, format, key]);
        ids.push(result.rows[0].id);
      }
      const historical = await getInboxItem(1, 'legacy', ids[0]);
      expect(historical?.item.preview).toBe('Historic orchidtemplate message');
      expect(historical?.message?.content).toBe('Historic orchidtemplate message');
      await prepareInboxSearch(1);
      const found = await listInbox(1, parseInboxQuery({ search: 'orchidtemplate' }));
      expect(found.items.some(item => item.kind === 'legacy' && item.id === ids[0])).toBe(true);
      const indexed = await client.query('SELECT inbox_search_text FROM sent_messages WHERE id=$1', [ids[0]]);
      expect(indexed.rows[0].inbox_search_text).not.toMatch(/color:red|legacyScriptSource|<style>/);
      const literal = await getInboxItem(1, 'legacy', ids[1]);
      expect(literal?.message?.content).toContain('<p>Literal plain example</p>');
      expect(literal?.message?.content).toContain('<script>');
      expect(literal?.message?.content).toContain('<[EMAIL_');
      expect(literal?.message?.content).not.toContain('sales@example.com');
      // A format-only correction must invalidate the previously built projection.
      await client.query("UPDATE sent_messages SET message_format='html' WHERE id=$1", [ids[0]]);
      expect((await client.query('SELECT inbox_search_text FROM sent_messages WHERE id=$1', [ids[0]])).rows[0].inbox_search_text).toBeNull();
      await prepareInboxSearch(1);
      expect((await getInboxItem(1, 'legacy', ids[0]))?.message?.content).toBe('Historic orchidtemplate message');
    } finally {
      await client.query('DELETE FROM sent_messages WHERE id=ANY($1::int[])', [ids]);
    }
  });

  it('reapplies and rolls back the format migration without dropping receipt bodies', async () => {
    const before = await client.query('SELECT id,message FROM sent_messages ORDER BY id');
    await addEmailFormat(client);
    await removeEmailFormat(client);
    expect((await client.query('SELECT id,message FROM sent_messages ORDER BY id')).rows).toEqual(before.rows);
    await addEmailFormat(client);
    await expect(client.query("INSERT INTO sent_messages(message_format) VALUES('bad')")).rejects.toThrow();
  });

  it('rebuilds old non-null native and legacy search caches after the format upgrade', async () => {
    const conversation = (await client.query("INSERT INTO outreach_conversations(user_id,lead_id,channel,last_message_at) VALUES(1,1,'email',NOW()) RETURNING id")).rows[0].id;
    let legacyId: number | undefined;
    try {
      const html = '<style>body {color:red}</style><p>Upgrade orchidhtml readable</p><script>upgradeScriptLeak()</script>';
      await client.query("INSERT INTO outreach_messages(conversation_id,user_id,direction,content,html_content) VALUES($1,1,'outbound',$2,NULL),($1,1,'outbound',$3,$3)", [conversation, 'Quoted <widget> example', html]);
      await client.query("UPDATE outreach_messages SET inbox_search_text='Old cached text without the missing token' WHERE conversation_id=$1", [conversation]);
      legacyId = (await client.query("INSERT INTO sent_messages(user_id,lead_id,channel,message,status,sent_at,message_id) VALUES(1,1,'gmail',$1,'sent',NOW(),'upgrade-legacy-html') RETURNING id", [html])).rows[0].id;
      await client.query("UPDATE sent_messages SET inbox_search_text='Old cached CSS and upgradeScriptLeak' WHERE id=$1", [legacyId]);
      expect((await listInbox(1, parseInboxQuery({ search: 'widget' }))).items.some(item => item.kind === 'conversation' && item.id === conversation)).toBe(false);
      await addEmailFormat(client);
      expect((await client.query('SELECT inbox_search_text FROM outreach_messages WHERE conversation_id=$1', [conversation])).rows.every(row => row.inbox_search_text === null)).toBe(true);
      expect((await client.query('SELECT inbox_search_text FROM sent_messages WHERE id=$1', [legacyId])).rows[0].inbox_search_text).toBeNull();
      const found = await listInbox(1, parseInboxQuery({ search: 'widget' }));
      expect(found.items.some(item => item.kind === 'conversation' && item.id === conversation)).toBe(true);
      const native = (await client.query('SELECT inbox_search_text FROM outreach_messages WHERE conversation_id=$1 ORDER BY id', [conversation])).rows;
      expect(native[0].inbox_search_text).toContain('widget');
      expect(native[1].inbox_search_text).toContain('orchidhtml');
      expect(native[1].inbox_search_text).not.toMatch(/color:red|upgradeScriptLeak|<style>/);
      const legacy = (await client.query('SELECT inbox_search_text FROM sent_messages WHERE id=$1', [legacyId])).rows[0].inbox_search_text;
      expect(legacy).toContain('orchidhtml');
      expect(legacy).not.toMatch(/color:red|upgradeScriptLeak|<style>/);
      // Changing only the HTML source must invalidate and rebuild native search.
      await client.query("UPDATE outreach_messages SET html_content='<p>Changed orchidrevision</p>' WHERE conversation_id=$1 AND html_content IS NOT NULL", [conversation]);
      await prepareInboxSearch(1);
      expect((await listInbox(1, parseInboxQuery({ search: 'orchidrevision' }))).items.some(item => item.id === conversation)).toBe(true);
    } finally {
      await client.query('DELETE FROM sent_messages WHERE id=$1', [legacyId ?? -1]);
      await client.query('DELETE FROM outreach_messages WHERE conversation_id=$1', [conversation]);
      await client.query('DELETE FROM outreach_conversations WHERE id=$1', [conversation]);
    }
  });

  beforeAll(async () => {
    if (
      !connectionString ||
      !["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(connectionString).hostname,
      )
    )
      throw new Error("Explicit local QA database required");
    types.setTypeParser(1114, (value) => new Date(`${value}Z`));
    client = new Client({ connectionString });
    await client.connect();
    await client.query(
      `CREATE SCHEMA inbox_qa_${process.pid}; SET search_path TO inbox_qa_${process.pid}, pg_catalog`,
    );
    database = drizzle(client);
    await client.query(`
      CREATE TABLE leads(id INTEGER PRIMARY KEY,user_id INTEGER,full_name TEXT,name TEXT,email TEXT,phone TEXT,
        company TEXT,company_name TEXT,instagram_handle TEXT,twitter_handle TEXT,linkedin_username TEXT,
        blacklisted BOOLEAN DEFAULT false,do_not_contact BOOLEAN DEFAULT false,email_unsubscribed BOOLEAN DEFAULT false);
      CREATE TABLE outreach_conversations(id SERIAL PRIMARY KEY,user_id INTEGER,lead_id INTEGER,channel TEXT,lead_name TEXT,lead_email TEXT,
        lead_company TEXT,lead_avatar TEXT,subject TEXT,last_message_at TIMESTAMP,created_at TIMESTAMP DEFAULT NOW(),unread_count INTEGER DEFAULT 0,
        total_messages INTEGER DEFAULT 1,status TEXT DEFAULT 'active',integration_provider TEXT,provider_account_id TEXT,metadata JSONB,
        external_thread_id TEXT,lead_instagram TEXT);
      CREATE TABLE outreach_messages(id SERIAL PRIMARY KEY,conversation_id INTEGER,user_id INTEGER,direction TEXT,subject TEXT,content TEXT,html_content TEXT,
        redacted_content TEXT,privacy_vault_id BIGINT,external_message_id TEXT,provider_message_id TEXT,rfc_message_id TEXT,waba_message_id TEXT,provider_account_id TEXT,
        phone_number_id TEXT,sent_at TIMESTAMP,created_at TIMESTAMP DEFAULT NOW(),is_read BOOLEAN DEFAULT false,metadata JSONB,
        batch_id UUID,campaign_id INTEGER,message_kind TEXT DEFAULT 'outreach',is_automatic BOOLEAN DEFAULT false,is_ai_generated BOOLEAN DEFAULT false,
        status TEXT DEFAULT 'sent');
      CREATE TABLE sent_messages(id SERIAL PRIMARY KEY,user_id INTEGER,lead_id INTEGER,lead_name TEXT,channel TEXT,subject TEXT,message TEXT,
        status TEXT,delivery_status TEXT,sent_at TIMESTAMP,message_id TEXT,gmail_message_id TEXT,sender_id INTEGER,is_reply BOOLEAN DEFAULT false);
      CREATE TABLE email_senders(id INTEGER,user_id INTEGER,email TEXT,type TEXT,credential_id INTEGER,is_verified BOOLEAN);
      CREATE TABLE support_privacy_vault(id BIGINT PRIMARY KEY,user_id INTEGER,conversation_id INTEGER,message_id INTEGER);
      CREATE TABLE channel_credentials(id INTEGER,user_id INTEGER,platform TEXT,account_name TEXT,account_identifier TEXT,is_active BOOLEAN,
        api_secret TEXT,api_key TEXT,session_data JSONB);
      INSERT INTO leads(id,user_id,full_name,email,phone,company) VALUES(1,1,'Asha Raman','asha@example.test','919876543210','Orchid Labs'),(2,2,'Foreign contact','foreign@example.test',NULL,'Foreign');
    `);
    await up(client);
    await addEmailFormat(client);
    const channels = [
      "email",
      "gmail",
      "whatsapp",
      "instagram",
      "facebook",
      "sms",
      "linkedin",
      "twitter",
    ];
    for (let i = 0; i < channels.length; i++) {
      const c = (
        await client.query(
          `INSERT INTO outreach_conversations(user_id,lead_id,channel,last_message_at,unread_count,provider_account_id,external_thread_id,integration_provider)
        VALUES(1,1,$1,'2026-09-26 10:00:00.123456',2,'account-a','recipient-a',$2) RETURNING id`,
          [
            channels[i],
            channels[i] === "gmail" || channels[i] === "email" ? "gmail" : null,
          ],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO outreach_messages(conversation_id,user_id,direction,content,subject,external_message_id,provider_account_id)
        VALUES($1,1,'outbound',$2,'Offer','message-'||($1::integer)::text,'account-a')`,
        [c, `Channel ${channels[i]} pricing request`],
      );
      await client.query(
        `INSERT INTO outreach_messages(conversation_id,user_id,direction,content) VALUES($1,1,'inbound','First reply'),($1,1,'inbound','Second reply')`,
        [c],
      );
      await client.query(
        `INSERT INTO sent_messages(user_id,lead_id,lead_name,channel,message,status,sent_at,message_id)
        VALUES(1,1,'Asha',$1,'Receipt copy','sent','2026-09-26 10:00:00.123456',$2)`,
        [channels[i], `message-${c}`],
      );
    }
    await client.query(`INSERT INTO sent_messages(user_id,lead_id,lead_name,channel,message,status,sent_at,message_id) VALUES
      (1,1,'Asha','email','Historic renewal quotation','sent','2026-09-25 10:00:00','legacy-one'),
      (1,1,'Asha','email','Pending draft','pending','2026-09-27 10:00:00','draft'),
      (2,2,'Foreign','email','Foreign secret','sent','2026-09-27 10:00:00','legacy-one');
      INSERT INTO channel_credentials VALUES(1,1,'msg91_sms','SMS sender','account-a',true,'dummy','account-a','{"senderId":"ORCHID","flowId":"test_flow"}');`);
  });
  afterAll(async () => {
    if (client) {
      await client.query(
        `DROP SCHEMA IF EXISTS inbox_qa_${process.pid} CASCADE`,
      );
      await client.end();
    }
  });

  it('preserves scoped contact links and rejects malformed contact filters', async () => {
    const owned = await listInbox(1, parseInboxQuery({ leadId: '1' }));
    expect(owned.items.length).toBeGreaterThan(0);
    expect(owned.items.every(item => item.leadId === 1)).toBe(true);
    const foreign = await listInbox(1, parseInboxQuery({ leadId: '2' }));
    expect(foreign.items).toEqual([]);
    expect(foreign.unreadThreads.all).toBe(0);
    for (const leadId of ['0', '-1', '1x', '9007199254740992', ['1']]) expect(() => parseInboxQuery({ leadId })).toThrow('Invalid inbox contact');
  });

  it("links both insertion orders and does not include receipt copies as extra conversations", async () => {
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM sent_messages WHERE outreach_message_id IS NOT NULL",
        )
      ).rows[0].n,
    ).toBe(8);
    const page = await listInbox(1, parseInboxQuery({}));
    expect(page.items).toHaveLength(7);
    expect(new Set(page.items.map((i) => i.channel)).size).toBe(5);
    expect(page.items.some((i) => ["linkedin", "twitter"].includes(i.channel))).toBe(false);
    expect(page.items.find(item => item.channel === 'sms')?.reply.canReply).toBe(false);
    expect(page.items.filter((i) => i.kind === "legacy")).toHaveLength(1);
    expect(page.unreadThreads.email).toBe(2);
    expect(page.unreadThreads.sms).toBe(1);
    expect(page.unreadThreads.all).toBe(6);
    expect(
      page.items
        .filter((item) => item.kind === "conversation")
        .every((item) => item.unreadCount === 2),
    ).toBe(true);
    expect(
      page.items
        .filter((item) => item.kind === "conversation")
        .every((item) => item.activityAt === "2026-09-26T10:00:00.123456Z"),
    ).toBe(true);
    expect((await getInboxItem(1, "conversation", 1))?.item.activityAt).toBe(
      "2026-09-26T10:00:00.123456Z",
    );
    expect(page.items.every((i) => i.leadName === "Asha Raman")).toBe(true);
    await client.query(
      "UPDATE outreach_messages SET is_read=true WHERE conversation_id=1 AND direction='inbound'",
    );
    const readPage = await listInbox(1, parseInboxQuery({}));
    expect(readPage.unreadThreads.all).toBe(5);
    expect(
      readPage.items.find((item) => item.key === "conversation:1")?.unreadCount,
    ).toBe(0);
    await client.query(
      "UPDATE outreach_messages SET is_read=false WHERE conversation_id=1 AND direction='inbound'",
    );
    await client.query(`INSERT INTO sent_messages(user_id,lead_id,channel,message,status,sent_at,message_id) VALUES(1,1,'email','Later projection','sent',NOW(),'later-native');
      INSERT INTO outreach_messages(conversation_id,user_id,direction,content,external_message_id) VALUES(1,1,'outbound','Later projection','later-native');`);
    expect(
      (
        await client.query(
          "SELECT outreach_message_id FROM sent_messages WHERE message_id='later-native'",
        )
      ).rows[0].outreach_message_id,
    ).not.toBeNull();
  });

  it("paginates ties without dropping microsecond timestamps and searches beyond the first page", async () => {
    const keys: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listInbox(
        1,
        parseInboxQuery({ limit: "2", ...(cursor ? { cursor } : {}) }),
      );
      keys.push(...page.items.map((i) => i.key));
      cursor = page.nextCursor;
    } while (cursor);
    expect(keys).toHaveLength(7);
    expect(new Set(keys).size).toBe(7);
    const result = await listInbox(1, parseInboxQuery({ search: "renewal" }));
    expect(result.items.map((i) => i.kind)).toEqual(["legacy"]);
    const contact = await listInbox(
      1,
      parseInboxQuery({ search: "Orchid", channel: "email" }),
    );
    expect(contact.items).toHaveLength(3);
    for (const search of ["Asha Raman", "asha@example.test", "919876543210"]) {
      expect(
        (await listInbox(1, parseInboxQuery({ search }))).items,
      ).toHaveLength(7);
    }
    const subjects = await listInbox(1, parseInboxQuery({ search: "Offer" }));
    expect(subjects.items).toHaveLength(6);
    expect(subjects.items.every((item) => item.kind === "conversation")).toBe(
      true,
    );
    expect(
      (await listInbox(1, parseInboxQuery({ unread: "true" }))).items,
    ).toHaveLength(6);
    expect(parseInboxQuery({ channel: 'sms' }).channel).toBe('sms');
    for (const channel of ["linkedin", "twitter"]) {
      expect(() => parseInboxQuery({ channel })).toThrow("Invalid inbox channel");
    }
    for (const id of [7, 8]) {
      expect(await getInboxItem(1, "conversation", id)).toBeNull();
    }
  });

  it("keeps account threads distinct and never resolves an ambiguous provider ID", async () => {
    await client.query(
      "UPDATE outreach_conversations SET provider_account_id='account-b' WHERE id=2",
    );
    const separate = await listInbox(1, parseInboxQuery({ channel: "email" }));
    expect(
      separate.items.find((item) => item.key === "conversation:1")?.reply
        .providerAccountId,
    ).toBe("account-a");
    expect(
      separate.items.find((item) => item.key === "conversation:2")?.reply
        .providerAccountId,
    ).toBe("account-b");
    await client.query(
      "UPDATE outreach_conversations SET provider_account_id='account-a' WHERE id=2",
    );
    await client.query(
      `INSERT INTO outreach_messages(conversation_id,user_id,direction,content,external_message_id) VALUES(2,1,'outbound','Ambiguous','message-1');`,
    );
    expect(
      (
        await client.query(
          "SELECT outreach_message_id FROM sent_messages WHERE message_id='message-1' AND user_id=1",
        )
      ).rows[0].outreach_message_id,
    ).toBeNull();
    await client.query(`INSERT INTO sent_messages(user_id,lead_id,channel,message,status,sent_at,message_id,gmail_message_id) VALUES(1,1,'email','Empty IDs','sent',NOW(),'different','');
      INSERT INTO outreach_messages(conversation_id,user_id,direction,content,external_message_id,rfc_message_id) VALUES(1,1,'outbound','Empty native IDs','unrelated','');`);
    expect(
      (
        await client.query(
          "SELECT outreach_message_id FROM sent_messages WHERE message_id='different'",
        )
      ).rows[0].outreach_message_id,
    ).toBeNull();
    expect(await getInboxItem(2, "conversation", 1)).toBeNull();
    const foreign = (
      await client.query("SELECT id FROM sent_messages WHERE user_id=2")
    ).rows[0].id;
    expect(await getInboxItem(1, "legacy", foreign)).toBeNull();
  });

  it('keeps plain preview examples and redaction while explicitly converting the HTML fallback', async () => {
    const conversation = (await client.query("INSERT INTO outreach_conversations(user_id,lead_id,channel,last_message_at,provider_account_id) VALUES(1,1,'email',NOW(),'account-a') RETURNING id")).rows[0].id;
    const message = (await client.query("INSERT INTO outreach_messages(conversation_id,user_id,direction,content) VALUES($1,1,'inbound',$2) RETURNING id", [conversation, 'Contact <sales@example.test> tomorrow. Use <script> as a literal example.'])).rows[0].id;
    const plain = await getInboxItem(1, 'conversation', conversation);
    expect(plain?.item.preview).toContain('Contact <[EMAIL_');
    expect(plain?.item.preview).toContain('Use <script> as a literal example');
    expect(plain?.item.preview).not.toContain('sales@example.test');
    await client.query("UPDATE outreach_messages SET redacted_content=$1,html_content=$2 WHERE id=$3", ['Keep <script> as text. [EMAIL_7]', '<style>body {color:red}</style><p>Actual &amp; readable</p><script>danger()</script>', message]);
    expect((await getInboxItem(1, 'conversation', conversation))?.item.preview).toBe('Keep <script> as text. [EMAIL_7]');
    await client.query('UPDATE outreach_messages SET redacted_content=NULL WHERE id=$1', [message]);
    expect((await getInboxItem(1, 'conversation', conversation))?.item.preview).toBe('Actual & readable');
    await client.query('DELETE FROM outreach_messages WHERE id=$1', [message]);
    await client.query('DELETE FROM outreach_conversations WHERE id=$1', [conversation]);
  });

  it("uses redacted text for message search and refreshes the projection after edits", async () => {
    await client.query(
      "UPDATE outreach_messages SET content='New itinerary. Password: sample-secret. Email private-address@hidden.test' WHERE id=1",
    );
    await prepareInboxSearch(1);
    const safe = (
      await client.query(
        "SELECT inbox_search_text FROM outreach_messages WHERE id=1",
      )
    ).rows[0].inbox_search_text;
    expect(safe).toContain("itinerary");
    expect(safe).not.toContain("sample-secret");
    expect(safe).not.toContain("private-address@hidden.test");
    expect(
      (await listInbox(1, parseInboxQuery({ search: "itinerary" }))).items.some(
        (i) => i.key === "conversation:1",
      ),
    ).toBe(true);
    expect(
      (await listInbox(1, parseInboxQuery({ search: "sample-secret" }))).items,
    ).toHaveLength(0);
  });

  it("reconciles changed IDs and preserves separate campaign, follow-up, and inbound messages", async () => {
    await client.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content,external_message_id) VALUES
      (4,1,'outbound','Campaign offer','campaign-ig'),(4,1,'outbound','Follow-up offer','followup-ig'),(4,1,'inbound','Accepted offer','inbound-ig');
      INSERT INTO sent_messages(user_id,lead_id,channel,message,status,sent_at,message_id) VALUES
      (1,1,'instagram','Campaign receipt','sent',NOW(),'campaign-ig'),(1,1,'instagram','Follow-up receipt','sent',NOW(),'followup-ig'),
      (1,1,'instagram','Inbound receipt','received',NOW(),'inbound-ig');`);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM sent_messages WHERE message_id IN ('campaign-ig','followup-ig','inbound-ig') AND outreach_message_id IS NOT NULL",
        )
      ).rows[0].n,
    ).toBe(3);
    await client.query(
      "UPDATE outreach_messages SET external_message_id='corrected-campaign-ig' WHERE external_message_id='campaign-ig'",
    );
    expect(
      (
        await client.query(
          "SELECT outreach_message_id FROM sent_messages WHERE message_id='campaign-ig'",
        )
      ).rows[0].outreach_message_id,
    ).toBeNull();
    await client.query(
      "UPDATE sent_messages SET message_id='corrected-campaign-ig' WHERE message_id='campaign-ig'",
    );
    expect(
      (
        await client.query(
          "SELECT outreach_message_id FROM sent_messages WHERE message_id='corrected-campaign-ig'",
        )
      ).rows[0].outreach_message_id,
    ).not.toBeNull();
    await up(client);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM sent_messages WHERE message_id IN ('corrected-campaign-ig','followup-ig','inbound-ig') AND outreach_message_id IS NOT NULL",
        )
      ).rows[0].n,
    ).toBe(3);
  });

  it("binds verified email senders to their original account and rejects a changed credential", async () => {
    await client.query(`UPDATE outreach_conversations SET lead_email='asha@example.test' WHERE id=2;
      INSERT INTO email_senders VALUES(7,1,'sales@example.test','gmail',7,true);
      INSERT INTO channel_credentials(id,user_id,platform,account_identifier,is_active) VALUES(7,1,'gmail_api','account-a',true);
      UPDATE sent_messages SET sender_id=7 WHERE message_id='message-2';`);
    expect(
      (await getInboxItem(1, "conversation", 2))?.item.reply,
    ).toMatchObject({
      canReply: true,
      providerAccountId: "account-a",
      senderId: 7,
    });
    await client.query(
      "UPDATE channel_credentials SET account_identifier='different-account' WHERE id=7",
    );
    expect(
      (await getInboxItem(1, "conversation", 2))?.item.reply,
    ).toMatchObject({ canReply: false });
    expect(
      (await getInboxItem(1, "conversation", 2))?.item.reply.reason,
    ).toContain("no longer matches");
  });

  it("blocks unavailable accounts, opt-outs, and legacy replies, and requires WhatsApp templates", async () => {
    const legacy = (
      await client.query(
        "SELECT id FROM sent_messages WHERE message_id='legacy-one' AND user_id=1",
      )
    ).rows[0].id;
    expect((await getInboxItem(1, "legacy", legacy))?.item.reply.canReply).toBe(
      false,
    );
    expect(
      (await getInboxItem(1, "conversation", 3))?.item.reply.requiresTemplate,
    ).toBe(true);
    await client.query(
      "UPDATE outreach_conversations SET provider_account_id='disconnected' WHERE id=3",
    );
    expect(
      (await getInboxItem(1, "conversation", 3))?.item.reply.reason,
    ).toContain("disconnected");
    await client.query("UPDATE leads SET do_not_contact=true WHERE id=1");
    expect(
      (await getInboxItem(1, "conversation", 4))?.item.reply.reason,
    ).toContain("opted out");
  });

  it("pages actual thread history by a stable message boundary while new replies arrive", async () => {
    const { getTableColumns } = await import("drizzle-orm");
    const { outreachMessagesTable } =
      await import("../models/outreachConversations/schema.js");
    const existing = new Set(
      (
        await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='outreach_messages'",
        )
      ).rows.map((r) => r.column_name),
    );
    for (const column of Object.values(
      getTableColumns(outreachMessagesTable),
    )) {
      if (!existing.has(column.name))
        await client.query(
          `ALTER TABLE outreach_messages ADD COLUMN "${column.name}" ${column.getSQLType()}${column.name === "business_profile_id" ? " DEFAULT 11" : ""}`,
        );
    }
    const { getMessagesByConversationId } =
      await import("../models/outreachConversations/functions.js");
    await client.query(`INSERT INTO outreach_conversations(id,user_id,lead_id,channel,last_message_at) VALUES(501,1,1,'sms',NOW());
      INSERT INTO outreach_messages(id,conversation_id,user_id,direction,content,created_at)
      SELECT 20000+n,501,1,'outbound','Older history '||n,'2026-09-25 12:00:00.123456'::timestamp FROM generate_series(1,6) n;`);
    const first = await getMessagesByConversationId(501, 2);
    expect(first.map((message) => message.id)).toEqual([20006, 20005]);
    await client.query(
      "INSERT INTO outreach_messages(id,conversation_id,user_id,direction,content,created_at) VALUES(20007,501,1,'outbound','New arrival',NOW())",
    );
    const second = await getMessagesByConversationId(501, 2, 0, first[1].id);
    expect(second.map((message) => message.id)).toEqual([20004, 20003]);
    expect(await getMessagesByConversationId(501, 2, 0, 1)).toEqual([]);
  });

  it("keeps list, detail, counts, search and exact links inside the active business profile", async () => {
    const tables = [
      "leads",
      "outreach_conversations",
      "outreach_messages",
      "sent_messages",
      "email_senders",
      "channel_credentials",
    ];
    const role = `inbox_qa_role_${process.pid}`;
    await client.query(`CREATE ROLE ${role} NOLOGIN; GRANT USAGE ON SCHEMA inbox_qa_${process.pid} TO ${role};
      GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA inbox_qa_${process.pid} TO ${role};`);
    try {
      for (const table of tables)
        await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS business_profile_id INTEGER DEFAULT 11;
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
        CREATE POLICY inbox_test_scope ON ${table} USING(user_id=current_setting('app.current_user_id')::integer
          AND business_profile_id=current_setting('app.business_profile_id')::integer);`);
      await client.query(`INSERT INTO outreach_conversations(id,user_id,lead_id,channel,lead_email,provider_account_id,last_message_at,unread_count,business_profile_id)
        VALUES(998,1,1,'email','other@profile.test','account-a',NOW(),9,22);
        INSERT INTO outreach_messages(conversation_id,user_id,direction,content,external_message_id,business_profile_id)
        VALUES(998,1,'inbound','Other business uniquephrase','other-business-id',22);
        INSERT INTO sent_messages(user_id,lead_id,channel,message,status,sent_at,message_id,business_profile_id)
        VALUES(1,1,'email','Different business receipt','received',NOW(),'other-business-id',11);`);
      expect(
        (
          await client.query(
            "SELECT outreach_message_id FROM sent_messages WHERE message_id='other-business-id'",
          )
        ).rows[0].outreach_message_id,
      ).toBeNull();
      await client.query(
        `SET ROLE ${role}; SELECT set_config('app.current_user_id','1',false),set_config('app.business_profile_id','11',false)`,
      );
      expect(await getInboxItem(1, "conversation", 998)).toBeNull();
      expect(
        (await listInbox(1, parseInboxQuery({ search: "uniquephrase" }))).items,
      ).toHaveLength(0);
      const firstProfile = await listInbox(1, parseInboxQuery({}));
      expect(firstProfile.items.some((item) => item.id === 998)).toBe(false);
      expect(firstProfile.unreadThreads.all).toBe(6);
      // "All N" counts exactly the threads the list can show in this profile.
      expect(firstProfile.nextCursor).toBeNull();
      expect(firstProfile.totalThreads?.all).toBe(firstProfile.items.length);
      await client.query(
        "SELECT set_config('app.business_profile_id','22',false)",
      );
      const otherProfile = await listInbox(
        1,
        parseInboxQuery({ search: "uniquephrase" }),
      );
      expect(otherProfile.items.map((item) => item.key)).toEqual([
        "conversation:998",
      ]);
      expect(otherProfile.unreadThreads.email).toBe(1);
      const otherAll = await listInbox(1, parseInboxQuery({}));
      expect(otherAll.totalThreads?.all).toBe(otherAll.items.length);
    } finally {
      await client.query(
        `RESET ROLE; DROP OWNED BY ${role}; DROP ROLE ${role}`,
      );
    }
  });

  it("classifies each thread by its first message, filters by origin and counts every thread", async () => {
    const user = 9;
    await client.query("INSERT INTO leads(id,user_id,full_name,phone) VALUES(90,9,'Origin lead','919000000090') ON CONFLICT DO NOTHING");
    const thread = async (first: string, account: string) => {
      const id = (await client.query("INSERT INTO outreach_conversations(user_id,lead_id,channel,provider_account_id,last_message_at) VALUES($1,90,'whatsapp',$2,NOW()) RETURNING id", [user, account])).rows[0].id;
      await client.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content,sent_at,provider_account_id,phone_number_id,metadata,batch_id,is_ai_generated) ${first}`.replace(/\$C/g, String(id)), []);
      return id;
    };
    const outreach = await thread("VALUES($C,9,'outbound','Launch',NOW() - interval '2 hours','acct-o','acct-o',NULL,'00000000-0000-0000-0000-000000000001',false),($C,9,'outbound','AI reply',NOW(),'acct-o','acct-o','{\"origin\":\"ai\"}',NULL,false)", 'acct-o');
    const customer = await thread("VALUES($C,9,'inbound','Hi there',NOW(),'acct-c','acct-c',NULL,NULL,false)", 'acct-c');
    await client.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content,created_at,metadata,status)
      VALUES($1,$2,'outbound','Old AI draft',NOW() - INTERVAL '1 day','{"origin":"ai"}','draft')`, [customer, user]);
    const manual = await thread("VALUES($C,9,'outbound','Hello from the inbox',NOW(),'acct-m','acct-m','{\"origin\":\"inbox\"}',NULL,false)", 'acct-m');
    const phone = await thread("VALUES($C,9,'outbound','From my phone',NOW(),'acct-p','acct-p','{\"origin\":\"native_app\"}',NULL,false)", 'acct-p');
    await client.query("INSERT INTO sent_messages(user_id,lead_id,channel,message,status,sent_at,message_id) VALUES(9,90,'whatsapp','Old send','sent',NOW(),'origin-legacy')");

    const all = await listInbox(user, parseInboxQuery({ channel: "whatsapp" }));
    const byId = new Map(all.items.filter(item => item.kind === "conversation").map(item => [item.id, item]));
    expect(byId.get(outreach)).toMatchObject({ origin: "outreach", aiHandled: true });
    expect(byId.get(customer)).toMatchObject({ origin: "customer", aiHandled: false });
    expect(byId.get(manual)?.origin).toBe("manual");
    expect(byId.get(phone)?.origin).toBe("native_app");
    expect(all.items.find(item => item.kind === "legacy")?.origin).toBe("outreach");
    expect(all.totalThreads).toMatchObject({ whatsapp: 5, all: 5 });
    expect(all.originCounts).toEqual({ outreach: 2, customer: 1, manual: 1, native_app: 1, ai: 1 });

    const onlyOutreach = await listInbox(user, parseInboxQuery({ channel: "whatsapp", origin: "outreach" }));
    expect(onlyOutreach.items.map(item => item.origin)).toEqual(["outreach", "outreach"]);
    const onlyAi = await listInbox(user, parseInboxQuery({ channel: "whatsapp", origin: "ai" }));
    expect(onlyAi.items.map(item => item.id)).toEqual([outreach]);
    expect(() => parseInboxQuery({ origin: "spam" })).toThrow("Invalid inbox origin.");
  });
});

describe("Inbox query validation", () => {
  it("rejects malformed filters and cursors", () => {
    for (const query of [
      { channel: "web" },
      { unread: "yes" },
      { limit: "0" },
      { limit: "1000" },
      { search: ["x"] },
      { cursor: "bad" },
    ])
      expect(() => parseInboxQuery(query)).toThrow();
  });
});
