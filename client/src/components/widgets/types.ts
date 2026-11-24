/**
 * Widget Type Definitions
 * Types for the interactive widget system
 */

import type React from 'react';

export type WidgetType =
  | 'image_generation'
  | 'video_generation'
  | 'image_transform'
  | 'video_from_image'
  | 'social_post'
  | 'social_chat_template'
  | 'email_template'
  | 'sms_template'
  | 'whatsapp_template'
  | 'blog_post'
  | 'ad_generation'
  | 'icp_creation'
  | 'business_profile'
  | 'website_crawl'
  | 'lead_gen_config'
  | 'analytics_query'
  | 'crm_reminder'
  | 'pipeline_status'
  | 'publish_post'
  | 'publish_ads'
  | 'stop_ads'
  | 'send_outreach';

export interface WidgetState {
  id: number;
  threadId: number;
  messageId: number | null;
  toolName: string;
  widgetType: WidgetType;
  formValues: Record<string, unknown>;
  status: 'active' | 'draft' | 'running' | 'queued' | 'provider_succeeded' | 'succeeded' | 'failed' | 'cancelled';
  submittedAt?: string | null;
  submittedValues?: Record<string, unknown> | null;
  executionResult?: unknown;
  executionError?: string | null;
  executionStartedAt?: string | null;
  executionCompletedAt?: string | null;
  executionLeaseExpiresAt?: string | null;
  executionAttemptCount?: number;
  /** Live progress sent while a long-running action (e.g. a multi-post plan) runs. */
  progress?: { completed: number; total: number; message: string } | null;
  agentType: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WidgetProps {
  widget: WidgetState;
  onClose: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
  onFormChange: (values: Record<string, unknown>) => void;
}

export interface WidgetDefinition {
  type: WidgetType;
  toolName: string;
  component: React.ComponentType<WidgetProps>;
  title: string;
  description: string;
  icon: string;
}
