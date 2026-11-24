import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import { getCreationRecipients, resolveCreationAccount, validateOutreachTiming, type AccountSelection } from './CreationService.js';
import { personalizeOutreach, type OutreachRecipient } from '../../../shared/outreachCompose.js';
import type { OutreachJob } from '../../tools/outreachSender.js';
import type { AssistantProvenance } from '../../../shared/outreachAssistants.js';
import { assertCustomerDeliveryReady, CustomerDeliverySetupError } from '../assistants/CustomerDeliveryGate.js';

export type CampaignChannel = 'email' | 'sms';
export type CampaignAccounts = Partial<Record<CampaignChannel, AccountSelection>>;
export class CampaignDeliveryReviewError extends Error { readonly status = 409; }
export interface CampaignJobReview {
  version: 1; channel: CampaignChannel; senderId?: number; providerAccountId: string;
  fromEmail?: string; providerCredentialId: number;
  recipient: string; stepNumber: number; contentHash: string;
  assistant?: AssistantProvenance;
}
export function campaignMessageHash(channel: string, recipient: string, subject: string | undefined, content: string) {
  return createHash('sha256').update(JSON.stringify({channel,recipient,subject:subject || '',content})).digest('hex');
}
const selection = (value: unknown): AccountSelection => {
  if (!value || typeof value !== 'object') throw new CampaignDeliveryReviewError('Choose a sending account for every campaign channel.');
  const input=value as AccountSelection;
  if ((input.senderId !== undefined && (!Number.isSafeInteger(input.senderId) || input.senderId <= 0))
    || (input.providerAccountId !== undefined && (typeof input.providerAccountId !== 'string' || !input.providerAccountId || input.providerAccountId.length>255)))
    throw new CampaignDeliveryReviewError('Choose a valid sending account.');
  return {senderId:input.senderId,providerAccountId:input.providerAccountId};
};

function campaignTiming(startAt:unknown,steps:unknown) {
  try {return validateOutreachTiming(startAt,steps);}
  catch(error) {throw new CampaignDeliveryReviewError(error instanceof Error ? error.message : 'Review the campaign schedule and messages.');}
}

/** Sequences keep their multi-step contract; delivery checks match the composer. */
export async function prepareCampaignDelivery(userId:number,campaignId:number,accounts:CampaignAccounts,startAt?:string) {
  const scope=requireBusinessScope();
  if (scope.userId!==userId || !Number.isSafeInteger(campaignId) || campaignId<=0) throw new CampaignDeliveryReviewError('Campaign not found.');
  const startDate=campaignTiming(startAt,undefined) || new Date();
  const campaign=(await db.execute(sql`SELECT * FROM outreach_campaigns WHERE id=${campaignId} AND user_id=${userId}
    AND business_profile_id=${scope.businessProfileId}`)).rows[0] as any;
  if (!campaign) throw new CampaignDeliveryReviewError('Campaign not found.');
  if (campaign.settings?.accountReviewRequired===true) throw new CampaignDeliveryReviewError('Historical deliveries remain paused. Create a new draft and review it before sending.');
  if (campaign.status!=='draft') throw new CampaignDeliveryReviewError('Only a draft campaign can be reviewed for a new launch.');
  const sequenceIds=[...new Set((campaign.settings?.sequenceIds || [campaign.settings?.sequenceId]).map(Number))] as number[];
  const leadIds=[...new Set((campaign.lead_list_ids || []).map(Number))] as number[];
  if (!sequenceIds.length || sequenceIds.some(id=>!Number.isSafeInteger(id)||id<=0) || !leadIds.length
    || leadIds.length>5000 || leadIds.some(id=>!Number.isSafeInteger(id)||id<=0)) throw new CampaignDeliveryReviewError('Campaign recipients or sequences are unavailable.');
  const sequences=(await db.execute(sql`SELECT * FROM outreach_sequences WHERE id IN (${sql.join(sequenceIds.map(id=>sql`${id}`),sql`,`)})
    AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} ORDER BY sequence_type,id`)).rows as any[];
  const channels:CampaignChannel[]=campaign.campaign_type==='both'?['email','sms']:[campaign.campaign_type];
  if (sequences.length!==sequenceIds.length || channels.some(channel=>!['email','sms'].includes(channel))
    || sequences.length!==channels.length || channels.some(channel=>!sequences.some(s=>s.sequence_type===channel)))
    throw new CampaignDeliveryReviewError('Campaign sequences support email and SMS only, with one sequence per channel.');
  const jobs:Array<Omit<OutreachJob,'id'|'status'|'retryCount'|'createdAt'|'updatedAt'>>=[];
  const skipped:Array<{leadId:number;channel:CampaignChannel;reason:string}>=[];
  const summaries:Array<{channel:CampaignChannel;account:string;recipientCount:number;stepCount:number}>=[];
  for (const [sequenceIndex,sequence] of sequences.entries()) {
    const channel=sequence.sequence_type as CampaignChannel, accountSelection=selection(accounts?.[channel]);
    if ((channel === 'email' && !accountSelection.senderId) || (channel === 'sms' && !accountSelection.providerAccountId))
      throw new CampaignDeliveryReviewError('Select the exact sending account for every campaign channel.');
    const {account,binding}=await resolveCreationAccount(userId,channel,accountSelection);
    const assistant = await assertCustomerDeliveryReady({ userId, channel, accountId: channel === 'email' ? account.label : account.providerAccountId });
    if (!account.ready || !binding?.credentialId || !account.providerAccountId || (channel==='email'&&!account.senderId)) throw new CampaignDeliveryReviewError(account.reason || 'The selected account is unavailable.');
    const {recipients}=await getCreationRecipients(userId,channel,accountSelection,{ids:leadIds});
    if (recipients.length!==leadIds.length) throw new CampaignDeliveryReviewError('A campaign recipient was deleted or is outside this business. Review the recipients again.');
    const seen=new Set<string>(), eligible:OutreachRecipient[]=[];
    for (const recipient of recipients) {
      const key=recipient.recipient.trim().toLowerCase();
      if (!recipient.eligible || seen.has(key)) { skipped.push({leadId:recipient.id,channel,reason:recipient.reason || 'Duplicate recipient in this channel.'}); continue; }
      seen.add(key); eligible.push(recipient);
    }
    const steps=sequence.steps;
    if (!Array.isArray(steps)||!steps.length||steps.length>10) throw new CampaignDeliveryReviewError('Review a sequence with one to ten messages.');
    let previous=-1;
    for (const [index,step] of steps.entries()) {
      const day=Number(step.day ?? step.delay_days ?? 0), delayMinutes=day*1440;
      if (!Number.isFinite(delayMinutes)||delayMinutes<0||delayMinutes>90*1440||delayMinutes<=previous) throw new CampaignDeliveryReviewError('Sequence times must increase and fall within 90 days.');
      previous=delayMinutes;
      for (const recipient of eligible) {
        const content=personalizeOutreach(String(channel==='email'?step.body || '':step.message || step.body || ''),recipient);
        const subject=channel==='email'?personalizeOutreach(String(step.subject || 'Message from our team'),recipient):undefined;
        // Reuse the composer boundary for content size, personalization and time limits.
        campaignTiming(undefined,[{delayMinutes:Math.max(1,Math.ceil(delayMinutes)),message:content,subject}]);
        const deliveryReview:CampaignJobReview={version:1,channel,assistant,senderId:account.senderId,providerAccountId:account.providerAccountId,
          fromEmail:channel==='email'?account.label.toLowerCase():undefined,providerCredentialId:binding.credentialId,
          recipient:recipient.recipient,stepNumber:index+1,contentHash:campaignMessageHash(channel,recipient.recipient,subject,content)};
        jobs.push({userId,campaignId,leadId:recipient.id,sequenceId:Number(sequence.id),stepNumber:index+1,
          sequenceStepKey:sequenceIndex*1000+index+1,messageType:channel,scheduledFor:new Date(startDate.getTime()+delayMinutes*60000),subject,content,maxRetries:3,deliveryReview});
      }
    }
    summaries.push({channel,account:account.label,recipientCount:eligible.length,stepCount:steps.length});
  }
  if (!jobs.length) throw new CampaignDeliveryReviewError('No eligible campaign recipients remain.');
  const reviewHash=createHash('sha256').update(JSON.stringify({campaignId,startAt:startAt || 'immediate',
    autoReply:campaign.settings?.replyPolicy?.autoSend === true,
    jobs:jobs.map(({scheduledFor,...job})=>({...job,delayMinutes:(scheduledFor.getTime()-startDate.getTime())/60000})),skipped})).digest('hex');
  return {campaign,startDate,jobs,reviewHash,skipped,summaries};
}

/** Checked again before every worker send, including retries. Never choose a default. */
export async function assertCampaignJobReview(job:OutreachJob) {
  const review=job.deliveryReview;
  if (!review?.assistant) throw new CustomerDeliverySetupError('queued_setup_review_required', 'This campaign message has no reviewed assistant assignment. Review and queue it again after assistant setup.');
  await assertCustomerDeliveryReady({ userId: job.userId, channel: job.messageType, accountId: job.messageType === 'email' ? review.fromEmail || '' : review.providerAccountId, expected: review.assistant });
  if (!review || review.version!==1 || review.channel!==job.messageType || !review.providerAccountId || (job.messageType==='email'&&(!review.senderId||!review.fromEmail)) || !Number.isSafeInteger(review.providerCredentialId) || review.providerCredentialId<=0
    || !Number.isSafeInteger(review.stepNumber) || review.stepNumber!==job.stepNumber || review.contentHash!==campaignMessageHash(job.messageType,review.recipient,job.subject,job.content))
    throw new CampaignDeliveryReviewError('This campaign message requires account, recipient and content review.');
  const {account,binding}=await resolveCreationAccount(job.userId,job.messageType,{senderId:review.senderId,providerAccountId:review.providerAccountId});
  if (!account.ready || binding?.credentialId!==review.providerCredentialId || account.providerAccountId!==review.providerAccountId
    || (job.messageType==='email'&&(account.senderId!==review.senderId || account.label.toLowerCase()!==review.fromEmail)))
    throw new CampaignDeliveryReviewError('The reviewed sending account changed or disconnected. Review the campaign again.');
  const {recipients}=await getCreationRecipients(job.userId,job.messageType,{senderId:review.senderId,providerAccountId:review.providerAccountId},{ids:[job.leadId]});
  if (recipients.length!==1 || !recipients[0].eligible || recipients[0].recipient!==review.recipient)
    throw new CampaignDeliveryReviewError('The reviewed recipient changed or is no longer eligible.');
  return review;
}
