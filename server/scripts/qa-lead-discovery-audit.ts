/** Local-only browser backend: real HTTP/auth/RLS/credits, synthetic provider IO. */
import express from 'express';
import { Pool } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

if (process.env.LEAD_DISCOVERY_LOCAL_QA !== '1' || process.env.NODE_ENV !== 'development'
  || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55432'
  || process.env.DB_NAME !== 'lead_audit' || process.env.REDIS_HOST !== '127.0.0.1'
  || process.env.REDIS_PORT !== '56379') throw new Error('Use only disposable lead-audit containers');

const objects = '/tmp/lead-discovery-object-fixture';
await mkdir(objects, { recursive: true });
const { ApifyService } = await import('../services/agents/ApifyService.js');
const { WebsiteCrawlerService } = await import('../services/WebsiteCrawlerService.js');
const { LLMProviderFactory } = await import('../services/agents/LLMProviderFactory.js');
let sequence = 0;
ApifyService.createWithAdminCredentials = async () => ({
  runActor: async (input: { input: unknown }) => {
    await new Promise(resolve => setTimeout(resolve, 200));
    const runId = `synthetic-run-${++sequence}`;
    const failed = JSON.stringify(input.input).includes('synthetic_failure');
    const result = { success: !failed, items: [], runId, datasetId: `synthetic-dataset-${sequence}`, ...(failed ? { error: 'Synthetic provider unavailable' } : {}) };
    await writeFile(`${objects}/${runId}.json`, JSON.stringify({ input, result }, null, 2));
    return result;
  },
} as unknown as InstanceType<typeof ApifyService>);
WebsiteCrawlerService.prototype.crawl = async (url: string) => {
  await writeFile(`${objects}/crawl-${++sequence}.json`, JSON.stringify({ url, pages: [], synthetic: true }));
  return { pages: [], combinedContent: '', discoveredLinks: [] };
};
LLMProviderFactory.createProviderForUser = async () => { throw new Error('Synthetic browser backend has no LLM'); };

const { db, pgPool } = await import('../models/db.js');
const { sql } = await import('drizzle-orm');
const { withBusinessScope } = await import('../tenancy/businessContext.js');
const { authenticateToken } = await import('../middleware/auth.js');
const { generateToken } = await import('../utils/jwt.js');
const { default: enrichmentRouter } = await import('../routes/enrichments.routes.js');
const { getLeads } = await import('../controllers/leadController.js');
const { getEffectiveModuleAccess, getMaintenanceSettings } = await import('../models/platformAccess/functions.js');
const { getBalance } = await import('../models/wallets/functions.js');
const { closeRedisConnections } = await import('../infrastructure/redis.js');
const { SmartThrottlingService } = await import('../services/SmartThrottlingService.js');
const { createEnrichmentRun, updateEnrichmentRun } = await import('../models/enrichmentRuns/functions.js');

const admin = new Pool({ host: '127.0.0.1', port: 55432, database: 'lead_audit', user: 'lead_audit', password: 'disposable_fixture', max: 1 });
let fixturePriceId: number | undefined;
if (process.env.LEAD_AUDIT_BROWSER_PRICING === '1') {
  fixturePriceId = (await admin.query("INSERT INTO credit_pricing(event_key,name,category,credits_per_unit,is_active) VALUES('lead_enrichment','Synthetic browser fee','lead',5,true) RETURNING id")).rows[0].id;
}
const suffix = randomUUID();
const user = (await admin.query("INSERT INTO users(email,password,name,is_approved,is_setup_complete) VALUES($1,'synthetic','Browser discovery audit',true,true) RETURNING id", [`browser-discovery-${suffix}@example.invalid`])).rows[0];
const profile = (await admin.query("INSERT INTO company_settings(user_id,name,company_name,is_default) VALUES($1,'Browser discovery audit','Synthetic discovery company',true) RETURNING id,billing_organization_id", [user.id])).rows[0];
await admin.query('INSERT INTO wallets(user_id,organization_id,balance) VALUES($1,$2,1000) ON CONFLICT(organization_id) DO UPDATE SET balance=1000', [user.id, profile.billing_organization_id]);
const token = generateToken({ userId: user.id, email: `browser-discovery-${suffix}@example.invalid` });
await withBusinessScope({ userId: user.id, businessProfileId: profile.id }, async () => {
  await db.execute(sql`INSERT INTO leads(uuid,user_id,name,source,status,lead_status,email) VALUES(${randomUUID()},${user.id},'Synthetic discovery subject','manual_enrichment','new','new','subject@example.invalid')`);
  const run = await createEnrichmentRun({ userId: user.id, leadName: 'Synthetic saved discovery' });
  await updateEnrichmentRun(run.id, { status: 'completed', completedAt: new Date(), summary: { identityScoped: true, emails: [], phones: [], websites: [], person: {}, company: {}, socialProfiles: {} } });
});

const app = express();
app.use(express.json());
app.get('/api/auth/me', authenticateToken, (_req, res) => res.json({ user: {
  id: user.id, name: 'Browser discovery audit', email: 'synthetic-browser@example.invalid',
  isApproved: true, isSetupComplete: true, hasBusinessProfile: true, hasBrandToolkit: true,
} }));
app.get('/api/platform/access', authenticateToken, async (_req, res) => res.json({ maintenance: await getMaintenanceSettings(), modules: await getEffectiveModuleAccess(user.id) }));
app.get('/api/settings/business-profiles', authenticateToken, (_req, res) => res.json([{ id: profile.id, name: 'Browser discovery audit', companyName: 'Synthetic discovery company', isDefault: true, role: 'owner' }]));
app.get('/api/wallet', authenticateToken, async (_req, res) => res.json({ balance: await getBalance(user.id) }));
app.get('/api/leads', authenticateToken, getLeads);
app.use('/api/enrichments', enrichmentRouter);
app.use((_req, res) => res.status(404).json({ error: 'Not exposed by the synthetic discovery backend' }));
const server = app.listen(58080, '127.0.0.1');
await writeFile('/tmp/lead-discovery-browser-fixture.json', JSON.stringify({ userId: user.id, businessProfileId: profile.id, token }));
console.log('Synthetic discovery backend listening on 127.0.0.1:58080');
async function close() {
  server.close();
  SmartThrottlingService.getInstance().destroy();
  await closeRedisConnections();
  await pgPool?.end();
  if (fixturePriceId) await admin.query('DELETE FROM credit_pricing WHERE id=$1', [fixturePriceId]);
  await admin.end();
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
