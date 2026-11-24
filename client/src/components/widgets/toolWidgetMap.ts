/**
 * Tool-to-Widget Mapping
 * Maps AI tool names to their corresponding widget types
 */

import type { WidgetType } from './types';

export const toolToWidgetMap: Record<string, WidgetType> = {
  // Content Studio Tools
  generate_image: 'image_generation',
  generate_video: 'video_generation',
  generate_image_from_image: 'image_transform',
  generate_video_from_image: 'video_from_image',
  generate_social_media_post: 'social_post',
  generate_social_chat_template: 'social_chat_template',
  generate_email_template: 'email_template',
  generate_sms_template: 'sms_template',
  generate_whatsapp_template: 'whatsapp_template',
  generate_blog_post: 'blog_post',

  // Performance Marketing Tools
  generate_ad: 'ad_generation',

  // ICP Tools
  generate_icp: 'icp_creation',
  save_business_profile: 'business_profile',
  crawl_website: 'website_crawl',

  // Lead Generation Tools
  generate_lead_inputs: 'lead_gen_config',

  // Analytics Tools
  analytics_query: 'analytics_query',

  // CRM Tools
  create_crm_reminder: 'crm_reminder',
  update_pipeline_status: 'pipeline_status',

  // Publishing & Outreach Action/Approval Tools
  publish_social_post: 'publish_post',
  publish_ads: 'publish_ads',
  publish_meta_ads: 'publish_ads',
  publish_google_ads: 'publish_ads',
  send_outreach_messages: 'send_outreach',
};

/**
 * Check if a tool name has an associated widget
 */
export function toolHasWidget(toolName: string): boolean {
  return toolName in toolToWidgetMap;
}

/**
 * Get widget type for a tool name
 */
export function getWidgetTypeForTool(toolName: string): WidgetType | undefined {
  return toolToWidgetMap[toolName];
}
