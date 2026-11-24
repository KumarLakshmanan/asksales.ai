import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// A fully migrated, disposable local database is required. No .env is loaded.
const connectionString = process.env.PROPOSAL_AUDIT_DATABASE_URL;
const databaseTests = connectionString ? describe : describe.skip;
const browserTest = process.env.PROPOSAL_AUDIT_BROWSER_URL ? it : it.skip;
// Keep browser-only types local: globally loading lib.dom changes server fetch
// overloads and breaks unrelated Node Buffer request bodies.
type BrowserGlobals = {
  document: {
    querySelector(selector: string): { textContent: string | null } | null;
    documentElement: { scrollWidth: number };
    createRange(): { setStart(node: unknown, offset: number): void; setEnd(node: unknown, offset: number): void; getClientRects(): { length: number } };
  };
  innerWidth: number;
  visualViewport?: { scale: number };
};
let admin: Pool;
let pool: Pool;
let database: NodePgDatabase;
let userId: number;
let businessId: number;
let otherBusinessId: number;
let proposalId: number;
let token: string;
const notify = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
const forbiddenProvider = jest.fn(async () => { throw new Error('External providers are forbidden in proposal audit'); });

jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) {
    const value = database[key as keyof typeof database];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: { notify } }));
jest.unstable_mockModule('../services/emailService', () => ({ emailService: { sendEmailWithUserCredentials: forbiddenProvider } }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory', () => ({ LLMProviderFactory: { createProviderForUser: forbiddenProvider } }));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: { retrieveText: forbiddenProvider } }));
jest.unstable_mockModule('../services/CreditService.js', () => ({ creditService: { reserveOutreachCredit: forbiddenProvider, refundDeduction: forbiddenProvider } }));
jest.unstable_mockModule('../utils/emailTemplates', () => ({
  getBrandInfo: async () => ({ companyName: 'Synthetic Proposal Audit', primaryColor: '#14532d', logoUrl: null }),
  renderBrandedEmail: forbiddenProvider,
  renderAdminEmail: forbiddenProvider,
}));

const { proposalService } = await import('../services/ProposalService.js');
const { proposalLifecycleService } = await import('../services/ProposalLifecycleService.js');
const { processProposalEvents } = await import('../services/ProposalWorkspaceService.js');
const { proposalDeliveryService, ProposalDeliveryService } = await import('../services/ProposalDeliveryService.js');
const { saveProposalReviewPolicy, reviewProposalForDelivery, listProposalApprovals, decideProposalApproval } = await import('../services/ProposalApprovalService.js');
const { proposalBusinessScope } = await import('../middleware/publicBusinessScope.js');
const { getPublicProposal, markPublicProposalViewed, acceptPublicProposal, rejectPublicProposal } = await import('../controllers/proposalController.js');
const { getPublicProposalFeedback, createPublicProposalFeedback } = await import('../controllers/proposalLifecycleController.js');
const { validateBody } = await import('../middleware/validation.js');
const { publicProposalResponseSchema } = await import('../middleware/schemas.js');
const app = express();
app.use(express.json());
app.use('/api/proposals/public/:token', proposalBusinessScope);
app.get('/api/proposals/public/:token', getPublicProposal);
app.post('/api/proposals/public/:token/view', markPublicProposalViewed);
app.post('/api/proposals/public/:token/accept', validateBody(publicProposalResponseSchema), acceptPublicProposal);
app.post('/api/proposals/public/:token/reject', validateBody(publicProposalResponseSchema), rejectPublicProposal);
app.get('/api/proposals/public/:token/feedback', getPublicProposalFeedback);
app.post('/api/proposals/public/:token/feedback', createPublicProposalFeedback);

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const path = (suffix = '') => `/api/proposals/public/${token}${suffix}`;
const feedback = (overrides: Record<string, unknown> = {}) => ({
  kind: 'question', content: 'Can you confirm the agreed delivery date?', authorName: 'Synthetic Customer',
  requestKey: 'synthetic-feedback-request', ...overrides,
});
const seller = <T>(work: () => T, selectedBusinessId = businessId) => withBusinessScope({ userId, businessProfileId: selectedBusinessId }, work);

async function row() { return (await admin.query('SELECT * FROM proposals WHERE id=$1', [proposalId])).rows[0]; }
async function draft(extra: Partial<Parameters<typeof proposalService.createProposal>[1]> = {}) {
  return seller(() => proposalService.createProposal(userId, {
    title: 'Synthetic domain proposal', coverNote: 'Deliver the agreed synthetic report.',
    recipientName: 'Synthetic Customer', recipientEmail: 'customer@example.test', currency: 'USD',
    termsAndConditions: 'Payment due on completion.', showTermsAndConditions: true, autoOnboard: false,
    lineItems: [{ name: 'Synthetic report', quantity: 1, unitPrice: 100, priceConfirmed: true }], ...extra,
  }));
}
async function widgetDraft() {
  const team = await admin.query("INSERT INTO support_teams(user_id,business_profile_id,name,is_active) VALUES($1,$2,'Synthetic Review Team',true) RETURNING id", [userId, businessId]);
  const members = await admin.query("INSERT INTO team_members(user_id,business_profile_id,team_id,name,email,is_active) VALUES($1,$2,$3,'Synthetic Reviewer One',$4,true),($1,$2,$3,'Synthetic Reviewer Two',$5,true) RETURNING id", [userId, businessId, team.rows[0].id, `reviewer-${crypto.randomUUID()}@example.test`, `reviewer-${crypto.randomUUID()}@example.test`]);
  const lead = await admin.query("INSERT INTO leads(user_id,business_profile_id,uuid,source,status,name,email) VALUES($1,$2,gen_random_uuid(),'manual','new','Synthetic Customer','customer@example.test') RETURNING id", [userId, businessId]);
  const session = await admin.query("INSERT INTO support_chat_sessions(member_id,business_profile_id,lead_id,title,session_expires_at,automation_mode) VALUES($1,$2,$3,'Synthetic Customer',NOW()+INTERVAL '1 day','ai_active') RETURNING id", [members.rows[0].id, businessId, lead.rows[0].id]);
  const conversation = await admin.query("INSERT INTO outreach_conversations(user_id,business_profile_id,lead_id,channel,external_thread_id,lead_name,lead_email,metadata) VALUES($1,$2,$3,'web',$4,'Synthetic Customer','customer@example.test',$5::jsonb) RETURNING id", [userId, businessId, lead.rows[0].id, `support-widget:${session.rows[0].id}`, JSON.stringify({ supportWidgetSessionId: session.rows[0].id })]);
  await admin.query('UPDATE support_chat_sessions SET metadata=$1::jsonb WHERE id=$2', [JSON.stringify({ widgetProposalIdentity: { conversationId: conversation.rows[0].id, leadId: lead.rows[0].id } }), session.rows[0].id]);
  return { proposal: await draft({ leadId: lead.rows[0].id, outreachConversationId: conversation.rows[0].id }), members: members.rows.map(member => Number(member.id)), sessionId: Number(session.rows[0].id) };
}

// Hold the proposal update lock until the HTTP handler has reached its write.
// pg_stat_activity proves ordering; no timing-only assumption decides the race.
async function capabilityRace(change: string, suffix: string) {
  const lock = await admin.connect();
  await lock.query('BEGIN');
  await lock.query(`UPDATE proposals SET ${change} WHERE id=$1`, [proposalId]);
  const response = request(app).post(path(suffix)).send({ name: 'Synthetic Customer' }).then(value => value);
  try {
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      const blocked = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%proposals%' AND (query ILIKE '%UPDATE%' OR query ILIKE '%FOR UPDATE%') AND pid<>pg_backend_pid()");
      if (blocked.rowCount) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
  } finally {
    await lock.query('COMMIT');
    lock.release();
  }
  return response;
}

databaseTests('public proposal lifecycle through real HTTP and business-scoped PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(connectionString!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/proposal_audit(?:_[a-z0-9_]+)?$/.test(url.pathname)) {
      throw new Error('Use a disposable local proposal_audit database');
    }
    // System context is confined to synthetic fixture setup/inspection. Every
    // application handler below uses the real unprivileged scoped pool.
    admin = new Pool({ connectionString, max: 5, options: '-c app.business_system=on' });
    expect(Number((await admin.query('SELECT count(*) FROM js_migrations')).rows[0].count)).toBeGreaterThanOrEqual(314);
    const user = await admin.query("INSERT INTO users(email,password,name) VALUES($1,'unused','Synthetic Proposal Seller') RETURNING id", [`proposal-audit-${crypto.randomUUID()}@example.test`]);
    userId = Number(user.rows[0].id);
    const businesses = await admin.query("INSERT INTO company_settings(user_id,company_name,billing_organization_id) SELECT $1,'Synthetic Proposal Business',id FROM billing_organizations WHERE owner_user_id=$1 RETURNING id", [userId]);
    businessId = Number(businesses.rows[0].id);
    const other = await admin.query("INSERT INTO company_settings(user_id,company_name,billing_organization_id) SELECT $1,'Second Synthetic Business',id FROM billing_organizations WHERE owner_user_id=$1 RETURNING id", [userId]);
    otherBusinessId = Number(other.rows[0].id);
    pool = new Pool({ connectionString, max: 10, options: '-c lock_timeout=1500 -c statement_timeout=10000' });
    database = drizzle(createBusinessScopedPool(pool));
  });
  afterAll(async () => {
    expect(forbiddenProvider).not.toHaveBeenCalled();
    if (pool) await pool.end();
    if (admin) await admin.end();
  });
  beforeEach(async () => {
    notify.mockClear();
    await admin.query('DELETE FROM proposal_review_policies WHERE user_id=$1', [userId]);
    token = crypto.randomBytes(32).toString('base64url');
    const seeded = await admin.query(`INSERT INTO proposals(user_id,business_profile_id,proposal_number,title,cover_note,recipient_name,recipient_email,status,sent_at,valid_until,public_token_hash,public_token_expires_at,metadata)
      VALUES($1,$2,$3,'Synthetic consulting proposal','One agreed report.','Synthetic Customer','customer@example.test','sent',NOW(),NOW()+INTERVAL '7 days',$4,NOW()+INTERVAL '30 days','{"autoOnboard":false}') RETURNING id`,
    [userId, businessId, `AUDIT-${crypto.randomUUID()}`, hash(token)]);
    proposalId = Number(seeded.rows[0].id);
    await admin.query("INSERT INTO proposal_line_items(proposal_id,business_profile_id,name,quantity,unit_price,total) VALUES($1,$2,'Synthetic report',1,100,100)", [proposalId, businessId]);
    await admin.query("INSERT INTO proposal_reminders(user_id,business_profile_id,proposal_id,reminder_type,reminder_due_at,status) VALUES($1,$2,$3,'customer_followup',NOW()+INTERVAL '1 day','pending')", [userId, businessId, proposalId]);
  });

  it('opens and marks a valid token viewed; exposes only the customer document', async () => {
    const opened = await request(app).get(path());
    expect(opened.status).toBe(200);
    expect(opened.headers['cache-control']).toContain('no-store');
    expect(opened.body.data.title).toBe('Synthetic consulting proposal');
    expect(opened.body.data).not.toHaveProperty('publicTokenHash');
    expect(opened.body.data).not.toHaveProperty('userId');
    expect((await request(app).post(path('/view'))).body.data.status).toBe('viewed');
    expect((await row()).status).toBe('viewed');
  });

  it.each(['revoked', 'expired'])('denies every public endpoint for a %s token', async state => {
    await admin.query(`UPDATE proposals SET ${state === 'revoked' ? 'public_token_hash=NULL' : "public_token_expires_at=NOW()-INTERVAL '1 second'"} WHERE id=$1`, [proposalId]);
    for (const suffix of ['', '/feedback']) expect((await request(app).get(path(suffix))).status).toBe(404);
    for (const suffix of ['/view', '/accept', '/reject', '/feedback']) expect((await request(app).post(path(suffix)).send(feedback())).status).toBe(404);
    expect((await row()).status).toBe('sent');
  });

  it('enforces business isolation even for the same seller', async () => {
    expect(await seller(() => proposalService.getProposalById(userId, proposalId), otherBusinessId)).toBeNull();
    expect(await seller(() => proposalService.getProposalById(userId, proposalId))).not.toBeNull();
  });

  it('rejects feedback after the offer expires without changing reminders or creating feedback', async () => {
    await admin.query("UPDATE proposals SET valid_until=NOW()-INTERVAL '1 second' WHERE id=$1", [proposalId]);
    expect((await request(app).post(path('/feedback')).send(feedback())).status).toBe(410);
    expect((await admin.query('SELECT id FROM proposal_feedback WHERE proposal_id=$1', [proposalId])).rowCount).toBe(0);
    expect((await admin.query('SELECT status FROM proposal_reminders WHERE proposal_id=$1', [proposalId])).rows[0].status).toBe('pending');
    expect(notify).not.toHaveBeenCalled();
  });

  it('records concurrent identical feedback once and notifies once', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => request(app).post(path('/feedback')).send(feedback())));
    expect(results.map(result => result.status)).toEqual(Array(8).fill(201));
    expect(new Set(results.map(result => result.body.data.id)).size).toBe(1);
    expect((await admin.query('SELECT id FROM proposal_feedback WHERE proposal_id=$1', [proposalId])).rowCount).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await admin.query('SELECT status FROM proposal_reminders WHERE proposal_id=$1', [proposalId])).rows[0].status).toBe('paused');
  });

  it('rejects a changed payload reusing a feedback request key', async () => {
    expect((await request(app).post(path('/feedback')).send(feedback())).status).toBe(201);
    expect((await request(app).post(path('/feedback')).send(feedback({ content: 'A different request' }))).status).toBe(409);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('replays recorded feedback after acceptance without pausing a reminder again', async () => {
    const first = await request(app).post(path('/feedback')).send(feedback());
    await admin.query("UPDATE proposals SET status='accepted',accepted_at=NOW() WHERE id=$1", [proposalId]);
    await admin.query("UPDATE proposal_reminders SET status='cancelled' WHERE proposal_id=$1", [proposalId]);
    const replay = await request(app).post(path('/feedback')).send(feedback());
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await admin.query('SELECT status FROM proposal_reminders WHERE proposal_id=$1', [proposalId])).rows[0].status).toBe('cancelled');
  });

  it.each(['/accept', '/reject', '/view'])('does not use a token revoked between lookup and %s', async suffix => {
    const response = await capabilityRace('public_token_hash=NULL,public_token_expires_at=NULL', suffix);
    expect(response.status).toBe(404);
    expect((await row()).status).toBe('sent');
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(['/accept', '/reject', '/view'])('does not use a token expired between lookup and %s', async suffix => {
    const response = await capabilityRace("public_token_expires_at=NOW()-INTERVAL '1 day'", suffix);
    expect(response.status).toBe(404);
    expect((await row()).status).toBe('sent');
  });

  it.each(['/feedback', '/accept', '/reject', '/view'])('rejects %s when token lifetime elapses while waiting for the proposal lock', async suffix => {
    await admin.query("UPDATE proposals SET public_token_expires_at=clock_timestamp()+INTERVAL '500 milliseconds' WHERE id=$1", [proposalId]);
    const lock = await admin.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM proposals WHERE id=$1 FOR UPDATE', [proposalId]);
    const response = request(app).post(path(suffix)).send(suffix === '/feedback' ? feedback() : {}).then(value => value);
    try {
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (Date.now() < deadline) {
        const blocked = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%public_token_hash%' AND (query ILIKE '%UPDATE%' OR query ILIKE '%FOR UPDATE%')");
        if (blocked.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      while ((await admin.query('SELECT public_token_expires_at>clock_timestamp() AS active FROM proposals WHERE id=$1', [proposalId])).rows[0].active) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally {
      await lock.query('COMMIT'); lock.release();
    }
    expect((await response).status).toBe(404);
    expect((await admin.query('SELECT id FROM proposal_feedback WHERE proposal_id=$1', [proposalId])).rowCount).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'rejected', 'superseded'])('preserves the %s terminal state on a late view', async status => {
    await admin.query("UPDATE proposals SET status=$1,valid_until=NOW()-INTERVAL '1 day' WHERE id=$2", [status, proposalId]);
    expect((await request(app).post(path('/view'))).body.data.status).toBe(status);
    expect((await request(app).get(path())).body.data.status).toBe(status);
    expect((await row()).status).toBe(status);
  });

  it('serializes competing acceptance and rejection and replays only the winning response', async () => {
    const results = await Promise.all([
      request(app).post(path('/accept')).send({ name: 'Synthetic Customer' }),
      request(app).post(path('/reject')).send({ reason: 'Synthetic reason' }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const winner = (await row()).status;
    expect(notify).toHaveBeenCalledTimes(1);
    const replay = await request(app).post(path(winner === 'accepted' ? '/accept' : '/reject')).send({});
    expect(replay.status).toBe(200);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('projects acceptance through the real CRM service (resolve contact: %s) and cancels reminders once', async resolveContact => {
    const lead = await admin.query("INSERT INTO leads(user_id,business_profile_id,uuid,source,status) VALUES($1,$2,gen_random_uuid(),'manual','new') RETURNING id", [userId, businessId]);
    const leadId = Number(lead.rows[0].id);
    const contact = await admin.query("INSERT INTO crm_contacts(user_id,business_profile_id,lead_id,first_name,email,pipeline_status) VALUES($1,$2,$3,'Synthetic CRM Customer','synthetic@example.test','new') RETURNING id", [userId, businessId, leadId]);
    const contactId = Number(contact.rows[0].id);
    await admin.query('UPDATE proposals SET contact_id=$1,lead_id=$2 WHERE id=$3', [resolveContact ? null : contactId, leadId, proposalId]);
    expect((await request(app).post(path('/accept')).send({})).status).toBe(200);
    await seller(() => processProposalEvents({ userId, proposalId }));
    await seller(() => processProposalEvents({ userId, proposalId }));
    expect((await admin.query('SELECT pipeline_status FROM crm_contacts WHERE id=$1', [contactId])).rows[0].pipeline_status).toBe('won');
    expect((await admin.query("SELECT id FROM crm_activities WHERE contact_id=$1 AND type='pipeline_change'", [contactId])).rowCount).toBe(1);
    expect((await admin.query('SELECT status FROM proposal_reminders WHERE proposal_id=$1', [proposalId])).rows[0].status).toBe('cancelled');
    expect((await admin.query('SELECT id FROM proposal_events WHERE proposal_id=$1 AND processed_at IS NULL', [proposalId])).rowCount).toBe(0);
    expect((await row()).contact_id).toBe(contactId);
  });

  it('retries a failed proposal event after CRM commits without duplicating the CRM transition', async () => {
    const contact = await admin.query("INSERT INTO crm_contacts(user_id,business_profile_id,first_name,pipeline_status) VALUES($1,$2,'Synthetic Retry Customer','new') RETURNING id", [userId, businessId]);
    const contactId = Number(contact.rows[0].id);
    await admin.query('UPDATE proposals SET contact_id=$1 WHERE id=$2', [contactId, proposalId]);
    expect((await request(app).post(path('/accept')).send({})).status).toBe(200);
    const functionName = `proposal_audit_failure_${proposalId}`;
    await admin.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.contact_id=${contactId} AND NEW.type='proposal' THEN RAISE EXCEPTION 'Synthetic proposal activity failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER ${functionName} BEFORE INSERT ON crm_activities FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      await seller(() => processProposalEvents({ userId, proposalId }));
      expect((await admin.query('SELECT pipeline_status FROM crm_contacts WHERE id=$1', [contactId])).rows[0].pipeline_status).toBe('won');
      const failed = await admin.query('SELECT last_error FROM proposal_events WHERE proposal_id=$1 AND processed_at IS NULL', [proposalId]);
      expect(failed.rows.length).toBeGreaterThan(0);
      expect(failed.rows.every(event => event.last_error)).toBe(true);
    } finally {
      await admin.query(`DROP TRIGGER ${functionName} ON crm_activities; DROP FUNCTION ${functionName}()`);
    }
    await admin.query('UPDATE proposal_events SET next_attempt_at=NOW() WHERE proposal_id=$1', [proposalId]);
    await seller(() => processProposalEvents({ userId, proposalId }));
    expect((await admin.query('SELECT id FROM proposal_events WHERE proposal_id=$1 AND processed_at IS NULL', [proposalId])).rowCount).toBe(0);
    expect((await admin.query("SELECT id FROM crm_activities WHERE contact_id=$1 AND type='pipeline_change'", [contactId])).rowCount).toBe(1);
  });

  it('deduplicates concurrent draft creation using the real business-scoped unique index', async () => {
    const draftKey = crypto.randomUUID();
    const created = await Promise.all(Array.from({ length: 6 }, () => draft({ draftKey })));
    expect(new Set(created.map(proposal => proposal.id)).size).toBe(1);
    expect((await admin.query('SELECT id FROM proposals WHERE user_id=$1 AND business_profile_id=$2 AND draft_key=$3', [userId, businessId, draftKey])).rowCount).toBe(1);
  });

  it('freezes catalog/template content in drafts, records versions, and rejects stale edits', async () => {
    const catalog = await admin.query("INSERT INTO proposal_catalog(user_id,business_profile_id,name,currency,unit_price,unit) VALUES($1,$2,'Agreed report','USD',100,'report') RETURNING id", [userId, businessId]);
    const template = await seller(() => proposalService.createTemplate(userId, { name: 'Synthetic template', templateContent: { sections: [{ title: 'Scope', body: 'Agreed report for {{client_name}}.', kind: 'content' }], requiredFields: [], placeholders: [], warnings: [] } }));
    const created = await draft({ templateId: template.id, lineItems: [{ catalogId: catalog.rows[0].id, name: 'Untrusted replacement', unitPrice: 1 }] });
    let saved = (await seller(() => proposalService.getProposalById(userId, created.id)))!;
    expect(saved.lineItems[0]).toMatchObject({ name: 'Agreed report', unitPrice: '100.00' });
    await admin.query("UPDATE proposal_catalog SET name='New report',unit_price=200,active=false WHERE id=$1", [catalog.rows[0].id]);
    await seller(() => proposalService.updateTemplate(userId, template.id, { name: 'Changed later' }));
    saved = (await seller(() => proposalService.updateProposal(userId, created.id, { expectedRevision: saved.revision, lineItems: [{ ...saved.lineItems[0], quantity: 2 }] })))!;
    expect(saved.lineItems[0]).toMatchObject({ name: 'Agreed report', unitPrice: '100.00', quantity: '2.00' });
    expect(Number(saved.total)).toBe(200);
    expect(saved.metadata?.templateSnapshot?.name).toBe('Synthetic template');
    const versions = await admin.query('SELECT snapshot FROM proposal_versions WHERE proposal_id=$1', [created.id]);
    expect(versions.rowCount).toBe(1);
    expect(versions.rows[0].snapshot.lineItems[0].quantity).toBe('1.00');
    await expect(seller(() => proposalService.updateProposal(userId, created.id, { expectedRevision: 1, title: 'Stale change' }))).rejects.toMatchObject({ statusCode: 409 });
    await expect(draft({ lineItems: [{ catalogId: catalog.rows[0].id, name: 'Retired report' }] })).rejects.toThrow('retired');
    await expect(seller(() => proposalService.getCatalogItems(userId), otherBusinessId)).resolves.toEqual([]);
  });

  it('previews and atomically replaces follow-ups, then pauses them on customer feedback', async () => {
    const input = { timezone: 'Asia/Kolkata', steps: [{ afterDays: 1, localTime: '10:00', subject: 'Synthetic follow-up', message: 'Please review the agreed report.' }] };
    const preview = await seller(() => proposalLifecycleService.previewFollowups(userId, proposalId, input));
    expect(preview.scheduled).toHaveLength(1);
    await Promise.all(Array.from({ length: 3 }, () => seller(() => proposalLifecycleService.scheduleFollowups(userId, proposalId, input))));
    const pending = await admin.query("SELECT reminder_due_at FROM proposal_reminders WHERE proposal_id=$1 AND status='pending'", [proposalId]);
    expect(pending.rowCount).toBe(1);
    expect(pending.rows[0].reminder_due_at.toISOString()).toBe(preview.scheduled[0].reminderDueAt);
    expect((await request(app).post(path('/feedback')).send(feedback())).status).toBe(201);
    expect((await admin.query("SELECT id FROM proposal_reminders WHERE proposal_id=$1 AND status='pending'", [proposalId])).rowCount).toBe(0);
    await expect(seller(() => proposalLifecycleService.scheduleFollowups(userId, proposalId, { ...input, timezone: 'Invalid/Zone' }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it.each(['accepted', 'rejected', 'expired'])('cancels pending, paused and snoozed follow-ups after %s', async status => {
    await admin.query("INSERT INTO proposal_reminders(user_id,business_profile_id,proposal_id,reminder_type,reminder_due_at,status,snoozed_until) VALUES($1,$2,$3,'customer_followup',NOW()+INTERVAL '1 day','snoozed',NOW()+INTERVAL '1 day'),($1,$2,$3,'customer_followup',NOW()+INTERVAL '1 day','paused',NULL)", [userId, businessId, proposalId]);
    await admin.query('UPDATE proposals SET status=$1 WHERE id=$2', [status, proposalId]);
    await seller(() => processProposalEvents({ userId, proposalId }));
    expect((await admin.query('SELECT status FROM proposal_reminders WHERE proposal_id=$1', [proposalId])).rows.map(reminder => reminder.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });

  it('requires current team reviews and delivers one durable web receipt on retry', async () => {
    const { proposal, members, sessionId } = await widgetDraft();
    await seller(() => saveProposalReviewPolicy(userId, { enabled: true, amountThreshold: 1, reviewManualPricing: false, reviewerMemberIds: members }));
    const review = await seller(() => proposalDeliveryService.prepare(userId, proposal.id, { channel: 'web' }));
    expect(review.ready).toBe(true);
    const reviewed = await seller(() => reviewProposalForDelivery(userId, proposal.id, { channel: 'web', expectedRevision: proposal.revision, expectedTargetFingerprint: review.targetFingerprint, expectedReviewFingerprint: review.reviewFingerprint }));
    expect(reviewed.approved).toBe(false);
    const requests: Array<{ id: number; reviewerMemberId: number; fingerprint: string }> = await seller(() => listProposalApprovals(userId, proposal.id));
    expect(requests).toHaveLength(2);
    const decisions = await Promise.all(requests.map(item => seller(() => decideProposalApproval(userId, Number(item.reviewerMemberId), Number(item.id), { decision: 'approved', fingerprint: item.fingerprint }))));
    expect(decisions.map(decision => decision.approved).sort()).toEqual([false, true]);
    const current = (await seller(() => proposalService.getProposalById(userId, proposal.id)))!;
    const input = { channel: 'web' as const, expectedRevision: current.revision, idempotencyKey: crypto.randomUUID() };
    const first = await seller(() => proposalDeliveryService.send(userId, proposal.id, input));
    const replay = await seller(() => proposalDeliveryService.send(userId, proposal.id, input));
    expect(first.delivery.state).toBe('sent');
    expect(replay.publicUrl).toBe(first.publicUrl);
    expect((await admin.query('SELECT id FROM support_chat_messages WHERE session_id=$1', [sessionId])).rowCount).toBe(1);
    const receipt = (await admin.query('SELECT status,provider_message_id FROM support_delivery_outbox WHERE id=$1', [first.delivery.actionId])).rows[0];
    expect(receipt.status).toBe('sent');
    expect(receipt.provider_message_id).toMatch(/^web:/);
    await expect(seller(() => proposalDeliveryService.send(userId, proposal.id, { ...input, subject: 'Changed request' }))).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects stale team review after a draft edit', async () => {
    const { proposal, members } = await widgetDraft();
    await seller(() => saveProposalReviewPolicy(userId, { enabled: true, amountThreshold: 1, reviewManualPricing: false, reviewerMemberIds: members }));
    const review = await seller(() => proposalDeliveryService.prepare(userId, proposal.id, { channel: 'web' }));
    const reviewed = await seller(() => reviewProposalForDelivery(userId, proposal.id, { channel: 'web', expectedRevision: proposal.revision, expectedTargetFingerprint: review.targetFingerprint, expectedReviewFingerprint: review.reviewFingerprint }));
    const requests: Array<{ id: number; reviewerMemberId: number; fingerprint: string }> = await seller(() => listProposalApprovals(userId, proposal.id));
    await seller(() => proposalService.updateProposal(userId, proposal.id, { title: 'A changed report', expectedRevision: reviewed.revision }));
    await expect(seller(() => decideProposalApproval(userId, Number(requests[0].reviewerMemberId), Number(requests[0].id), { decision: 'approved', fingerprint: requests[0].fingerprint }))).rejects.toMatchObject({ statusCode: 409 });
  });

  it.each([false, true])('persists a provider failure (uncertain: %s) and never repeats its request key', async uncertain => {
    const { proposal } = await widgetDraft();
    const review = await seller(() => proposalDeliveryService.prepare(userId, proposal.id, { channel: 'web' }));
    const reviewed = await seller(() => reviewProposalForDelivery(userId, proposal.id, { channel: 'web', expectedRevision: proposal.revision, expectedTargetFingerprint: review.targetFingerprint, expectedReviewFingerprint: review.reviewFingerprint }));
    const provider = jest.fn(async () => ({ success: false, outcomeUncertain: uncertain, deliveryAttempted: uncertain, error: 'Synthetic provider failure' }));
    const delivery = new ProposalDeliveryService({ dispatch: provider });
    const input = { channel: 'web' as const, expectedRevision: reviewed.revision, idempotencyKey: crypto.randomUUID() };
    const first = await seller(() => delivery.send(userId, proposal.id, input));
    const replay = await seller(() => delivery.send(userId, proposal.id, input));
    expect(first.delivery.state).toBe(uncertain ? 'uncertain' : 'failed');
    expect(replay.delivery.state).toBe(first.delivery.state);
    expect(provider).toHaveBeenCalledTimes(1);
    const saved = (await admin.query('SELECT status,public_token_hash FROM proposals WHERE id=$1', [proposal.id])).rows[0];
    expect(saved.status).toBe(uncertain ? 'delivery_unknown' : 'draft');
    if (!uncertain) expect(saved.public_token_hash).toBeNull();
    if (uncertain) await expect(seller(() => delivery.send(userId, proposal.id, { ...input, idempotencyKey: crypto.randomUUID() }))).rejects.toMatchObject({ statusCode: 409 });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('cancels delivery when the reviewed widget session closes after the durable claim', async () => {
    const { proposal, sessionId } = await widgetDraft();
    const review = await seller(() => proposalDeliveryService.prepare(userId, proposal.id, { channel: 'web' }));
    const reviewed = await seller(() => reviewProposalForDelivery(userId, proposal.id, { channel: 'web', expectedRevision: proposal.revision, expectedTargetFingerprint: review.targetFingerprint, expectedReviewFingerprint: review.reviewFingerprint }));
    const provider = jest.fn(async () => ({ success: true, messageId: 'must-not-be-called' }));
    const delivery = new ProposalDeliveryService({
      reserve: async () => { await admin.query("UPDATE support_chat_sessions SET automation_mode='human_active' WHERE id=$1", [sessionId]); return { success: true }; },
      dispatch: provider,
    });
    await expect(seller(() => delivery.send(userId, proposal.id, { channel: 'web', expectedRevision: reviewed.revision, idempotencyKey: crypto.randomUUID() }))).rejects.toMatchObject({ code: 'PROPOSAL_DELIVERY_GATED' });
    expect(provider).not.toHaveBeenCalled();
    expect((await admin.query('SELECT status,public_token_hash FROM proposals WHERE id=$1', [proposal.id])).rows[0]).toEqual({ status: 'draft', public_token_hash: null });
  });

  browserTest.each([1440, 390])('renders the real customer journey and PDF at %ipx, normal zoom', async width => {
    const base = new URL(process.env.PROPOSAL_AUDIT_BROWSER_URL!);
    if (base.hostname !== '127.0.0.1') throw new Error('Browser QA must use the disposable loopback server');
    const server = app.listen(58080, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // No browser request may reach a provider or remote account.
    await context.route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort());
    try {
      await page.goto(`${base.origin}/proposal/${token}`);
      await page.getByRole('heading', { name: 'Synthetic consulting proposal' }).waitFor({ timeout: 90000 });
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelector('header')?.textContent?.includes('viewed'));
      expect((await row()).status).toBe('viewed');
      expect(await page.evaluate(() => {
        const viewport = globalThis as unknown as BrowserGlobals;
        return { zoom: viewport.visualViewport?.scale, overflow: viewport.document.documentElement.scrollWidth > viewport.innerWidth };
      })).toEqual({ zoom: 1, overflow: false });
      const companyNameLines = await page.locator('.proposal-brand strong').evaluate(element => {
        const word = (globalThis as unknown as BrowserGlobals).document.createRange();
        const text = (element as unknown as { firstChild: unknown }).firstChild;
        word.setStart(text, 0); word.setEnd(text, 'Synthetic'.length);
        return word.getClientRects().length;
      });
      expect(companyNameLines).toBe(1);
      await page.getByLabel('Your question', { exact: true }).fill('Please confirm the synthetic delivery date.');
      await page.getByRole('button', { name: 'Send to proposal owner' }).click();
      await page.getByRole('list', { name: 'Proposal discussion' }).getByText('Please confirm the synthetic delivery date.').waitFor();
      expect((await admin.query('SELECT id FROM proposal_feedback WHERE proposal_id=$1', [proposalId])).rowCount).toBe(1);
      expect((await admin.query('SELECT status FROM proposal_reminders WHERE proposal_id=$1', [proposalId])).rows[0].status).toBe('paused');
      await mkdir('/tmp/proposal-audit-browser', { recursive: true });
      await page.screenshot({ path: `/tmp/proposal-audit-browser/customer-${width}.png`, fullPage: true });
      const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
      await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
      const download = await downloadPromise;
      const pdfPath = `/tmp/proposal-audit-browser/customer-${width}.pdf`;
      await download.saveAs(pdfPath);
      expect((await readFile(pdfPath)).subarray(0, 5).toString()).toBe('%PDF-');
      const text = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
      expect(text).toContain('Synthetic consulting proposal');
      expect(text).toContain('Synthetic report');
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Accept proposal', exact: true }).click();
      await page.getByText('Proposal accepted', { exact: true }).waitFor();
      expect((await row()).status).toBe('accepted');
      await page.reload();
      await page.getByText('Proposal accepted', { exact: true }).waitFor();
      expect(await page.getByRole('button', { name: 'Accept proposal', exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 180000);
});
