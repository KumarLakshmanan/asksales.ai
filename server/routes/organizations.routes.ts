import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { BillingOrganizationError, listBillingOrganizations } from '../services/billing/organizations.js';
import { logger } from '../utils/logger.js';

/** Compatibility read for billing clients. A business profile is the only
 * customer workspace; payer rows are retained solely for financial history. */
export const organizationRoutes=Router();
organizationRoutes.use(authenticateToken);
organizationRoutes.get('/',async(req,res)=>{
  try{return res.json(await listBillingOrganizations(Number(req.user!.id)));}
  catch(error){
    if(error instanceof BillingOrganizationError)return res.status(error.status).json({error:error.message,code:error.code});
    logger.error({err:error},'Business billing context unavailable');
    return res.status(503).json({error:'Business billing is temporarily unavailable.'});
  }
});
organizationRoutes.use((_req,res)=>res.status(410).json({
  code:'BUSINESS_PROFILE_IS_WORKSPACE',error:'Manage your business profile and its staff in Business settings.',
}));
export default organizationRoutes;
