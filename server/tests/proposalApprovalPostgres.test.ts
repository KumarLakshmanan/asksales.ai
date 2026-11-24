import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client, Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

const connectionString = process.env.PROPOSAL_QA_DATABASE_URL;
const databaseTests = connectionString ? describe : describe.skip;
const schema = `proposal_approval_qa_${Date.now()}_${process.pid}`;
let admin: Client;
let pool: Pool;
let database: NodePgDatabase;

const targetFingerprint = 'a'.repeat(64);
const reviewFingerprint = 'b'.repeat(64);
const prepare = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();

async function loadProposal(userId: number, proposalId: number) {
  const proposal = (await database.execute(sql`
    SELECT * FROM proposals WHERE id=${proposalId} AND user_id=${userId}
  `)).rows[0] as Record<string, unknown> | undefined;
  if (!proposal) return null;
  const items = (await database.execute(sql`
    SELECT * FROM proposal_line_items WHERE proposal_id=${proposalId} ORDER BY sort_order,id
  `)).rows as Array<Record<string, unknown>>;
  return {
    id: Number(proposal.id),
    userId: Number(proposal.user_id),
    businessProfileId: Number(proposal.business_profile_id),
    revision: Number(proposal.revision),
    status: String(proposal.status),
    proposalNumber: String(proposal.proposal_number),
    title: String(proposal.title),
    coverNote: proposal.cover_note as string | null,
    recipientName: proposal.recipient_name as string | null,
    recipientEmail: proposal.recipient_email as string | null,
    currency: String(proposal.currency),
    subtotal: String(proposal.subtotal),
    discountType: proposal.discount_type as string | null,
    discountValue: String(proposal.discount_value),
    taxRate: String(proposal.tax_rate),
    total: String(proposal.total),
    validUntil: proposal.valid_until as Date | null,
    signatureRequired: Boolean(proposal.signature_required),
    termsAndConditions: proposal.terms_and_conditions as string | null,
    showTermsAndConditions: Boolean(proposal.show_terms_and_conditions),
    metadata: (proposal.metadata || {}) as Record<string, unknown>,
    lineItems: items.map(item => ({
      id: Number(item.id),
      catalogId: item.catalog_id === null ? null : Number(item.catalog_id),
      name: String(item.name),
      description: item.description as string | null,
      quantity: String(item.quantity),
      unitPrice: String(item.unit_price),
      unit: String(item.unit),
      discount: String(item.discount),
      total: String(item.total),
      isComplimentary: Boolean(item.is_complimentary),
      priceConfirmed: Boolean(item.price_confirmed),
      isOptional: Boolean(item.is_optional),
      selected: Boolean(item.selected),
      packageId: item.package_id as string | null,
      billingPeriod: String(item.billing_period) as 'one_time' | 'monthly' | 'quarterly' | 'yearly',
    })),
  };
}

class MockProposalDeliveryError extends Error {
  constructor(
    message: string,
    public statusCode = 409,
    public code = 'PROPOSAL_DELIVERY_REVIEW_REQUIRED',
    public issues?: unknown[],
  ) {
    super(message);
  }
}

jest.unstable_mockModule('../models/db.js', () => ({
  db: new Proxy({}, {
    get(_target, key) {
      const value = database[key as keyof typeof database];
      return typeof value === 'function' ? value.bind(database) : value;
    },
  }),
}));
jest.unstable_mockModule('../services/ProposalDeliveryService.js', () => ({
  proposalDeliveryService: { prepare },
  ProposalDeliveryError: MockProposalDeliveryError,
}));
jest.unstable_mockModule('../services/ProposalService.js', () => ({
  proposalService: { getProposalById: loadProposal },
}));

const {
  assertTeamProposalApprovals,
  decideProposalApproval,
  getProposalReviewers,
  listProposalApprovals,
  reviewProposalForDelivery,
  saveProposalReviewPolicy,
  getProposalReviewPolicy,
  assertAutomaticProposalCommercials,
} = await import('../services/ProposalApprovalService.js');

const reviewInput = {
  channel: 'email' as const,
  providerAccountId: 'seller@example.test',
  expectedRevision: 4,
  expectedTargetFingerprint: targetFingerprint,
  expectedReviewFingerprint: reviewFingerprint,
};

async function configurePolicy(reviewerMemberIds = [101, 102]) {
  return saveProposalReviewPolicy(9, {
    enabled: true,
    discountThresholdPct: 10,
    amountThreshold: 60,
    currency: 'USD',
    reviewManualPricing: true,
    reviewerMemberIds,
  });
}

databaseTests('proposal team approvals on isolated PostgreSQL', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
      throw new Error('Proposal QA requires local PostgreSQL.');
    }
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema},pg_catalog`);
    for (const table of ['proposals', 'proposal_line_items', 'proposal_catalog', 'proposal_templates', 'proposal_events', 'support_teams', 'team_members', 'proposal_approvals', 'proposal_review_policies']) {
      await admin.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      if (table !== 'proposal_review_policies') await admin.query(`CREATE SEQUENCE ${table}_qa_seq; ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${table}_qa_seq')`);
    }
    // Clone current compound business keys/defaults instead of pre-tenancy DDL.
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema},pg_catalog -c app.business_profile_id=9 -c app.current_user_id=9` });
    database = drizzle(pool);
  }, 60000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  }, 60000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE proposal_approvals,proposal_review_policies,proposal_events,proposal_line_items,proposal_catalog,proposal_templates,proposals,team_members,support_teams RESTART IDENTITY`);
    await pool.query(`
      INSERT INTO support_teams(id,user_id,name,is_active) VALUES
        (41,9,'Revenue approvals',true),
        (42,10,'Other workspace',true),
        (43,9,'Retired reviewers',false);
      INSERT INTO team_members(id,team_id,user_id,role,name,email,is_active) VALUES
        (101,41,9,'lead','Manager Reviewer','manager@example.test',true),
        (102,41,9,'admin','Finance Reviewer','finance@example.test',true),
        (103,41,9,'member','Inactive Reviewer','inactive@example.test',false),
        (104,42,10,'lead','Foreign Reviewer','foreign@example.test',true),
        (105,43,9,'lead','Retired Team Reviewer','retired@example.test',true)
    `);
    await pool.query('UPDATE support_teams SET business_profile_id=10 WHERE user_id=10; UPDATE team_members SET business_profile_id=10 WHERE user_id=10');
    await pool.query(`
      INSERT INTO proposal_catalog(id,user_id,name,description,currency,unit_price,unit,active)
      VALUES (501,9,'Implementation','Approved catalog rate','USD',100,'service',true);
      INSERT INTO proposals(
        id,user_id,proposal_number,revision,title,cover_note,recipient_name,recipient_email,
        currency,subtotal,discount_type,discount_value,tax_rate,total,status,valid_until,
        show_terms_and_conditions,terms_and_conditions,metadata
      ) VALUES (
        1,9,'PROP-APPROVAL-QA',4,'Implementation offer','Confirmed implementation scope.',
        'QA Customer','customer@example.test','USD',80,'percentage',20,0,64,'draft',
        NOW()+INTERVAL '14 days',true,'Payment due on acceptance.','{}'::jsonb
      );
      INSERT INTO proposal_line_items(
        id,proposal_id,sort_order,name,catalog_id,description,quantity,unit_price,unit,
        discount,total,is_complimentary,price_confirmed,is_optional,selected,billing_period
      ) VALUES (
        601,1,0,'Implementation',501,'Agreed delivery',1,80,'service',0,80,false,true,false,true,'one_time'
      )
    `);
    prepare.mockReset().mockImplementation(async (userId, proposalId) => {
      const proposal = await loadProposal(Number(userId), Number(proposalId));
      const target = {
        channel: 'email',
        providerVariant: 'resend',
        providerAccountId: 'seller@example.test',
        recipient: 'customer@example.test',
        recipientName: 'QA Customer',
        recipientEmail: 'customer@example.test',
        leadId: 17,
        outreachConversationId: 31,
        subject: 'Implementation offer',
        message: 'Please review the attached offer.',
      };
      return {
        ready: true,
        proposal,
        target,
        targetFingerprint,
        reviewFingerprint,
        issues: [],
        readiness: { ready: true, issues: [] },
      };
    });
  });

  it('allows only active reviewers from active teams in the same workspace', async () => {
    expect(await getProposalReviewers(9)).toEqual([
      expect.objectContaining({ id: 102, role: 'admin', teamName: 'Revenue approvals' }),
      expect.objectContaining({ id: 101, role: 'lead', teamName: 'Revenue approvals' }),
    ]);
    await expect(configurePolicy()).resolves.toMatchObject({ reviewerMemberIds: [101, 102] });
    for (const memberId of [103, 104, 105]) {
      await expect(configurePolicy([memberId])).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('creates immutable review requests for every assigned reviewer and keeps delivery gated until all approve', async () => {
    await configurePolicy();
    const review = await reviewProposalForDelivery(9, 1, reviewInput);
    expect(review).toMatchObject({
      approved: false,
      revision: 5,
      requirement: {
        required: true,
        reviewerMemberIds: [101, 102],
        reasons: expect.arrayContaining([
          'Declared discounts exceed 10%.',
          'The offer meets the USD 60 approval threshold.',
          'The offer includes manual or negotiated catalog pricing.',
        ]),
      },
      metadata: { teamApproval: { status: 'pending' } },
    });
    const requests = await listProposalApprovals(9, 1);
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((request: { fingerprint: string }) => request.fingerprint))).toEqual(new Set([review.metadata.teamApproval.fingerprint]));
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ reviewerMemberId: 101, decision: 'pending', snapshot: expect.objectContaining({ title: 'Implementation offer' }) }),
      expect.objectContaining({ reviewerMemberId: 102, decision: 'pending', snapshot: expect.objectContaining({ title: 'Implementation offer' }) }),
    ]));
    await expect(assertTeamProposalApprovals(9, (await loadProposal(9, 1))!)).rejects.toThrow('still pending');

    const manager = requests.find((request: { reviewerMemberId: number }) => request.reviewerMemberId === 101)! as { id: number; fingerprint: string };
    expect(await decideProposalApproval(9, 101, manager.id, { decision: 'approved', comment: 'Margin reviewed.', fingerprint: manager.fingerprint })).toMatchObject({ approved: false });
    await expect(assertTeamProposalApprovals(9, (await loadProposal(9, 1))!)).rejects.toThrow('still pending');

    const finance = requests.find((request: { reviewerMemberId: number }) => request.reviewerMemberId === 102)! as { id: number; fingerprint: string };
    expect(await decideProposalApproval(9, 102, finance.id, { decision: 'approved', comment: 'Budget reviewed.', fingerprint: finance.fingerprint })).toMatchObject({ approved: true });
    const approved = (await loadProposal(9, 1))!;
    await expect(assertTeamProposalApprovals(9, approved)).resolves.toBeUndefined();
    expect(approved.metadata).toMatchObject({
      approvalFingerprint: finance.fingerprint,
      teamApproval: { status: 'approved' },
    });
  });

  it('preserves a changes-requested status from any reviewer and requires a comment', async () => {
    await configurePolicy();
    await reviewProposalForDelivery(9, 1, reviewInput);
    const requests = await listProposalApprovals(9, 1) as Array<{ id: number; reviewerMemberId: number; fingerprint: string }>;
    const manager = requests.find(request => request.reviewerMemberId === 101)!;
    await expect(decideProposalApproval(9, 101, manager.id, {
      decision: 'changes_requested', comment: '   ', fingerprint: manager.fingerprint,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(await decideProposalApproval(9, 101, manager.id, {
      decision: 'changes_requested', comment: 'Reduce the unapproved discount.', fingerprint: manager.fingerprint,
    })).toMatchObject({ approved: false });

    const finance = requests.find(request => request.reviewerMemberId === 102)!;
    expect(await decideProposalApproval(9, 102, finance.id, {
      decision: 'approved', comment: 'Budget reviewed.', fingerprint: finance.fingerprint,
    })).toMatchObject({ approved: false });
    expect((await loadProposal(9, 1))!.metadata).toMatchObject({
      approvedAt: null,
      approvalFingerprint: null,
      teamApproval: { status: 'changes_requested' },
    });
    expect((await listProposalApprovals(9, 1)).find((request: { id: number }) => request.id === manager.id)).toMatchObject({
      decision: 'changes_requested',
      comment: 'Reduce the unapproved discount.',
    });
  });

  it('serializes simultaneous reviewer decisions and records the final approval', async () => {
    await configurePolicy();
    await reviewProposalForDelivery(9, 1, reviewInput);
    const requests = await listProposalApprovals(9, 1) as Array<{ id: number; reviewerMemberId: number; fingerprint: string }>;
    const decisions = await Promise.all(requests.map(request => decideProposalApproval(
      9,
      request.reviewerMemberId,
      request.id,
      { decision: 'approved', comment: 'Approved concurrently.', fingerprint: request.fingerprint },
    )));
    expect(decisions.map(decision => decision.approved).sort()).toEqual([false, true]);
    const approved = (await loadProposal(9, 1))!;
    expect(approved.metadata).toMatchObject({
      approvalFingerprint: requests[0].fingerprint,
      teamApproval: { status: 'approved' },
    });
    await expect(assertTeamProposalApprovals(9, approved)).resolves.toBeUndefined();
  });

  it('defaults to review and persists optional automatic sending per tenant', async () => {
    expect((await getProposalReviewPolicy(9)).requireReviewBeforeAiSend).toBe(true);
    await saveProposalReviewPolicy(9,{requireReviewBeforeAiSend:false});
    expect((await getProposalReviewPolicy(9)).requireReviewBeforeAiSend).toBe(false);
    expect((await getProposalReviewPolicy(10)).requireReviewBeforeAiSend).toBe(true);
  });

  async function automaticFixture() {
    await saveProposalReviewPolicy(9,{requireReviewBeforeAiSend:false});
    await pool.query("UPDATE proposals SET discount_value=0,metadata='{\"automaticSendEligible\":true}'::jsonb WHERE id=1");
    await pool.query('UPDATE proposal_line_items SET unit_price=100 WHERE proposal_id=1');
    await pool.query("INSERT INTO proposal_templates(user_id,name,is_default,terms_and_conditions) VALUES(9,'QA approved terms',true,'Payment due on acceptance.')");
  }

  it('authorizes a complete automatic offer without claiming a human reviewed it', async () => {
    await automaticFixture();
    const result=await reviewProposalForDelivery(9,1,reviewInput,'automatic');
    expect(result.approved).toBe(true);
    expect(result.metadata).toMatchObject({authorizationMode:'automatic',automaticSendEligible:true});
    expect(result.metadata).not.toHaveProperty('sellerReviewedAt');
  });

  it.each(['review enabled','draft only','price changed','terms changed','inactive catalog','wrong tenant'])('blocks automatic authorization when %s', async reason => {
    await automaticFixture();
    if(reason==='review enabled')await saveProposalReviewPolicy(9,{requireReviewBeforeAiSend:true});
    if(reason==='draft only')await pool.query("UPDATE proposals SET metadata='{}'::jsonb WHERE id=1");
    if(reason==='price changed')await pool.query('UPDATE proposal_catalog SET unit_price=120 WHERE id=501');
    if(reason==='terms changed')await pool.query("UPDATE proposal_templates SET terms_and_conditions='New terms' WHERE user_id=9");
    if(reason==='inactive catalog')await pool.query('UPDATE proposal_catalog SET active=false WHERE id=501');
    if(reason==='wrong tenant') { await expect(assertAutomaticProposalCommercials(10,(await loadProposal(9,1))!)).rejects.toThrow(); return; }
    await expect(reviewProposalForDelivery(9,1,reviewInput,'automatic')).rejects.toThrow();
    expect((await loadProposal(9,1))!.metadata.approvedAt).toBeUndefined();
  });

  it('rejects foreign, inactive, and stale review decisions and invalidates approval after an edit', async () => {
    await configurePolicy();
    await reviewProposalForDelivery(9, 1, reviewInput);
    const requests = await listProposalApprovals(9, 1) as Array<{ id: number; reviewerMemberId: number; fingerprint: string }>;
    const manager = requests.find(request => request.reviewerMemberId === 101)!;
    await expect(decideProposalApproval(9, 102, manager.id, { decision: 'approved', comment: '', fingerprint: manager.fingerprint })).rejects.toMatchObject({ statusCode: 404 });
    await expect(decideProposalApproval(10, 101, manager.id, { decision: 'approved', comment: '', fingerprint: manager.fingerprint })).rejects.toMatchObject({ statusCode: 404 });
    await pool.query('UPDATE team_members SET is_active=false WHERE id=101');
    await expect(decideProposalApproval(9, 101, manager.id, { decision: 'approved', comment: '', fingerprint: manager.fingerprint })).rejects.toMatchObject({ statusCode: 404 });
    await pool.query('UPDATE team_members SET is_active=true WHERE id=101');

    for (const request of requests) {
      await decideProposalApproval(9, request.reviewerMemberId, request.id, { decision: 'approved', comment: '', fingerprint: request.fingerprint });
    }
    await pool.query('UPDATE support_teams SET is_active=false WHERE id=41');
    await expect(assertTeamProposalApprovals(9, (await loadProposal(9, 1))!)).rejects.toThrow('still pending');
    await pool.query('UPDATE support_teams SET is_active=true WHERE id=41');
    await expect(assertTeamProposalApprovals(9, (await loadProposal(9, 1))!)).resolves.toBeUndefined();
    await pool.query("UPDATE proposals SET title='Edited implementation offer',revision=revision+1 WHERE id=1");
    const edited = (await loadProposal(9, 1))!;
    await expect(assertTeamProposalApprovals(9, edited)).rejects.toThrow('still pending');
    await expect(decideProposalApproval(9, 101, manager.id, { decision: 'approved', comment: '', fingerprint: manager.fingerprint })).rejects.toThrow('older proposal version');
  });
});
