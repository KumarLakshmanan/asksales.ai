import type {Request,Response} from 'express';
import {ZodError} from 'zod';
import {getPreparedOutreach,prepareOutreach,preparedOutreachSchema} from '../services/outreach/PreparedOutreachService.js';
import {DashboardOperationError} from '../services/operations/DashboardOperations.js';
import {operationIdSchema} from '../services/operations/ContactAnalysisValidation.js';
import {BillingOrganizationError} from '../services/billing/organizations.js';
import {BusinessLifecycleError} from '../tenancy/businessLifecycle.js';
import {logger} from '../utils/logger.js';
export async function preparedOutreach(req:Request,res:Response) {
  res.setHeader('Cache-Control','private, no-store');
  try {
    if(req.method==='POST')return res.status(201).json(await prepareOutreach(preparedOutreachSchema.parse(req.body)));
    return res.json(await getPreparedOutreach(operationIdSchema.parse(req.params.id)));
  } catch(error) {
    if(error instanceof ZodError)return res.status(400).json({error:'Check the audience, account, message and follow-up settings.',issues:error.issues});
    if(error instanceof DashboardOperationError || error instanceof BillingOrganizationError || error instanceof BusinessLifecycleError)return res.status(error.status).json({error:error.message});
    logger.error({err:error},'[PreparedOutreach] Preparation unavailable');return res.status(503).json({error:'This outreach could not be prepared. Review its settings and try again.'});
  }
}
