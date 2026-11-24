import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type {Request,Response} from 'express';
import {z} from 'zod';
import {sendProposalSchema} from '../middleware/schemas.js';
import {proposalDeliveryService,ProposalDeliveryError} from '../services/ProposalDeliveryService.js';
import {getProposalReviewPolicy,getProposalReviewers,saveProposalReviewPolicy,reviewProposalForDelivery,listProposalApprovals,decideProposalApproval,ProposalApprovalError} from '../services/ProposalApprovalService.js';
import {getEffectiveModuleAccess} from '../models/platformAccess/functions.js';
import {logger} from '../utils/logger.js';

const positive=z.coerce.number().int().positive();
const prepareSchema=sendProposalSchema.omit({idempotencyKey:true}).extend({expectedRevision:z.number().int().positive().optional()});
const reviewSchema=prepareSchema.extend({expectedRevision:z.number().int().positive(),expectedTargetFingerprint:z.string().regex(/^[a-f0-9]{64}$/),expectedReviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/)});
function handleError(res:Response,error:unknown) {
  if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid proposal delivery request',issues:error.issues});
  if(error instanceof ProposalDeliveryError || error instanceof ProposalApprovalError)return res.status(error.statusCode).json({error:error.message,...(error instanceof ProposalDeliveryError ? {code:error.code,issues:error.issues} : {})});
  logger.error({err:error},'Proposal delivery workspace request failed');return res.status(500).json({error:'Unable to complete proposal delivery request'});
}
function owner(fn:(req:Request,userId:number)=>Promise<unknown>) {return async(req:Request,res:Response)=>{if(!businessOwnerUserId(req))return res.status(401).json({error:'Unauthorized'});try{return res.json({success:true,data:await fn(req,businessOwnerUserId(req))});}catch(error){return handleError(res,error);}};}
export const prepareProposalDelivery=owner((req,userId)=>proposalDeliveryService.prepare(userId,positive.parse(req.params.id),prepareSchema.parse(req.body)));
export const approveProposalDelivery=owner((req,userId)=>reviewProposalForDelivery(userId,positive.parse(req.params.id),reviewSchema.parse(req.body)));
export const deliverProposal=owner((req,userId)=>proposalDeliveryService.send(userId,positive.parse(req.params.id),sendProposalSchema.parse(req.body)));
export const proposalApprovalPolicy=owner(async(_req,userId)=>({policy:await getProposalReviewPolicy(userId),reviewers:await getProposalReviewers(userId)}));
export const saveProposalApprovalPolicy=owner((req,userId)=>saveProposalReviewPolicy(userId,req.body));
export const proposalApprovalRequests=owner((req,userId)=>listProposalApprovals(userId,positive.parse(req.params.id)));

type MemberRequest=Request & {supportMember?:{id:number;userId:number}};
function member(fn:(req:MemberRequest,userId:number,memberId:number)=>Promise<unknown>) {return async(req:MemberRequest,res:Response)=>{
  if(!req.supportMember)return res.status(401).json({error:'Unauthorized'});
  try{const access=(await getEffectiveModuleAccess(req.supportMember.userId)).find(module=>module.key==='proposals');if(!access?.enabled)return res.status(403).json({error:'Proposals are unavailable for this workspace.'});return res.json({success:true,data:await fn(req,req.supportMember.userId,req.supportMember.id)});}catch(error){return handleError(res,error);}
};}
export const memberProposalReviews=member((_req,userId,memberId)=>listProposalApprovals(userId,undefined,memberId));
export const decideMemberProposalReview=member((req,userId,memberId)=>decideProposalApproval(userId,memberId,positive.parse(req.params.id),req.body));
