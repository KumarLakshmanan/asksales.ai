/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Outreach Agent
 * Processes lead files, generates email/SMS sequences, and schedules outreach campaigns
 * 
 * Delivery uses reviewed account and recipient checks shared with the composer.
 */

import { LLMProvider } from './LLMProvider';
import { LLMProviderFactory } from './LLMProviderFactory';
import { db } from '../../models/db';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ICPProfile } from '../ICPGenerationService';
import * as XLSX from '@e965/xlsx';
import { parse } from 'csv-parse/sync';
import { outreachSenderWorker } from '../../tools/outreachSender';
import { logger } from '../../utils/logger.js';
import { REVIEWED_CONTENT_RULES } from '../content/TextContentGenerationService.js';
import { OUTREACH_VARIABLES } from '../../../shared/outreachCompose.js';
import { leadGenerationExamples } from '../outreach/leadGenerationExamples.js';

export interface LeadRecord {
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  company?: string;
  role?: string;
  linkedin?: string;
   
  [key: string]: any;
}

export interface EmailSequence {
  id?: number;
  icp_id: number;
  campaign_name: string;
  total_emails: number;
  days_between: number[];
  emails: EmailStep[];
  created_at?: Date;
}

export interface EmailStep {
  step_number: number;
  day: number;
  subject: string;
  body: string;
  personalization_fields: string[];
  follow_up_type?: 'initial' | 'follow_up' | 'breakup';
}

export interface SMSSequence {
  id?: number;
  icp_id: number;
  campaign_name: string;
  total_messages: number;
  messages: SMSStep[];
  created_at?: Date;
}

export interface SMSStep {
  step_number: number;
  day: number;
  message: string;
  character_count: number;
  personalization_fields: string[];
}

export interface OutreachCampaign {
  id?: number;
  user_id: number;
  icp_id: number;
  campaign_name: string;
  campaign_type: 'email' | 'sms' | 'both';
  lead_count: number;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  start_date?: Date;
  sequence_id?: number;
  leads: LeadRecord[];
  created_at?: Date;
}

export class OutreachAgent {
  /**
   * Get LLM provider for a specific user
   */
  private async getLLMProvider(userId: number): Promise<LLMProvider> {
    const provider = await LLMProviderFactory.createProviderForUser(userId);
    if (!provider) {
      throw new Error('No LLM provider configured. Please configure OpenAI or OpenRouter in Settings > Integrations.');
    }
    return provider;
  }

  /**
   * Process uploaded leads file (CSV or Excel)
   */
  async processLeadsFile(fileBuffer: Buffer, fileName: string): Promise<LeadRecord[]> {
    try {
      logger.info({ fileName: fileName }, '[OutreachAgent] Processing leads file');

      const fileExtension = fileName.split('.').pop()?.toLowerCase();
      let leads: LeadRecord[] = [];

      if (fileExtension === 'csv') {
        // Parse CSV
        const csvData = fileBuffer.toString('utf-8');
        leads = parse(csvData, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        });
      } else if (fileExtension === 'xlsx' || fileExtension === 'xls') {
        // Parse Excel
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        leads = XLSX.utils.sheet_to_json(worksheet);
      } else {
        throw new Error('Unsupported file format. Please upload CSV or Excel file.');
      }

      if (leads.length > 5_000) {
        throw new Error('Lead upload exceeds the 5,000-row limit');
      }

      // Normalize field names (lowercase and remove spaces)
      leads = leads.map((lead) => {
        const normalizedLead: LeadRecord = {};
        for (const [key, value] of Object.entries(lead)) {
          const normalizedKey = key.toLowerCase().replace(/\s+/g, '_');
          normalizedLead[normalizedKey] = value;
        }
        normalizedLead.email = normalizedLead.email
          || normalizedLead.email_address
          || normalizedLead.work_email;
        normalizedLead.phone = normalizedLead.phone
          || normalizedLead.phone_number
          || normalizedLead.mobile
          || normalizedLead.mobile_number;
        normalizedLead.first_name = normalizedLead.first_name || normalizedLead.firstname;
        normalizedLead.last_name = normalizedLead.last_name || normalizedLead.lastname;
        normalizedLead.full_name = normalizedLead.full_name
          || normalizedLead.name
          || `${normalizedLead.first_name || ''} ${normalizedLead.last_name || ''}`.trim();
        normalizedLead.company = normalizedLead.company || normalizedLead.company_name;
        normalizedLead.role = normalizedLead.role || normalizedLead.job_title || normalizedLead.title;
        return normalizedLead;
      });

      // Validate leads have required fields
      const validLeads = leads.filter((lead) => {
        const hasEmail = !!lead.email;
        const hasPhone = !!lead.phone;
        return hasEmail || hasPhone;
      });

      logger.info({ validCount: validLeads.length, totalCount: leads.length }, '[OutreachAgent] Processed valid leads from total');
      return validLeads;
     
    } catch (error: any) {
      logger.error({ err: error }, '[OutreachAgent] Error processing leads file');
      throw error;
    }
  }

  /**
   * Generate personalized email sequence
   */
  async generateEmailSequence(
    userId: number,
    icp: ICPProfile,
    leads: LeadRecord[],
    totalEmails: number = 5
  ): Promise<EmailSequence> {
    try {
      logger.info({ totalEmails }, `[OutreachAgent] Generating email sequence with ${totalEmails} emails`);

      const systemPrompt = `You are an expert email copywriter specializing in B2B/B2C outreach sequences. Generate a highly personalized, multi-touch email sequence.

ICP Details:
- Target Audience: ${icp.targetAudience}
- Industry: ${icp.industry}
- Pain Points: ${JSON.stringify(icp.primaryPainPoint ? [icp.primaryPainPoint] : [])}
- Value Proposition: ${icp.primaryValueProposition || 'Innovative solution'}
- Primary Pain Point: ${icp.primaryPainPoint || 'Business challenges'}

Lead Sample:
${JSON.stringify(leadGenerationExamples(leads), null, 2)}

Generate a ${totalEmails}-email sequence that:
1. Email 1 (Day 0): Initial outreach - Hook attention, mention pain point, provide value
2. Email 2 (Day 3): Value-add follow-up - Share resource or insight, no ask
3. Email 3 (Day 7): Social proof - Case study or testimonial, soft CTA
4. Email 4 (Day 12): Direct ask - Clear meeting/demo request
5. Email 5 (Day 18): Breakup email - "Last email" with urgency

Each email should:
- Use personalization fields: {{first_name}}, {{company_name}}, {{full_name}}
- Be concise (under 150 words)
- Have clear subject line
- Include ONE clear CTA
- Vary tone and approach

Return JSON:
{
  "campaign_name": "Campaign name based on ICP",
  "days_between": [0, 3, 7, 12, 18],
  "emails": [
    {
      "step_number": 1,
      "day": 0,
      "subject": "Subject line with {{first_name}}",
      "body": "Email body with {{first_name}}, {{company_name}}, {{full_name}} placeholders",
      "personalization_fields": ["first_name", "company_name", "full_name"],
      "follow_up_type": "initial"
    }
  ]
}`;

      const llmProvider = await this.getLLMProvider(userId);
      const completionResp = await llmProvider.createChatCompletion({
        model: llmProvider.defaultModel,
        messages: [
          { role: 'system', content: `${systemPrompt}\n\n${REVIEWED_CONTENT_RULES}\nUse only these recipient variables: ${OUTREACH_VARIABLES.map(variable=>'{{'+variable.token+'}}').join(', ')}. Do not invent personalization fields or unsupported claims.` },
          { role: 'user', content: `Generate a ${totalEmails}-email outreach sequence.` },
        ],
        temperature: 0.7,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId,
          purpose: 'email_sequence_generation',
          service: 'OutreachAgent',
          action: 'generate_email_sequence',
        },
      });

      const rawResponse = completionResp.content;
      if (!rawResponse) {
        throw new Error('No response from OpenAI');
      }

      const parsedData = JSON.parse(rawResponse);

      const emailSequence: EmailSequence = {
        icp_id: icp.id!,
        campaign_name: parsedData.campaign_name || `${icp.campaignName || 'Outreach'} - Email Sequence`,
        total_emails: totalEmails,
        days_between: parsedData.days_between || [0, 3, 7, 12, 18],
        emails: parsedData.emails || [],
      };

      logger.info({ count: emailSequence.emails.length }, '[OutreachAgent] Generated email sequence with emails');
      return emailSequence;
     
    } catch (error: any) {
      logger.error({ err: error }, '[OutreachAgent] Error generating email sequence');
      throw error;
    }
  }

  /**
   * Generate SMS sequence
   */
  async generateSMSSequence(userId: number, icp: ICPProfile, leads: LeadRecord[], totalMessages: number = 3): Promise<SMSSequence> {
    try {
      logger.info({ totalMessages }, `[OutreachAgent] Generating SMS sequence with ${totalMessages} messages`);

      const systemPrompt = `You are an expert SMS copywriter. Generate a short, punchy SMS outreach sequence.

ICP Details:
- Target Audience: ${icp.targetAudience}
- Pain Point: ${icp.primaryPainPoint || 'Business challenges'}
- Value Proposition: ${icp.primaryValueProposition || 'Solution'}

SMS Constraints:
- Maximum 160 characters per message
- No links in first message (compliance)
- Include opt-out instructions
- Use casual, conversational tone
- Personalize with {{first_name}}

Generate ${totalMessages} SMS messages:
1. SMS 1 (Day 0): Introduction + quick value prop
2. SMS 2 (Day 4): Case study or proof point
3. SMS 3 (Day 8): Direct CTA with link

Return JSON:
{
  "campaign_name": "SMS Campaign Name",
  "messages": [
    {
      "step_number": 1,
      "day": 0,
      "message": "Hi {{first_name}}, [message text] - Reply STOP to opt out",
      "personalization_fields": ["first_name"]
    }
  ]
}`;

      const llmProvider = await this.getLLMProvider(userId);
      const completionResp = await llmProvider.createChatCompletion({
        model: llmProvider.defaultModel,
        messages: [
          { role: 'system', content: `${systemPrompt}\n\n${REVIEWED_CONTENT_RULES}\nUse only these recipient variables: ${OUTREACH_VARIABLES.map(variable=>'{{'+variable.token+'}}').join(', ')}. Do not invent personalization fields or unsupported claims.` },
          { role: 'user', content: `Generate a ${totalMessages}-message SMS sequence.` },
        ],
        temperature: 0.7,
        max_tokens: 1000,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId,
          purpose: 'sms_sequence_generation',
          service: 'OutreachAgent',
          action: 'generate_sms_sequence',
        },
      });

      const rawResponse = completionResp.content;
      if (!rawResponse) {
        throw new Error('No response from OpenAI');
      }

      const parsedData = JSON.parse(rawResponse);

      const smsSequence: SMSSequence = {
        icp_id: icp.id!,
        campaign_name: parsedData.campaign_name || `${icp.campaignName || 'Outreach'} - SMS Sequence`,
        total_messages: totalMessages,
        messages:
           
          parsedData.messages?.map((msg: any) => ({
            ...msg,
            character_count: msg.message?.length || 0,
          })) || [],
      };

      logger.info({ count: smsSequence.messages.length }, '[OutreachAgent] Generated SMS sequence with messages');
      return smsSequence;
     
    } catch (error: any) {
      logger.error({ err: error }, '[OutreachAgent] Error generating SMS sequence');
      throw error;
    }
  }

  /**
   * Create outreach campaign
   */
  async createCampaign(
    userId: number,
    icpId: number,
    campaignName: string,
    campaignType: 'email' | 'sms' | 'both',
    leads: LeadRecord[],
    sequenceIds: number[],
    autoReply = false,
    brand: { brandToolkitId?: unknown; threadId?: unknown } = {},
  ): Promise<number> {
    try {
      logger.info({ campaignName: campaignName }, '[OutreachAgent] Creating outreach campaign');
      // The campaign keeps this brand for every step, even if the default changes later.
      const { resolveWorkflowBrandToolkitId } = await import('../outreach/WorkflowBrand.js');
      const brandToolkitId = await resolveWorkflowBrandToolkitId(userId, { requestedBrandToolkitId: brand.brandToolkitId, threadId: brand.threadId });

      const result = await db.execute(sql`
        INSERT INTO outreach_campaigns (
          user_id,
          name,
          campaign_type,
          lead_list_ids,
          sequence_steps,
          total_leads,
          status,
          settings,
          brand_toolkit_id,
          created_at
        ) VALUES (
          ${userId},
          ${campaignName},
          ${campaignType},
          ${JSON.stringify(leads.map((lead) => Number((lead as any).id)).filter(Number.isInteger))}::jsonb,
          ${JSON.stringify([])}::jsonb,
          ${leads.length},
          'draft',
          ${JSON.stringify({
            icpId: icpId || null,
            sequenceId: sequenceIds[0] || null,
            sequenceIds,
            replyPolicy: { autoSend: autoReply },
          })}::jsonb,
          ${brandToolkitId},
          NOW()
        )
        RETURNING id
      `);

       
      const campaignId = (result.rows[0] as any).id;
      logger.info({ campaignId: campaignId }, '[OutreachAgent] Campaign created with ID');

      return campaignId;
     
    } catch (error: any) {
      logger.error({ err: error }, '[OutreachAgent] Unable to create outreach campaign');
      throw error;
    }
  }

  /**
   * Save email sequence to database
   */
  async saveEmailSequence(userId: number, emailSequence: EmailSequence): Promise<number> {
    try {
      const result = await db.execute(sql`
        INSERT INTO outreach_sequences (
          user_id,
          icp_id,
          sequence_type,
          campaign_name,
          total_steps,
          steps,
          created_at
        ) VALUES (
          ${userId},
          ${emailSequence.icp_id || null},
          'email',
          ${emailSequence.campaign_name},
          ${emailSequence.total_emails},
          ${JSON.stringify(emailSequence.emails)}::jsonb,
          NOW()
        )
        RETURNING id
      `);

       
      const sequenceId = (result.rows[0] as any).id;
      logger.info({ sequenceId: sequenceId }, '[OutreachAgent] Email sequence saved with ID');

      return sequenceId;
     
    } catch (error: any) {
      logger.error({ err: error }, '[OutreachAgent] Unable to save email sequence');
      throw error;
    }
  }

  /**
   * Save SMS sequence to database
   */
  async saveSMSSequence(userId: number, smsSequence: SMSSequence): Promise<number> {
    try {
      const result = await db.execute(sql`
        INSERT INTO outreach_sequences (
          user_id,
          icp_id,
          sequence_type,
          campaign_name,
          total_steps,
          steps,
          created_at
        ) VALUES (
          ${userId},
          ${smsSequence.icp_id || null},
          'sms',
          ${smsSequence.campaign_name},
          ${smsSequence.total_messages},
          ${JSON.stringify(smsSequence.messages)}::jsonb,
          NOW()
        )
        RETURNING id
      `);

       
      const sequenceId = (result.rows[0] as any).id;
      logger.info({ sequenceId: sequenceId }, '[OutreachAgent] SMS sequence saved with ID');

      return sequenceId;
     
    } catch (error: any) {
      logger.error({ err: error }, '[OutreachAgent] Unable to save SMS sequence');
      throw error;
    }
  }

  /**
   * Schedule campaign to start
   */
  async scheduleCampaign(campaignId: number, _startDate: Date, review?: {
    accounts: import('../outreach/CampaignDeliveryService.js').CampaignAccounts; reviewHash: string; startAt?: string;
  }): Promise<boolean> {
    const {requireBusinessScope}=await import('../../tenancy/businessContext.js');
    const {prepareCampaignDelivery,CampaignDeliveryReviewError}=await import('../outreach/CampaignDeliveryService.js');
    const scope=requireBusinessScope();
    if (!review?.reviewHash) throw new CampaignDeliveryReviewError('Review the campaign account, recipients, messages and send time before launching.');
    const plan=await prepareCampaignDelivery(scope.userId,campaignId,review.accounts,review.startAt);
    if (plan.reviewHash!==review.reviewHash) throw new CampaignDeliveryReviewError('The campaign or recipient information changed. Preview and review it again.');
    return db.transaction(async (tx: Pick<NodePgDatabase, "execute">) => {
      const claimed=await tx.execute(sql`UPDATE outreach_campaigns SET status='scheduled',start_date=${plan.startDate},is_active=true,
        launched_at=CASE WHEN ${plan.startDate}::timestamp<=NOW() THEN NOW() ELSE launched_at END,
        settings=COALESCE(settings,'{}'::jsonb)||${JSON.stringify({deliveryReviewVersion:1,deliveryAccounts:review.accounts,deliveryReviewHash:plan.reviewHash})}::jsonb,updated_at=NOW()
        WHERE id=${campaignId} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND status='draft' RETURNING id`);
      if (!claimed.rows.length) return false;
      for (const job of plan.jobs) await outreachSenderWorker.enqueueJob(job,tx);
      return true;
    });
  }

  /**
   * Get campaign by ID
   */
  async getCampaign(campaignId: number, userId: number): Promise<OutreachCampaign | null> {
    try {
      const result = await db.execute(sql`
        SELECT
          *,
          name AS campaign_name,
          total_leads AS lead_count,
          lead_list_ids AS leads,
          CASE
            WHEN settings->>'icpId' ~ '^[0-9]+$' THEN (settings->>'icpId')::integer
            ELSE NULL
          END AS icp_id,
          CASE
            WHEN settings->>'sequenceId' ~ '^[0-9]+$' THEN (settings->>'sequenceId')::integer
            ELSE NULL
          END AS sequence_id
        FROM outreach_campaigns
        WHERE id = ${campaignId} AND user_id = ${userId}
      `);

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0] as unknown as OutreachCampaign;
     
    } catch (error: any) {
      logger.error({ err: error }, '[OutreachAgent] Error fetching campaign');
      throw error;
    }
  }

}
