import {randomUUID} from 'node:crypto';
import type {Request,Response} from 'express';
import {ZodError} from 'zod';
import {businessOwnerUserId} from '../tenancy/businessContext.js';
import {ContactAnalysisError} from '../services/contacts/ContactWorkbookAnalysis.js';
import {contactAnalysisOptionsSchema,operationIdSchema,operationRequestKeySchema,analysisPageSchema} from '../services/operations/ContactAnalysisValidation.js';
import {DashboardOperationError,createContactAnalysis,createContactImport,analysisRows,dashboardOperationStatus,listDashboardOperations,resumeDashboardOperation,reviseContactAnalysis} from '../services/operations/DashboardOperations.js';
import {logger} from '../utils/logger.js';
import {BillingOrganizationError} from '../services/billing/organizations.js';
import {BusinessLifecycleError} from '../tenancy/businessLifecycle.js';
import {normalizeCapacityError} from '../services/billing/entitlements.js';
import {analyzeStoredContactWorkbooks,storedContactAnalysisSchema,listStoredContactWorkbooks,storedWorkbookListSchema} from '../services/operations/StoredContactWorkbooks.js';

export async function contactAnalysisOperation(req:Request,res:Response) {
  const userId=businessOwnerUserId(req);
  if(!req.user?.id || !userId) return res.status(401).json({error:'Authentication required.'});
  res.setHeader('Cache-Control','private, no-store');
  try {
    if(req.path.endsWith('/stored-files') && req.method==='GET')return res.json(await listStoredContactWorkbooks(storedWorkbookListSchema.parse({
      ...req.query,...(req.query.beforeId ? {beforeId:Number(req.query.beforeId)} : {}),
    })));
    if(req.path.endsWith('/from-files') && req.method==='POST')return res.status(202).json(await analyzeStoredContactWorkbooks(storedContactAnalysisSchema.parse(req.body)));
    if(req.method==='GET' && !req.params.operationId) return res.json({items:await listDashboardOperations(['contact_analysis','contact_import'])});
    if(req.method==='POST' && !req.params.operationId) {
      let input:unknown={};
      try {input=req.body.options ? JSON.parse(req.body.options) : {};} catch {throw new DashboardOperationError('Analysis options must be valid JSON.');}
      const options=contactAnalysisOptionsSchema.parse(input),key=operationRequestKeySchema.parse(req.body.requestKey || req.get('Idempotency-Key') || randomUUID());
      const files=(req.files as Express.Multer.File[]|undefined) || [];
      const result=await createContactAnalysis(files.map(file=>({name:file.originalname,buffer:file.buffer})),options,key);
      return res.status(202).json(result);
    }
    const id=operationIdSchema.parse(req.params.operationId);
    if(req.method==='POST' && req.path.endsWith('/reanalyze')) return res.status(202).json(await reviseContactAnalysis(id,
      contactAnalysisOptionsSchema.parse(req.body.options),operationRequestKeySchema.parse(req.body.requestKey || randomUUID())));
    if(req.method==='GET' && req.path.endsWith('/rows')) return res.json(await analysisRows(id,analysisPageSchema.parse(req.query)));
    if(req.method==='POST' && req.path.endsWith('/import')) {
      const key=operationRequestKeySchema.parse(req.body.requestKey || req.get('Idempotency-Key') || randomUUID());
      return res.status(202).json(await createContactImport(id,key));
    }
    if(req.method==='POST' && req.path.endsWith('/resume')) return res.status(202).json(await resumeDashboardOperation(id,['contact_analysis','contact_import']));
    return res.json(await dashboardOperationStatus(id,['contact_analysis','contact_import']));
  } catch(error) {
    const capacity=normalizeCapacityError(error);if(capacity)return res.status(capacity.status).json(capacity.toJSON());
    if(error instanceof ZodError) return res.status(400).json({error:'Check the operation inputs.',issues:error.issues});
    if(error instanceof DashboardOperationError || error instanceof ContactAnalysisError) return res.status(error.status).json({error:error.message});
    if(error instanceof BillingOrganizationError || error instanceof BusinessLifecycleError) return res.status(error.status).json({error:error.message});
    logger.error({err:error},'[ContactAnalysis] Operation unavailable');
    return res.status(503).json({error:'This contact operation could not be loaded. Try again.'});
  }
}
