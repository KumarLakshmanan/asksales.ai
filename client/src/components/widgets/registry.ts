/**
 * Widget Registry
 * Maps widget types to their components and metadata.
 */

import type { WidgetDefinition } from './types';
import { ImageGenerationWidget } from './ImageGenerationWidget';
import { VideoGenerationWidget } from './VideoGenerationWidget';
import { ImageTransformWidget } from './ImageTransformWidget';
import { VideoFromImageWidget } from './VideoFromImageWidget';
import { SocialPostWidget } from './SocialPostWidget';
import { SocialChatTemplateWidget } from './SocialChatTemplateWidget';
import { EmailTemplateWidget } from './EmailTemplateWidget';
import { WhatsappTemplateWidget } from './WhatsappTemplateWidget';
import { SmsTemplateWidget } from './SmsTemplateWidget';
import { BlogPostWidget } from './BlogPostWidget';
import { AdGenerationWidget } from './AdGenerationWidget';
import { ICPCreationWidget } from './ICPCreationWidget';
import { BusinessProfileWidget } from './BusinessProfileWidget';
import { WebsiteCrawlWidget } from './WebsiteCrawlWidget';
import { LeadGenConfigWidget } from './LeadGenConfigWidget';
import { AnalyticsQueryWidget } from './AnalyticsQueryWidget';
import { CrmReminderWidget } from './CrmReminderWidget';
import { PipelineStatusWidget } from './PipelineStatusWidget';
import { PublishPostWidget } from './PublishPostWidget';
import { PublishAdsWidget } from './PublishAdsWidget';
import { StopAdsWidget } from './StopAdsWidget';
import { SendOutreachWidget } from './SendOutreachWidget';

export const widgetRegistry: Record<string, WidgetDefinition> = {
  stop_ads: {
    type: 'stop_ads', toolName: 'stop_ads', component: StopAdsWidget,
    title: 'Stop ads', description: 'Confirm the exact campaign and platforms to pause', icon: 'megaphone',
  },
  image_generation: {
    type: 'image_generation',
    toolName: 'generate_image',
    component: ImageGenerationWidget,
    title: 'Generate Image',
    description: 'Create AI-generated marketing images',
    icon: 'image',
  },
  video_generation: {
    type: 'video_generation',
    toolName: 'generate_video',
    component: VideoGenerationWidget,
    title: 'Generate Video',
    description: 'Create AI-generated marketing videos',
    icon: 'video',
  },
  image_transform: {
    type: 'image_transform',
    toolName: 'generate_image_from_image',
    component: ImageTransformWidget,
    title: 'Transform Image',
    description: 'Apply AI transformations to an existing image',
    icon: 'image',
  },
  video_from_image: {
    type: 'video_from_image',
    toolName: 'generate_video_from_image',
    component: VideoFromImageWidget,
    title: 'Animate Image',
    description: 'Create a video animation from a static image',
    icon: 'video',
  },
  social_post: {
    type: 'social_post',
    toolName: 'generate_social_media_post',
    component: SocialPostWidget,
    title: 'Create Social Post',
    description: 'Generate social media content with AI',
    icon: 'share',
  },
  social_chat_template: {
    type: 'social_chat_template',
    toolName: 'generate_social_chat_template',
    component: SocialChatTemplateWidget,
    title: 'Create DM Template',
    description: 'Generate social media direct message templates',
    icon: 'message',
  },
  email_template: {
    type: 'email_template',
    toolName: 'generate_email_template',
    component: EmailTemplateWidget,
    title: 'Create Email Template',
    description: 'Generate professional email marketing templates',
    icon: 'mail',
  },
  sms_template: {
    type: 'sms_template',
    toolName: 'generate_sms_template',
    component: SmsTemplateWidget,
    title: 'Create SMS Template',
    description: 'Generate SMS marketing templates',
    icon: 'smartphone',
  },
  whatsapp_template: {
    type: 'whatsapp_template', toolName: 'generate_whatsapp_template', component: WhatsappTemplateWidget,
    title: 'Create WhatsApp Template', description: 'Review message content, header, footer and buttons', icon: 'message',
  },
  blog_post: {
    type: 'blog_post',
    toolName: 'generate_blog_post',
    component: BlogPostWidget,
    title: 'Create Blog Post',
    description: 'Generate SEO-optimized blog content',
    icon: 'file-text',
  },
  ad_generation: {
    type: 'ad_generation',
    toolName: 'generate_ad',
    component: AdGenerationWidget,
    title: 'Create Ad Copy',
    description: 'Generate ad copy and creative concepts',
    icon: 'megaphone',
  },
  icp_creation: {
    type: 'icp_creation',
    toolName: 'generate_icp',
    component: ICPCreationWidget,
    title: 'Create ICP Profile',
    description: 'Define your Ideal Customer Profile',
    icon: 'target',
  },
  business_profile: {
    type: 'business_profile',
    toolName: 'save_business_profile',
    component: BusinessProfileWidget,
    title: 'Business Profile',
    description: 'Save your business information',
    icon: 'building',
  },
  website_crawl: {
    type: 'website_crawl',
    toolName: 'crawl_website',
    component: WebsiteCrawlWidget,
    title: 'Analyze Website',
    description: 'Extract business information from a website',
    icon: 'globe',
  },
  lead_gen_config: {
    type: 'lead_gen_config',
    toolName: 'generate_lead_inputs',
    component: LeadGenConfigWidget,
    title: 'Configure Lead Generation',
    description: 'Set up lead search parameters and platforms',
    icon: 'search',
  },
  analytics_query: {
    type: 'analytics_query',
    toolName: 'analytics_query',
    component: AnalyticsQueryWidget,
    title: 'Query Analytics',
    description: 'Ask questions about your marketing performance',
    icon: 'bar-chart',
  },
  crm_reminder: {
    type: 'crm_reminder',
    toolName: 'create_crm_reminder',
    component: CrmReminderWidget,
    title: 'Create Reminder',
    description: 'Set up a CRM follow-up reminder',
    icon: 'bell',
  },
  pipeline_status: {
    type: 'pipeline_status',
    toolName: 'update_pipeline_status',
    component: PipelineStatusWidget,
    title: 'Update Deal Status',
    description: 'Update CRM deal status for a contact',
    icon: 'git-branch',
  },
  publish_post: {
    type: 'publish_post',
    toolName: 'publish_social_post',
    component: PublishPostWidget,
    title: 'Publish Social Post',
    description: 'Review and confirm publishing or scheduling content to linked social profiles',
    icon: 'share-2',
  },
  publish_ads: {
    type: 'publish_ads',
    toolName: 'publish_ads',
    component: PublishAdsWidget,
    title: 'Launch Ad Campaign',
    description: 'Review and confirm a validated Meta or Google Ads campaign launch',
    icon: 'megaphone',
  },
  send_outreach: {
    type: 'send_outreach',
    toolName: 'send_outreach_messages',
    component: SendOutreachWidget,
    title: 'Send Outreach Campaign',
    description: 'Review and confirm sending out structured outreach messages to contacts',
    icon: 'send',
  },
};
