import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { authenticateToken } from '../middleware/auth.js';
import { requireAnyModuleAccess } from '../middleware/platformAccess.js';
import { db } from '../models/db.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';
import { currentBillingScope } from '../tenancy/billingContext.js';
import { getEffectiveModuleAccess } from '../models/platformAccess/functions.js';
import { requireBillingRole } from '../services/billing/organizations.js';
import { getRedisConnection } from '../infrastructure/redis.js';
import { getWorkspaceInsights, getInsightsDetails, parseInsightsQuery } from '../services/insights/QueryService.js';
import { getInsightsRuntime } from '../services/insights/RuntimeService.js';
import { insightsCacheKey } from '../services/insights/CacheKey.js';
import type { InsightDetailKind } from '../../shared/insights.js';
import { logger } from '../utils/logger.js';

export const insightsRoutes = Router();
insightsRoutes.use(authenticateToken, requireAnyModuleAccess(['billing','outreach','support','crm']));

async function scopedQuery(raw: Record<string, unknown>) {
  const scope=requireBusinessScope();
  const row=(await db.execute(sql`SELECT timezone FROM company_settings WHERE id=${scope.businessProfileId} AND user_id=${scope.userId}`)).rows[0];
  const timezone=typeof row?.timezone==='string' && row.timezone ? row.timezone : 'Asia/Kolkata';
  return parseInsightsQuery(raw,timezone);
}
insightsRoutes.get('/', async (req,res) => {
  try {
    if(!(await getInsightsRuntime()).enabled) return res.status(503).json({code:'INSIGHTS_ROLLOUT_PENDING',error:'Insights is awaiting pricing and ledger validation.'});
    const scope=requireBusinessScope(); const q=await scopedQuery(req.query);
    const access=await getEffectiveModuleAccess(scope.userId);
    const org=currentBillingScope()?.organizationId;
    const billingAllowed=Boolean(org && access.some(module=>module.key==='billing'&&module.enabled)
      && await requireBillingRole(scope.actorUserId||scope.userId,org).then(()=>true,()=>false));
    const permissions=access.filter(module=>module.enabled).map(module=>module.key);
    const key=insightsCacheKey(scope,org,billingAllowed,permissions,q);
    const refresh=req.query.refresh==='1';
    if (!refresh) {
      try {
        const cached=await getRedisConnection().get(key);
        if(cached) return res.json(JSON.parse(cached));
      } catch {
        logger.warn('[Insights] Cache read unavailable; computing fresh results.');
      }
    }
    const result=await getWorkspaceInsights(q);
    try {
      await getRedisConnection().set(key,JSON.stringify(result),'EX',60);
    } catch {
      logger.warn('[Insights] Cache write unavailable; returning computed results.');
    }
    return res.json(result);
  } catch(error) {
    if(error instanceof Error && error.message.startsWith('Choose a valid date range')) return res.status(400).json({error:error.message});
    logger.error({ err: error }, '[Insights] Summary request failed');
    return res.status(500).json({error:'Unable to load Insights.'});
  }
});
insightsRoutes.get('/details',async(req,res)=>{
  try {
    if(!(await getInsightsRuntime()).enabled) return res.status(503).json({code:'INSIGHTS_ROLLOUT_PENDING',error:'Insights is awaiting pricing and ledger validation.'});
    const q=await scopedQuery(req.query);
    const kind=String(req.query.kind||'usage') as InsightDetailKind;
    if(!['usage','charges','tools','sales','conversations'].includes(kind)) return res.status(400).json({error:'Invalid detail kind.'});
    // Versioned conversation cursors combine the source's serial ID and a
    // source bit; reject old row-number cursors rather than misreading them.
    const conversationCursorEnd=4294967296;
    const rawCursor=req.query.cursor;
    const cursor=rawCursor===undefined?(kind==='conversations'?conversationCursorEnd:2147483647)
      :kind==='conversations'
        ?typeof rawCursor==='string'&&/^c1:\d{1,10}$/.test(rawCursor)?Number(rawCursor.slice(3)):NaN
        :Number(rawCursor);
    const limit=req.query.limit===undefined?30:Number(req.query.limit);
    if(!Number.isSafeInteger(cursor)||cursor<1||!Number.isSafeInteger(limit)||limit<1||limit>100) return res.status(400).json({error:'Invalid cursor or limit.'});
    if(cursor>(kind==='conversations'?conversationCursorEnd:2147483647)) return res.status(400).json({error:'Invalid cursor or limit.'});
    return res.json(await getInsightsDetails(q,kind,cursor,limit));
  }catch(error){
    if(error instanceof Error && error.message.startsWith('Choose a valid date range')) return res.status(400).json({error:error.message});
    if((error as {status?:number}).status===403) return res.status(403).json({error:'Billing permission required.'});
    logger.error({ err: error }, '[Insights] Details request failed');
    return res.status(500).json({error:'Unable to load Insight details.'});
  }
});
