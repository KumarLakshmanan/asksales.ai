import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/express.js';
import { discoverPaidAdAccounts, listPaidAdAccounts, ownedPaidAdAccount } from '../services/ads/PaidAdAccountsService.js';
import { syncPaidAdAccount } from '../services/PerformanceProviderSyncService.js';
import { googleAdsCampaignDiagnostics, managedGoogleAdsCampaignDiagnostics } from '../services/ads/GoogleAdsInventoryService.js';
import { managedMetaAdsCampaignDiagnostics, metaAdsCampaignDiagnostics } from '../services/ads/MetaAdsDiagnosticsService.js';

export async function getPaidAdAccounts(req:AuthenticatedRequest,res:Response) {
  if(!businessOwnerUserId(req)) return res.status(401).json({error:'Unauthorized'});
  try { return res.json({accounts:await listPaidAdAccounts(businessOwnerUserId(req))}); }
  catch { return res.status(503).json({error:'Connected ad accounts could not be loaded.'}); }
}
export async function discoverAccounts(req:AuthenticatedRequest,res:Response) {
  if(!businessOwnerUserId(req)) return res.status(401).json({error:'Unauthorized'});
  try { return res.json(await discoverPaidAdAccounts(businessOwnerUserId(req),req.body.platform)); }
  catch { return res.status(400).json({error:'Account discovery failed. Authorize the provider and check Ads permissions before retrying.'}); }
}
export async function refreshAccount(req:AuthenticatedRequest,res:Response) {
  if(!businessOwnerUserId(req)) return res.status(401).json({error:'Unauthorized'});
  const id=Number(req.params.id);
  try { await ownedPaidAdAccount(businessOwnerUserId(req),id); }
  catch { return res.status(404).json({error:'Ad account not found.'}); }
  try {
    const result=await syncPaidAdAccount(businessOwnerUserId(req),id,true);
    return result ? res.status(result.status).json(result.body) : res.status(202).json({status:'running',message:'This account is already synchronizing.'});
  } catch { return res.status(503).json({error:'Account refresh failed. Try again shortly.'}); }
}
export async function getProviderGoogleDiagnostics(req:AuthenticatedRequest,res:Response) {
  if(!businessOwnerUserId(req)) return res.status(401).json({error:'Unauthorized'});
  try { return res.json(await googleAdsCampaignDiagnostics(businessOwnerUserId(req),Number(req.params.id),String(req.params.campaignId))); }
  catch(error) { const message=error instanceof Error?error.message:'Google diagnostics unavailable.'; return res.status(message.includes('not found')?404:400).json({error:message}); }
}
export async function getManagedGoogleDiagnostics(req:AuthenticatedRequest,res:Response) {
  if(!businessOwnerUserId(req)) return res.status(401).json({error:'Unauthorized'});
  try { return res.json(await managedGoogleAdsCampaignDiagnostics(businessOwnerUserId(req),Number(req.params.id))); }
  catch(error) { const message=error instanceof Error?error.message:'Google diagnostics unavailable.'; return res.status(message.includes('not found')?404:400).json({error:message}); }
}
export async function getProviderMetaDiagnostics(req:AuthenticatedRequest,res:Response) {
  if(!businessOwnerUserId(req)) return res.status(401).json({error:'Unauthorized'});
  try { return res.json(await metaAdsCampaignDiagnostics(businessOwnerUserId(req),Number(req.params.id),String(req.params.campaignId),String(req.query.period || '30d'))); }
  catch(error) { const message=error instanceof Error?error.message:'Meta diagnostics unavailable.'; return res.status(message.includes('not found')?404:400).json({error:message}); }
}
export async function getManagedMetaDiagnostics(req:AuthenticatedRequest,res:Response) {
  if(!businessOwnerUserId(req)) return res.status(401).json({error:'Unauthorized'});
  try { return res.json(await managedMetaAdsCampaignDiagnostics(businessOwnerUserId(req),Number(req.params.id),String(req.query.period || '30d'))); }
  catch(error) { const message=error instanceof Error?error.message:'Meta diagnostics unavailable.'; return res.status(message.includes('not found')?404:400).json({error:message}); }
}
