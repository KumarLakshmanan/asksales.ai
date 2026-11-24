/**
 * Canonical Mastra tool registry used by interactive widgets.
 *
 * Agents and widget submissions must resolve the same createTool instances so
 * their schemas and execution semantics cannot drift. Approval-only wrappers
 * are deliberately bypassed after a widget has atomically recorded the user's
 * explicit submission.
 */
import type { ToolContext } from './toolRegistry.js';
import { toolToWidgetType } from '../../shared/toolWidgetMap.js';
import {
  generateIcpTool,
  saveBusinessProfileTool,
  crawlWebsiteTool,
} from './icpTools.js';
import { generateLeadInputsTool } from './leadTools.js';
import {
  generateImageTool,
  generateVideoTool,
  generateImageFromImageTool,
  generateVideoFromImageTool,
  generateSocialMediaPostTool,
  generateSocialChatTemplateTool,
  generateBlogPostTool,
  generateWhatsappTemplateTool,
  publishSocialPostTool,
} from './contentTools.js';
import {
  generateEmailTemplateTool,
  generateSmsTemplateTool,
  sendOutreachMessagesTool,
} from './outreachTools.js';
import { generateAdTool, publishAdsTool, publishMetaAdsTool, publishGoogleAdsTool } from './adsTools.js';
import { stopAdsTool, executeStopAds } from './stopAdsTool.js';
import {
  analyticsQueryTool,
  createCrmReminderTool,
  updatePipelineStatusTool,
} from './analyticsTools.js';
import {
  brandContextSnapshot,
  formatContentBrandContext,
  resolveContentBrandContext,
} from '../../services/content/ContentBrandContextService.js';

const BRAND_CONTEXT_WIDGET_TOOLS = new Set([
  'generate_image',
  'generate_video',
  'generate_image_from_image',
  'generate_video_from_image',
  'generate_social_media_post',
  'generate_social_chat_template',
  'generate_email_template',
  'generate_sms_template',
  'generate_blog_post',
  'generate_ad',
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const canonicalWidgetTools: Record<string, any> = {
  stop_ads: stopAdsTool,
  generate_image: generateImageTool,
  generate_video: generateVideoTool,
  generate_image_from_image: generateImageFromImageTool,
  generate_video_from_image: generateVideoFromImageTool,
  generate_social_media_post: generateSocialMediaPostTool,
  generate_social_chat_template: generateSocialChatTemplateTool,
  generate_email_template: generateEmailTemplateTool,
  generate_sms_template: generateSmsTemplateTool,
  generate_blog_post: generateBlogPostTool,
  generate_whatsapp_template: generateWhatsappTemplateTool,
  generate_ad: generateAdTool,
  generate_icp: generateIcpTool,
  save_business_profile: saveBusinessProfileTool,
  crawl_website: crawlWebsiteTool,
  generate_lead_inputs: generateLeadInputsTool,
  analytics_query: analyticsQueryTool,
  create_crm_reminder: createCrmReminderTool,
  update_pipeline_status: updatePipelineStatusTool,
  publish_social_post: publishSocialPostTool,
  publish_ads: publishAdsTool,
  publish_meta_ads: publishMetaAdsTool,
  publish_google_ads: publishGoogleAdsTool,
  send_outreach_messages: sendOutreachMessagesTool,
};

export const canonicalWidgetToolNames = Object.freeze(Object.keys(canonicalWidgetTools));

export function assertCanonicalWidgetRegistryComplete(): void {
  const mapped = Object.keys(toolToWidgetType).sort();
  const executable = [...canonicalWidgetToolNames].sort();
  if (
    mapped.length !== executable.length ||
    mapped.some((toolName, index) => toolName !== executable[index])
  ) {
    const missing = mapped.filter((name) => !canonicalWidgetTools[name]);
    const extra = executable.filter((name) => !toolToWidgetType[name]);
    throw new Error(
      `Canonical widget tool registry mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
    );
  }
}

// Fail fast on server start instead of accepting a widget that cannot execute.
assertCanonicalWidgetRegistryComplete();

export async function executeCanonicalWidgetTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const tool = canonicalWidgetTools[toolName];
  if (!tool) {
    return { success: false, toolName, error: `No canonical implementation for widget tool "${toolName}"` };
  }

  const schema = tool.inputSchema || tool.schema;
  const parsedArgs = schema?.parse ? schema.parse(args) : args;

  if (BRAND_CONTEXT_WIDGET_TOOLS.has(toolName)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingSnapshot = context.brandContextSnapshot as any;
    if (!existingSnapshot?.businessProfile || !existingSnapshot?.brandToolkit || !existingSnapshot?.provenance) {
      const approvedContext = await resolveContentBrandContext(Number(context.userId), {
        businessProfileId: context.companyProfile?.id,
        brandToolkitId: context.brandToolkit?.id,
      });
      context = {
        ...context,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        brandToolkit: approvedContext.brandToolkit as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        companyProfile: approvedContext.businessProfile as any,
        brandContextPrompt: formatContentBrandContext(approvedContext),
        brandContextSnapshot: brandContextSnapshot(approvedContext),
      };
    }
  }

  // These Mastra tools intentionally return "requiresApproval" during normal
  // agent execution. Widget submission is the approval, so invoke the same
  // canonical executor functions only after the durable widget claim.
  switch (toolName) {
    case 'stop_ads': return executeStopAds(parsedArgs, context);
    case 'send_outreach_messages': {
      const { executeSendOutreachMessages } = await import('./executors/outreachExecutor.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return executeSendOutreachMessages(parsedArgs as any, context);
    }
    case 'publish_ads': {
      const { executePublishAds } = await import('./executors/adsExecutor.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return executePublishAds(parsedArgs as any, context);
    }
    case 'publish_meta_ads': {
      const { executePublishMetaAds } = await import('./executors/adsExecutor.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return executePublishMetaAds(parsedArgs as any, context);
    }
    case 'publish_google_ads': {
      const { executePublishGoogleAds } = await import('./executors/adsExecutor.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return executePublishGoogleAds(parsedArgs as any, context);
    }
    case 'publish_social_post': {
      const { executePublishSocialPost } = await import('./executors/contentExecutor.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return executePublishSocialPost(parsedArgs as any, context);
    }
    default: {
      const fakeMastra = { __toolContext: context };
      return tool.execute(parsedArgs, { mastra: fakeMastra });
    }
  }
}

export function validateCanonicalWidgetToolInput(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const tool = canonicalWidgetTools[toolName];
  if (!tool) throw new Error(`No canonical implementation for widget tool "${toolName}"`);
  const schema = tool.inputSchema || tool.schema;
  return (schema?.parse ? schema.parse(args) : args) as Record<string, unknown>;
}
