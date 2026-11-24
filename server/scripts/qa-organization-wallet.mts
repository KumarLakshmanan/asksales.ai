/** Run only against a disposable, migrated local database. No provider calls. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (!['localhost', '127.0.0.1'].includes(process.env.DB_HOST || '') ||
    !/^salesmarketing_org_billing_qa_/.test(process.env.DB_NAME || '')) {
  throw new Error('Use a disposable local salesmarketing_org_billing_qa_* database.');
}
const { db, pgPool } = await import('../models/db.js');
const { sql } = await import('drizzle-orm');
const { withSystemScope, withBusinessScope } = await import('../tenancy/businessContext.js');
const { withBillingScope } = await import('../tenancy/billingContext.js');
const { creditService } = await import('../services/CreditService.js');
const { getBalance } = await import('../models/wallets/functions.js');
const { getTransactionsByUserId } = await import('../models/walletTransactions/functions.js');
const { getBillingOrganization, assignBillingResources } = await import('../services/billing/organizations.js');
const { catalogInput, getCatalog, createCatalogDraft, saveCatalogDraft, publishCatalog, retireCatalog } = await import('../services/subscriptions/catalog.js');
const { RazorpaySubscriptionGateway } = await import('../services/subscriptions/gateway.js');
const { closeRedisConnections } = await import('../infrastructure/redis.js');

try {
  const prefix = `wallet-qa-${randomUUID()}`;
  const fixture = await withSystemScope('Create disposable organization wallet QA fixtures', async () => {
    const users = (await db.execute(sql`INSERT INTO users(name,email,password,is_verified,is_approved,is_setup_complete)
      VALUES('Wallet QA owner',${`${prefix}-owner@example.test`},'disabled-qa-login',true,true,true),
        ('Wallet QA member',${`${prefix}-member@example.test`},'disabled-qa-login',true,true,true)
      RETURNING id,email`)).rows;
    const owner = Number(users[0].id); const member = Number(users[1].id);
    const orgs = (await db.execute(sql`SELECT id,default_for_user_id FROM billing_organizations
      WHERE default_for_user_id IN (${owner},${member})`)).rows;
    const organization = Number(orgs.find((o: { default_for_user_id: number }) => o.default_for_user_id === owner).id);
    const destination = Number(orgs.find((o: { default_for_user_id: number }) => o.default_for_user_id === member).id);
    await db.execute(sql`INSERT INTO billing_organization_memberships(organization_id,user_id,email,role,status)
      VALUES(${organization},${member},${users[1].email},'member','active')`);
    const profiles = (await db.execute(sql`INSERT INTO company_settings(user_id,name,billing_organization_id)
      VALUES(${owner},'QA owner business',${organization}),(${member},'QA member business',${organization}) RETURNING id`)).rows;
    return { owner, member, organization, destination, ownerProfile: Number(profiles[0].id), memberProfile: Number(profiles[1].id) };
  });
  const { owner, member, organization, destination, ownerProfile, memberProfile } = fixture;
  const ownerScope = <T,>(fn: () => T) => withBusinessScope({ userId: owner, businessProfileId: ownerProfile }, fn);
  const memberScope = <T,>(fn: () => T) => withBusinessScope({ userId: member, businessProfileId: memberProfile }, fn);
  const balance = (org: number) => withBillingScope({ organizationId: org, actorUserId: member }, () => getBalance(member));

  await ownerScope(() => creditService.addBonusCredits(owner, 100, 'QA balance'));
  await withBillingScope({ organizationId: destination, actorUserId: member }, () => creditService.addBonusCredits(member, 50, 'QA destination balance'));
  assert.equal(await memberScope(() => getBalance(member)), 100, 'Members of separate businesses use the same organization wallet');
  const charge = (userId: number, amount: number) => creditService.deductForEvent({ userId, eventKey: 'organization_qa', overrideAmount: amount,
    service: 'OrganizationWalletQA', description: 'Private business operation', metadata: { inputSnapshot: 'PRIVATE-QA-CONTENT' } });
  const original = await ownerScope(() => charge(owner, 25));
  assert.equal(original.success, true);
  const other = await memberScope(() => charge(member, 10));
  assert.equal(other.success, true);
  assert.equal(await balance(organization), 65);
  const history = await withBillingScope({ organizationId: organization, actorUserId: member }, () => getTransactionsByUserId(member));
  const privateEntry = history.transactions.find(row => row.id === original.transactionId);
  assert.equal(privateEntry?.metadata, null, 'Shared billing never exposes another business owner’s operation payload');
  assert.notEqual(privateEntry?.description, 'Private business operation');

  await assignBillingResources(member, destination, 'business', memberProfile);
  assert.equal(await memberScope(() => getBalance(member)), 50, 'Moving a business changes future payment responsibility');
  const refunds = await memberScope(() => Promise.all([
    creditService.refundDeduction({ userId: member, transactionId: other.transactionId!, description: 'QA failed operation' }),
    creditService.settleReservation({ userId: member, transactionId: other.transactionId!, actualCredits: 0, description: 'QA repeated settlement' }),
  ]));
  assert.equal(refunds.every(result => result.success), true);
  assert.equal(await balance(organization), 75, 'Concurrent refund paths credit the original organization only once');
  assert.equal(await balance(destination), 50, 'Refunds never credit the destination organization');
  await assert.rejects(() => memberScope(() => creditService.settleReservation({ userId: member, transactionId: other.transactionId!, actualCredits: -10, description: 'Invalid' })));

  const concurrent = await ownerScope(() => Promise.all(Array.from({ length: 5 }, () => charge(owner, 20))));
  assert.equal(concurrent.filter(result => result.success).length, 3, 'Concurrent charges cannot overdraw the shared wallet');
  assert.equal(await balance(organization), 15);
  await assert.rejects(() => withBillingScope({ organizationId: destination, actorUserId: owner }, () => getBillingOrganization(owner)), /not available/);

  const draft = await getCatalog(2);
  assert.equal(catalogInput.safeParse({ plans: draft.plans }).success, true, 'Catalog responses can be saved and published without losing version fields');
  assert.equal(catalogInput.safeParse({ plans: draft.plans.map((plan, i) => i === 1 ? { ...plan, finderMinScore: 8 } : plan) }).success, false);
  console.log('Organization wallet integration: shared balances, redaction, resource transfer, original-wallet refund, duplicate settlement, concurrent charges, selector isolation and catalog validation passed.');

  // Exercise the same draft/save/provision/publish transaction as the admin UI.
  // The provider is deliberately in-memory; this script never creates mandates.
  let plansCreated = 0;
  class QaGateway extends RazorpaySubscriptionGateway {
    override async findExistingPlan() { return null; }
    override async createPlan() { return { id: `plan_orgqa_${randomUUID()}` }; }
  }
  const provider = async (id: number) => {
    const gateway = new QaGateway(id, 'rzp_test_orgqa', 'unused-test-secret', 'unused-test-webhook-secret');
    const create = gateway.createPlan.bind(gateway);
    gateway.createPlan = async () => { plansCreated++; return create(); };
    return gateway;
  };
  await withSystemScope('Exercise catalog publication in disposable QA database', async () => {
    const adminId = Number((await db.execute(sql`SELECT id FROM admins ORDER BY id LIMIT 1`)).rows[0]?.id);
    assert.ok(adminId, 'QA database needs a migrated administrator');
    const workingDraft = await createCatalogDraft(adminId);
    const approvedPlans = draft.plans.map(plan => ({ ...plan, version: workingDraft.version }));
    await saveCatalogDraft(adminId, workingDraft.version, { plans: approvedPlans });
    await assert.rejects(() => saveCatalogDraft(adminId, workingDraft.version, { plans: draft.plans }), /version changed/);
    await publishCatalog(adminId, workingDraft.version, db, provider);
    assert.equal(plansCreated, 6, 'All three plans have monthly and yearly provider plans before publication');
    assert.equal((await getCatalog()).version, workingDraft.version);
    await assert.rejects(() => saveCatalogDraft(adminId, workingDraft.version, { plans: approvedPlans }), /Create a draft/);
    await assert.rejects(() => retireCatalog(adminId, workingDraft.version), /replacement/);
  });
  console.log('Catalog integration: draft save, version validation, six provider mappings, immutable publication and retirement guard passed.');
} finally {
  await closeRedisConnections();
  await pgPool?.end();
}
