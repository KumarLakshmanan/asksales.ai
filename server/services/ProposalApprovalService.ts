import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { proposalApprovalFingerprint } from './ProposalWorkspaceService.js';
import { proposalDeliveryService, ProposalDeliveryError, type ProposalDeliveryInput } from './ProposalDeliveryService.js';
import { calculateProposalPricing, type ProposalDocument } from '../../shared/proposals.js';

export const proposalReviewPolicySchema = z.object({
  requireReviewBeforeAiSend: z.boolean().default(true),
  enabled: z.boolean().default(false),
  discountThresholdPct: z.number().min(0).max(100).default(10),
  amountThreshold: z.number().finite().positive().nullable().default(null),
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  reviewManualPricing: z.boolean().default(true),
  reviewerMemberIds: z.array(z.number().int().positive()).max(20).default([]),
}).strict().superRefine((value, context) => {
  if (value.enabled && !value.reviewerMemberIds.length) context.addIssue({ code:'custom',path:['reviewerMemberIds'],message:'Assign at least one active reviewer.' });
  if (new Set(value.reviewerMemberIds).size !== value.reviewerMemberIds.length) context.addIssue({code:'custom',path:['reviewerMemberIds'],message:'Reviewers must be unique.'});
});
export type ProposalReviewPolicy = z.infer<typeof proposalReviewPolicySchema>;
const defaults = {requireReviewBeforeAiSend:true,enabled:false,discountThresholdPct:10,amountThreshold:null,currency:'USD',reviewManualPricing:true,reviewerMemberIds:[]} satisfies ProposalReviewPolicy;
export class ProposalApprovalError extends Error { constructor(message: string, public statusCode=409) {super(message);} }
type Proposal = ProposalDocument & { id: number };
type ProposalReviewer = { id: number; name: string; email: string; role: string; teamName: string };

export async function getProposalReviewPolicy(userId: number, database= db): Promise<ProposalReviewPolicy> {
  const result=await database.execute(sql`SELECT settings FROM proposal_review_policies WHERE user_id=${userId}`);
  return result.rows[0] ? proposalReviewPolicySchema.parse(result.rows[0].settings) : {...defaults};
}
export async function getProposalReviewers(userId: number) {
  return (await db.execute(sql`SELECT m.id,m.name,m.email,m.role,t.name AS "teamName" FROM team_members m JOIN support_teams t ON t.id=m.team_id AND t.user_id=m.user_id WHERE m.user_id=${userId} AND m.is_active=true AND t.is_active=true ORDER BY m.name,m.id`)).rows as unknown as ProposalReviewer[];
}
export async function saveProposalReviewPolicy(userId: number, input: unknown) {
  const policy=proposalReviewPolicySchema.parse(input);
  const members=await getProposalReviewers(userId);
  if(policy.reviewerMemberIds.some(id=>!members.some(member=>member.id===id)))throw new ProposalApprovalError('Every reviewer must be an active member of this workspace.',400);
  await db.execute(sql`INSERT INTO proposal_review_policies(user_id,settings) VALUES(${userId},${JSON.stringify(policy)}::jsonb) ON CONFLICT(business_profile_id, user_id) DO UPDATE SET settings=excluded.settings,updated_at=NOW()`);
  return policy;
}

export function evaluateProposalReviewRules(proposal: ProposalDocument, policy: ProposalReviewPolicy, catalogPrices: Map<number,number> = new Map()) {
  const reasons: string[]=[];
  if(!policy.enabled)return {required:false,reasons,reviewerMemberIds:[]};
  const pricing=calculateProposalPricing(proposal);
  const selected=pricing.rows.filter(item=>item.included);
  const gross=selected.reduce((sum,item)=>sum+Number(item.quantity ?? 1)*Number(item.unitPrice ?? 0),0);
  const discount=gross-pricing.subtotal+pricing.discount;
  if(gross>0 && discount/gross*100 > policy.discountThresholdPct)reasons.push(`Declared discounts exceed ${policy.discountThresholdPct}%.`);
  if(policy.amountThreshold !== null && (proposal.currency !== policy.currency || pricing.total>=policy.amountThreshold))reasons.push(proposal.currency !== policy.currency ? `The value is in ${proposal.currency}; the approval threshold is set in ${policy.currency}.` : `The offer meets the ${policy.currency} ${policy.amountThreshold} approval threshold.`);
  if(policy.reviewManualPricing && selected.some(item=>!item.catalogId || !catalogPrices.has(item.catalogId) || Number(item.unitPrice)<(catalogPrices.get(item.catalogId) || 0)))reasons.push('The offer includes manual or negotiated catalog pricing.');
  return {required:reasons.length>0,reasons,reviewerMemberIds:reasons.length ? policy.reviewerMemberIds : []};
}
async function approvalRequirement(userId:number,proposal:ProposalDocument,database=db) {
  const policy=await getProposalReviewPolicy(userId,database);
  const catalog=policy.enabled && policy.reviewManualPricing ? await database.execute(sql`SELECT id,unit_price FROM proposal_catalog WHERE user_id=${userId} AND currency=${proposal.currency || 'USD'}`) : {rows:[]};
  return evaluateProposalReviewRules(proposal,policy,new Map(catalog.rows.map((row:{id:number;unit_price:string})=>[row.id,Number(row.unit_price)])));
}
export function proposalReviewSnapshot(proposal:Proposal) {
  const metadata=proposal.metadata || {};
  return {title:proposal.title,proposalNumber:proposal.proposalNumber,recipientName:proposal.recipientName,recipientEmail:proposal.recipientEmail,currency:proposal.currency,coverNote:proposal.coverNote,lineItems:proposal.lineItems,discountType:proposal.discountType,discountValue:proposal.discountValue,taxRate:proposal.taxRate,validUntil:proposal.validUntil,termsAndConditions:proposal.termsAndConditions,showTermsAndConditions:proposal.showTermsAndConditions,metadata:{generatedSections:metadata.generatedSections,commercial:metadata.commercial,deliveryTarget:metadata.deliveryTarget}};
}

type TeamApprovalStatus = 'pending' | 'changes_requested' | 'approved';
async function teamApprovalStatus(userId:number,proposalId:number,fingerprint:string,reviewerMemberIds:number[],database=db):Promise<TeamApprovalStatus> {
  const approvals=await database.execute(sql`SELECT a.reviewer_member_id,a.decision FROM proposal_approvals a JOIN team_members m ON m.id=a.reviewer_member_id AND m.user_id=a.user_id AND m.is_active=true JOIN support_teams t ON t.id=m.team_id AND t.user_id=m.user_id AND t.is_active=true WHERE a.user_id=${userId} AND a.proposal_id=${proposalId} AND a.fingerprint=${fingerprint}`);
  const decisions=new Map(approvals.rows.map((row:{reviewer_member_id:number;decision:string})=>[Number(row.reviewer_member_id),row.decision]));
  if(reviewerMemberIds.every(id=>decisions.get(id)==='approved'))return 'approved';
  if(reviewerMemberIds.some(id=>decisions.get(id)==='changes_requested'))return 'changes_requested';
  return 'pending';
}

export async function assertTeamProposalApprovals(userId:number, proposal:Record<string,unknown>, database=db) {
  const candidate=proposal as Proposal;
  const required=await approvalRequirement(userId,candidate,database);
  if(!required.required)return;
  const fingerprint=proposalApprovalFingerprint(candidate);
  if(await teamApprovalStatus(userId,candidate.id,fingerprint,required.reviewerMemberIds,database)!=='approved')throw new ProposalApprovalError('Assigned team reviews are still pending for this version.');
}

/** Resolve the target again and bind approval to the content the seller actually reviewed. */
export async function reviewProposalForDelivery(userId:number, proposalId:number, input:ProposalDeliveryInput & {expectedTargetFingerprint?:string;expectedReviewFingerprint?:string}, authorization: 'seller' | 'automatic' = 'seller') {
  const review=await proposalDeliveryService.prepare(userId,proposalId,input);
  if(!review.ready)throw new ProposalDeliveryError('Complete the delivery checklist before requesting approval.',422,'PROPOSAL_NOT_READY',review.issues);
  if(!input.expectedTargetFingerprint || input.expectedTargetFingerprint !== review.targetFingerprint || !input.expectedReviewFingerprint || input.expectedReviewFingerprint !== review.reviewFingerprint)throw new ProposalApprovalError('The recipient, account or content changed. Prepare the delivery again.');
  if(input.expectedRevision !== review.proposal.revision)throw new ProposalApprovalError('The proposal changed. Reload and review it again.');
  return db.transaction(async(tx:typeof db)=>{
    const lock=await tx.execute(sql`SELECT id,revision,status FROM proposals WHERE id=${proposalId} AND user_id=${userId} FOR UPDATE`);
    if(!lock.rows[0] || lock.rows[0].revision !== input.expectedRevision || !['draft','sent','viewed'].includes(lock.rows[0].status))throw new ProposalApprovalError('The proposal changed during review.');
    const candidate={...review.proposal,metadata:{...review.proposal.metadata,deliveryTarget:review.target}} as Proposal;
    if (authorization === 'automatic') {
      const policy = await getProposalReviewPolicy(userId, tx);
      if (policy.requireReviewBeforeAiSend || candidate.metadata?.automaticSendEligible !== true) throw new ProposalApprovalError('Automatic proposal sending is not enabled for this request.');
      await assertAutomaticProposalCommercials(userId, candidate, tx);
    }
    const fingerprint=proposalApprovalFingerprint(candidate);
    const requirement=await approvalRequirement(userId,candidate,tx);
    if(requirement.required){
      const members=await tx.execute(sql`SELECT m.id FROM team_members m JOIN support_teams t ON t.id=m.team_id AND t.user_id=m.user_id WHERE m.user_id=${userId} AND m.is_active=true AND t.is_active=true`);
      if(requirement.reviewerMemberIds.some(id=>!members.rows.some((member: {id:number})=>member.id===id)))throw new ProposalApprovalError('An assigned reviewer is inactive. Update the review policy.');
      for(const reviewer of requirement.reviewerMemberIds)await tx.execute(sql`INSERT INTO proposal_approvals(user_id,proposal_id,reviewer_member_id,fingerprint,snapshot) VALUES(${userId},${proposalId},${reviewer},${fingerprint},${JSON.stringify(proposalReviewSnapshot(candidate))}::jsonb) ON CONFLICT(business_profile_id, user_id,proposal_id,reviewer_member_id,fingerprint) DO NOTHING`);
    }
    const approvalStatus=requirement.required ? await teamApprovalStatus(userId,proposalId,fingerprint,requirement.reviewerMemberIds,tx) : 'approved';
    const approved=approvalStatus==='approved';
    const metadata={...candidate.metadata,deliveryTarget:review.target,...(authorization === 'seller' ? {sellerReviewedAt:new Date().toISOString()} : {automaticAuthorizedAt:new Date().toISOString()}),authorizationMode:authorization,approvedAt:approved ? new Date().toISOString() : null,approvalFingerprint:approved ? fingerprint : null,teamApproval:{...requirement,fingerprint,status:approvalStatus}};
    const saved=await tx.execute(sql`UPDATE proposals SET recipient_name=${review.target.recipientName},recipient_email=${review.target.recipientEmail},metadata=${JSON.stringify(metadata)}::jsonb,revision=revision+1,updated_at=NOW() WHERE id=${proposalId} AND user_id=${userId} RETURNING revision`);
    await tx.execute(sql`INSERT INTO proposal_events(user_id,proposal_id,event_key,kind,payload,processed_at) VALUES(${userId},${proposalId},${`review:${proposalId}:${saved.rows[0].revision}`},${approved?'approved':'approval_requested'},${JSON.stringify({reasons:requirement.reasons,reviewerMemberIds:requirement.reviewerMemberIds})}::jsonb,NOW()) ON CONFLICT DO NOTHING`);
    return {id:proposalId,revision:saved.rows[0].revision,approved,requirement,metadata};
  });
}

/** Automatic authorization never grants the model discretion over prices or terms. */
export async function assertAutomaticProposalCommercials(userId: number, proposal: ProposalDocument, database = db) {
  const catalog = await database.execute(sql`SELECT id,name,unit_price,unit FROM proposal_catalog WHERE user_id=${userId} AND active AND currency=${proposal.currency || ''}`);
  if (!proposal.lineItems?.length || proposal.lineItems.some(item => {
    const approved = catalog.rows.find((entry: {id:number}) => entry.id === item.catalogId);
    return !approved || Number(item.unitPrice) !== Number(approved.unit_price) || Number(item.unitPrice) <= 0
      || item.name !== approved.name || item.unit !== approved.unit || Number(item.discount || 0) !== 0;
  }) || Number(proposal.discountValue || 0) !== 0 || Number(proposal.taxRate || 0) !== 0) {
    throw new ProposalApprovalError('Automatic offers require current approved catalog pricing without unapproved discounts or tax overrides.');
  }
  const templates = await database.execute(sql`SELECT terms_and_conditions FROM proposal_templates WHERE user_id=${userId} AND is_default=true`);
  if (!templates.rows.some((row: {terms_and_conditions:string}) => row.terms_and_conditions?.trim() && row.terms_and_conditions.trim() === proposal.termsAndConditions?.trim())) {
    throw new ProposalApprovalError('Configure approved terms on a default proposal template before automatic sending.');
  }
}

export async function listProposalApprovals(userId:number,proposalId?:number,memberId?:number) {
  return (await db.execute(sql`SELECT a.id,a.proposal_id AS "proposalId",a.reviewer_member_id AS "reviewerMemberId",m.name AS "reviewerName",a.fingerprint,a.decision,a.comment,a.snapshot,a.created_at AS "createdAt",a.reviewed_at AS "reviewedAt",p.revision,p.status AS "proposalStatus" FROM proposal_approvals a JOIN proposals p ON p.id=a.proposal_id AND p.user_id=a.user_id JOIN team_members m ON m.id=a.reviewer_member_id AND m.user_id=a.user_id WHERE a.user_id=${userId} ${proposalId ? sql`AND a.proposal_id=${proposalId}` : sql``} ${memberId ? sql`AND a.reviewer_member_id=${memberId}` : sql``} ORDER BY a.created_at DESC LIMIT 100`)).rows;
}
export async function decideProposalApproval(userId:number,memberId:number,approvalId:number,input:unknown) {
  const decision=z.object({decision:z.enum(['approved','changes_requested']),comment:z.string().trim().max(5000).default(''),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(input);
  return db.transaction(async(tx:typeof db)=>{
    const candidate=await tx.execute(sql`SELECT a.proposal_id FROM proposal_approvals a JOIN team_members m ON m.id=a.reviewer_member_id AND m.user_id=a.user_id AND m.is_active=true JOIN support_teams t ON t.id=m.team_id AND t.user_id=m.user_id AND t.is_active=true WHERE a.id=${approvalId} AND a.user_id=${userId} AND a.reviewer_member_id=${memberId}`);
    if(!candidate.rows[0])throw new ProposalApprovalError('Review request not found.',404);
    const lockedProposal=await tx.execute(sql`SELECT id FROM proposals WHERE id=${candidate.rows[0].proposal_id} AND user_id=${userId} FOR UPDATE`);
    if(!lockedProposal.rows[0])throw new ProposalApprovalError('Review request not found.',404);
    const request=await tx.execute(sql`SELECT a.* FROM proposal_approvals a JOIN team_members m ON m.id=a.reviewer_member_id AND m.user_id=a.user_id AND m.is_active=true JOIN support_teams t ON t.id=m.team_id AND t.user_id=m.user_id AND t.is_active=true WHERE a.id=${approvalId} AND a.user_id=${userId} AND a.reviewer_member_id=${memberId} FOR UPDATE OF a`);
    const row=request.rows[0];if(!row)throw new ProposalApprovalError('Review request not found.',404);
    if(row.fingerprint !== decision.fingerprint)throw new ProposalApprovalError('This review request changed. Reload it.');
    const {proposalService}=await import('./ProposalService.js');
    const proposal=await proposalService.getProposalById(userId,row.proposal_id);
    if(!proposal || !['draft','sent','viewed'].includes(proposal.status) || proposalApprovalFingerprint(proposal)!==row.fingerprint)throw new ProposalApprovalError('This review belongs to an older proposal version. Ask the seller to request a new review.');
    if(decision.decision==='changes_requested' && !decision.comment)throw new ProposalApprovalError('Explain which changes are needed.',400);
    await tx.execute(sql`UPDATE proposal_approvals SET decision=${decision.decision},comment=${decision.comment},reviewed_at=NOW() WHERE id=${approvalId} AND user_id=${userId}`);
    const requirement=await approvalRequirement(userId,proposal,tx);
    const approvalStatus=requirement.required ? await teamApprovalStatus(userId,row.proposal_id,row.fingerprint,requirement.reviewerMemberIds,tx) : 'approved';
    const approved=approvalStatus==='approved';
    const metadata={...proposal.metadata,approvedAt:approved?new Date().toISOString():null,approvalFingerprint:approved?row.fingerprint:null,teamApproval:{...proposal.metadata?.teamApproval,...requirement,fingerprint:row.fingerprint,status:approvalStatus}};
    await tx.execute(sql`UPDATE proposals SET metadata=${JSON.stringify(metadata)}::jsonb,revision=revision+1,updated_at=NOW() WHERE id=${row.proposal_id} AND user_id=${userId}`);
    await tx.execute(sql`INSERT INTO proposal_events(user_id,proposal_id,event_key,kind,payload,processed_at) VALUES(${userId},${row.proposal_id},${`member-review:${approvalId}:${Date.now()}`},${decision.decision==='approved'?'team_approved':'changes_requested'},${JSON.stringify({memberId,comment:decision.comment})}::jsonb,NOW())`);
    return {id:approvalId,decision:decision.decision,approved};
  });
}
