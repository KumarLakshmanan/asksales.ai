/**
 * Agent System TypeScript Types
 * Based on Python workflow orchestrator architecture
 */

export interface WorkflowConfig {
  workflow_id: string;
  platform: string;
  description: string;
  title: string;
  version: string;
  steps: WorkflowStep[];
}

export interface WorkflowStep {
  step_id: string;
  step_type: 'llm_call' | 'apify_actor';
  description: string;
  config: LLMStepConfig | ApifyStepConfig;
  output_key: string;
  next_step?: string;
  iterate_over?: string;
}

export interface LLMStepConfig {
  model: string;
  temperature: number;
  max_tokens: number;
  prompt_template: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  example_json?: Record<string, any>;
}

export interface ApifyStepConfig {
  actor_id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input_mapping: Record<string, any>;
  input_types: Record<string, string>;
  timeout: number;
  memory: number;
  required_inputs?: string[];
  skip_if_empty?: string[];
  immediate_save?: ImmediateSaveConfig;
  iterate_over?: string;
}

export interface ImmediateSaveConfig {
  enabled: boolean;
  target_table: 'leads' | 'posts';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  field_mapping: Record<string, any>;
}

export interface ParsedCampaignData {
  prompt_id?: number;
  campaign_name?: string;
  campaign_objective?: string;
  target_audience?: string;
  sources?: string[]; // Legacy field
  primary_channels?: string[]; // New field from ICP
  geography_locations?: string[];
  primary_regions?: string[]; // From ICP
  industry_vertical?: string;
  business_type?: string;
  target_roles_titles?: string[];
  primary_job_titles?: string[]; // From ICP
  interests?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface WorkflowResult {
  success: boolean;
  platform: string;
  total_leads_saved?: number;
  execution_time: number;
  error?: string;
  error_message?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workflow_result?: any;
  count?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  leads?: any[];
}

export interface PlatformResult {
  success: boolean;
  leads_count: number;
  error?: string;
}

export interface WebSocketProgressEvent {
  event_type: 'orchestrator_progress' | 'workflow_started' | 'workflow_completed' | 'workflow_error' | 'workflow_step' | 'batch_progress' | 'execution_summary';
  user_id: number;
  prompt_id?: number;
  thread_id?: number;
  message: string;
  platform?: string;
  step?: string;
  details?: string;
  count?: number;
  error?: string;
  timestamp: number;
  percentage?: number;
  completed?: number;
  total?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
  execution_id?: string;
  status?: 'succeeded' | 'succeeded_empty' | 'partial_success' | 'failed' | 'cancelled';
  total_leads?: number;
  successful_platforms?: number;
  failed_platforms?: number;
  results?: Array<{
    platform: string;
    success: boolean;
    leads_count?: number;
    error?: string;
  }>;
}

export interface AgentStatus {
  agent_type: 'orchestrator' | 'lead_generation' | 'content_studio' | 'outreach' | 'performance_marketing';
  user_id?: number;
  available_platforms?: string[];
  total_platforms?: number;
  workflow_configs_loaded?: number;
  status?: 'idle' | 'running' | 'error';
}
