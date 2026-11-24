/**
 * Mastra Outreach Tools
 * Wraps existing outreach executor functions as Mastra createTool instances.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const toolResultSchema = z.object({
  success: z.boolean(),
  toolName: z.string(),
  output: z.any().optional(),
  error: z.string().optional(),
  requiresApproval: z.boolean().optional(),
  approvalData: z.any().optional(),
});

export const generateEmailTemplateTool = createTool({
  id: 'generate_email_template',
  description: 'Generate an email marketing template for cold outreach, newsletters, or follow-ups.',
  inputSchema: z.object({
    subject_line: z.string().optional(),
    sender_name: z.string().optional().describe('Personal sender name only when explicitly supplied by the user.'),
    sender_business_name: z.string().optional().describe('Sender business explicitly requested for this campaign. Use the requested product/fictional business rather than a different workspace brand.'),
    recipient_role: z.string().describe('Role of the recipient'),
    email_body_points: z.array(z.string()).optional().describe('Requested message points; preserve the audience and product details supplied by the user.'),
    content_instructions: z.string().optional().describe('Preserve user constraints verbatim: tone nuances, no emoji, no unverified claims, placeholders, and exclusions. These accompany the generator after review.'),
    tone: z.enum(['professional', 'friendly', 'urgent', 'persuasive', 'formal', 'conversational']).optional(),
    language: z.string().optional(),
    length: z.enum(['short', 'medium', 'long']).optional(),
    email_type: z.enum(['cold_outreach', 'follow_up', 'newsletter', 'promotional', 'introduction', 'thank_you', 'invitation', 'announcement']).optional(),
    include_personalization: z.boolean().optional(),
    include_unsubscribe: z.boolean().optional(),
    cta_text: z.string().optional().describe('Exact requested CTA, including punctuation. Copy verbatim; never paraphrase.'),
    include_image_prompt: z.boolean().optional(),
    auto_generate_image: z.boolean().optional(),
    image_aspect_ratio: z.enum(['1:1', '4:5', '5:4', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']).optional(),
    image_size: z.enum(['1K', '2K', '4K']).optional(),
    image_count: z.number().optional(),
    sequence_steps: z.number().int().min(1).max(5).optional().describe('Number of emails in a sequence (1 = single email). For "a 3-step sequence" use 3. Each step is generated and saved as its own draft.'),
    step_delay_days: z.array(z.number().int().min(0).max(90)).optional().describe('Days to wait before each follow-up, measured from the previous email; one value per follow-up (length sequence_steps - 1). "Follow-ups 3 and 7 days apart" → [3, 7]. Defaults to 3 days each.'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateEmailTemplate } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGenerateEmailTemplate(input, (mastra as any)?.__toolContext);
  },
});

export const generateSmsTemplateTool = createTool({
  id: 'generate_sms_template',
  description: 'Generate an SMS marketing template for short, direct messaging campaigns.',
  inputSchema: z.object({
    campaign_name: z.string().optional(),
    target_audience: z.string().optional(),
    key_message: z.string().describe('Main point to convey'),
    call_to_action: z.string().optional(),
    tone: z.enum(['professional', 'casual', 'urgent', 'friendly', 'promotional']).optional(),
    language: z.string().optional(),
    urgency: z.enum(['low', 'medium', 'high']).optional(),
    include_link: z.boolean().optional(),
    include_personalization: z.boolean().optional(),
    sms_type: z.enum(['promotional', 'transactional', 'reminder', 'follow_up', 'announcement']).optional(),
    include_image_prompt: z.boolean().optional(),
    auto_generate_image: z.boolean().optional(),
    image_aspect_ratio: z.enum(['1:1', '4:5', '5:4', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']).optional(),
    image_size: z.enum(['1K', '2K', '4K']).optional(),
    image_count: z.number().optional(),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateSmsTemplate } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGenerateSmsTemplate(input, (mastra as any)?.__toolContext);
  },
});

export const sendOutreachMessagesTool = createTool({
  id: 'send_outreach_messages',
  description: 'Send outreach messages (email, SMS, WhatsApp, Instagram DM, Facebook Messenger, LinkedIn DM, or Twitter/X DM) to selected leads. Requires user approval.',
  inputSchema: z.object({
    outreach_review: z.record(z.string(), z.unknown()).optional().describe('Exact outreach batch reviewed in the composer; supplied only by the approval card.'),
    _review_validation_error: z.string().optional(),
    lead_ids: z.array(z.number().int().positive()).min(1).describe('Exact IDs of leads selected by the user'),
    channel: z.enum(['email', 'sms', 'whatsapp', 'instagram', 'facebook', 'linkedin', 'twitter']).describe('Outreach channel'),
    subject: z.string().optional().describe('Email subject line'),
    body: z.string().describe('Message body/content to send'),
  provider_account_id: z.string().optional().describe('Exact connected provider account selected in the outreach review; required when multiple Meta accounts are connected'),
    scheduled_for: z.string().datetime().optional().describe('Optional ISO timestamp. Omit to queue immediately.'),
  }).superRefine((value, ctx) => {
    if (value._review_validation_error) ctx.addIssue({ code: 'custom', message: value._review_validation_error });
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    return {
      success: true,
      toolName: 'send_outreach_messages',
      requiresApproval: true,
      output: {
        requiresApproval: true,
        message: `Ready to send ${input.channel} messages to ${input.lead_ids?.length || 0} leads. Approve?`,
        args: input,
      },
    };
  },
});
