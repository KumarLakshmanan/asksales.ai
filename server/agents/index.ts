/**
 * Agent Configurations
 * Defines all available agents with their tools, prompts, and capabilities
 */

import { templateMap, orchestrator as orchestratorPrompt, assistantPersona } from '../services/promptTemplates';

// LangGraph tool names per agent (mirrors langgraph/tools/index.ts)
const agentToolNames: Record<AgentId, string[]> = {
  orchestrator: [],
  icp_generation: ['generate_icp', 'calculate_icp_fit_score'],
  lead_generation: ['generate_lead_inputs', 'execute_lead_workflow', 'get_leads_status'],
  content_studio: ['generate_image', 'generate_video', 'generate_social_post', 'generate_email_template', 'generate_sms_template', 'generate_ad_copy'],
  outreach: ['generate_email_template', 'generate_sms_template', 'send_outreach_messages'],
  performance_marketing: ['generate_ad', 'publish_meta_ads', 'ask_campaign_analytics', 'ask_lead_analytics', 'ask_outreach_analytics'],
};

// Agent display information
export interface AgentInfo {
  id: string;
  name: string;
  displayName: string;
  description: string;
  avatar?: string;
  color: string;
  capabilities: string[];
}

// Agent configuration
export interface AgentConfig {
  info: AgentInfo;
  systemPrompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[];
  canHireAgents: string[];
  requiredIcpScore: number;
  // Optional model override for this agent (if set, it will be used instead of the provider default)
  model?: string;
}

// All available agents
export const AGENT_IDS = [
  'orchestrator',
  'icp_generation', 
  'lead_generation',
  'content_studio',
  'outreach',
  'performance_marketing',
] as const;

export type AgentId = typeof AGENT_IDS[number];

// Agent display information
export const agentInfo: Record<AgentId, AgentInfo> = {
  orchestrator: {
    id: 'orchestrator',
    name: 'Orchestrator',
    displayName: 'Orchestrator',
    description: 'Coordinates all agents and manages your marketing workflow',
    color: '#6366f1',
    capabilities: ['Route requests to specialized agents', 'Manage workflow coordination', 'Provide strategic guidance']
  },
  icp_generation: {
    id: 'icp_generation',
    name: 'ICP Agent',
    displayName: 'Orchestrator',
    description: 'Creates and refines your Ideal Customer Profile',
    avatar: '/agent-avatars/orchestrator.png',
    color: '#8b5cf6',
    capabilities: ['Generate ICP from requirements', 'Calculate fit scores', 'Recommend target segments']
  },
  lead_generation: {
    id: 'lead_generation',
    name: 'Lead Agent',
    displayName: 'Lead Generation Specialist',
    description: 'Discovers qualified leads across multiple platforms',
    avatar: '/agent-avatars/leadagent.png',
    color: '#10b981',
    capabilities: ['Generate lead search parameters', 'Execute lead scraping workflows', 'Filter and qualify leads']
  },
  content_studio: {
    id: 'content_studio',
    name: 'Content Agent',
    displayName: 'Content Studio Director',
    description: 'Creates engaging marketing content and creative assets',
    avatar: '/agent-avatars/content-studio.png',
    color: '#f59e0b',
    capabilities: ['Generate images', 'Create videos', 'Write social media posts', 'Design ad creatives']
  },
  outreach: {
    id: 'outreach',
    name: 'Outreach Agent',
    displayName: 'Outreach Coordinator',
    description: 'Manages personalized email and SMS outreach campaigns',
    avatar: '/agent-avatars/outreach.png',
    color: '#3b82f6',
    capabilities: ['Generate email templates', 'Create SMS messages', 'Send personalized outreach']
  },
  performance_marketing: {
    id: 'performance_marketing',
    name: 'Performance Agent',
    displayName: 'Performance Marketing Manager',
    description: 'Optimizes paid advertising campaigns, analyzes performance metrics, and provides marketing insights',
    avatar: '/agent-avatars/performance.png',
    color: '#ec4899',
    capabilities: ['Generate ad creatives', 'Publish to Meta Ads', 'Optimize budgets', 'Campaign analytics', 'Performance metrics', 'ROI analysis']
  }
};

// Build agent configurations
export function getAgentConfig(agentId: AgentId): AgentConfig {
  const info = agentInfo[agentId];
  const tools = agentToolNames[agentId] || [];
  
  // Get system prompt
  let systemPrompt = assistantPersona;
  switch (agentId) {
    case 'orchestrator':
      systemPrompt = orchestratorPrompt || assistantPersona;
      break;
    case 'icp_generation':
      systemPrompt = templateMap.icpAgent || assistantPersona;
      break;
    case 'lead_generation':
      systemPrompt = templateMap.leadGenerator || assistantPersona;
      break;
    case 'content_studio':
      systemPrompt = templateMap.contentStudioAgent || assistantPersona;
      break;
    case 'outreach':
      systemPrompt = templateMap.outreachAgent || assistantPersona;
      break;
    case 'performance_marketing':
      systemPrompt = templateMap.performanceMarketingAgent || assistantPersona;
      break;
    default:
      systemPrompt = assistantPersona;
  }

  // Define which agents can be hired by each agent
  const canHireAgents: Record<AgentId, string[]> = {
    orchestrator: ['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'],
    icp_generation: ['lead_generation'],
    lead_generation: ['content_studio', 'outreach'],
    content_studio: ['performance_marketing', 'outreach'],
    outreach: ['performance_marketing'],
    performance_marketing: [],
  };

  // Required ICP score to activate agent
  const requiredIcpScores: Record<AgentId, number> = {
    orchestrator: 0,
    icp_generation: 0,
    lead_generation: 50,
    content_studio: 50,
    outreach: 50,
    performance_marketing: 50,
  };

  return {
    info,
    systemPrompt,
    tools,
    canHireAgents: canHireAgents[agentId],
    requiredIcpScore: requiredIcpScores[agentId]
  };
}

// Get all agent configs
export function getAllAgentConfigs(): Record<AgentId, AgentConfig> {
  const configs: Partial<Record<AgentId, AgentConfig>> = {};
  for (const agentId of AGENT_IDS) {
    configs[agentId] = getAgentConfig(agentId);
  }
  return configs as Record<AgentId, AgentConfig>;
}

// Map natural language agent names to agent IDs
export const agentNameMapping: Record<string, AgentId> = {
  // ICP Agent variants
  'icp agent': 'icp_generation',
  'icp generation': 'icp_generation',
  'icp generation agent': 'icp_generation',
  'profile agent': 'icp_generation',
  'icp': 'icp_generation',
  
  // Lead Agent variants
  'lead agent': 'lead_generation',
  'lead generation': 'lead_generation',
  'lead generation agent': 'lead_generation',
  'lead generation specialist': 'lead_generation',
  'marcus': 'lead_generation',
  'marcus johnson': 'lead_generation',
  'lead gen': 'lead_generation',
  
  // Content Studio variants
  'content agent': 'content_studio',
  'content studio': 'content_studio',
  'content studio agent': 'content_studio',
  'content studio director': 'content_studio',
  'alex': 'content_studio',
  'alex chen': 'content_studio',
  'content creator': 'content_studio',
  
  // Outreach Agent variants
  'outreach agent': 'outreach',
  'outreach coordinator': 'outreach',
  'outreach': 'outreach',
  'emily': 'outreach',
  'emily rodriguez': 'outreach',
  
  // Performance Marketing variants
  'performance marketing': 'performance_marketing',
  'performance marketing agent': 'performance_marketing',
  'performance marketing manager': 'performance_marketing',
  'marketing agent': 'performance_marketing',
  'sarah': 'performance_marketing',
  'sarah martinez': 'performance_marketing',
  'ads agent': 'performance_marketing',
  
};

// Parse natural language hire commands like "Hire Marcus", "I want to work with Emily", etc.
export function parseHireCommand(message: string): { agentId: AgentId | null; remainingMessage: string } {
  const lowerMessage = message.toLowerCase().trim();
  
  // Pattern 1: "Hire [name/agent]" 
  const hireMatch = message.match(/^hire\s+(.*?)(?:\s+for|\s+to|\.|$)/i);
  if (hireMatch) {
    const agentPhrase = hireMatch[1].toLowerCase().trim();
    const agentId = agentNameMapping[agentPhrase] || null;
    let remainingMessage = message.replace(/^hire\s+.*?(?:\s+for|\s+to)/i, '').trim();
    if (!remainingMessage) {
      remainingMessage = message.replace(/^hire\s+/i, '').trim();
    }
    if (agentId) return { agentId, remainingMessage };
  }
  
  // Pattern 2: "I want to work with [name]", "Switch to [name]", "Talk to [name]"
  const workWithMatch = lowerMessage.match(/(?:work with|switch to|talk to|connect me with|bring in|start with|activate)\s+(\w+[\w\s]*?)(?:\s+for|\s+to|\.|$)/i);
  if (workWithMatch) {
    const agentPhrase = workWithMatch[1].trim();
    const agentId = agentNameMapping[agentPhrase] || null;
    if (agentId) return { agentId, remainingMessage: message };
  }
  
  // Pattern 3: Direct name at start of message
  for (const [phrase, agentId] of Object.entries(agentNameMapping)) {
    if (lowerMessage === phrase || lowerMessage.startsWith(phrase + ' ') || lowerMessage.startsWith(phrase + ',')) {
      return { agentId, remainingMessage: message.slice(phrase.length).trim() };
    }
  }
  
  // Pattern 4: Legacy @AgentName /start (backward compatibility)
  return { agentId: null, remainingMessage: message };
}

// Get recommended next agents based on workflow state
export function getRecommendedAgents(
  currentAgent: AgentId,
  completedSteps: string[],
  icpScore: number
): AgentId[] {
  const recommendations: AgentId[] = [];
  
  // If ICP score is low, always recommend ICP generation
  if (icpScore < 50 && !completedSteps.includes('icp_generation')) {
    return ['icp_generation'];
  }
  
  // Based on current agent and completed steps
  const config = getAgentConfig(currentAgent);
  
  // Filter out already completed agents
  for (const agentId of config.canHireAgents) {
    if (!completedSteps.includes(agentId)) {
      const agentConfig = getAgentConfig(agentId as AgentId);
      if (icpScore >= agentConfig.requiredIcpScore) {
        recommendations.push(agentId as AgentId);
      }
    }
  }
  
  // Add workflow-specific recommendations
  if (completedSteps.includes('lead_generation') && !completedSteps.includes('outreach')) {
    if (!recommendations.includes('outreach')) {
      recommendations.unshift('outreach');
    }
  }
  
  if (completedSteps.includes('content_studio') && !completedSteps.includes('performance_marketing')) {
    if (!recommendations.includes('performance_marketing')) {
      recommendations.push('performance_marketing');
    }
  }
  
  return recommendations;
}

export default {
  AGENT_IDS,
  agentInfo,
  getAgentConfig,
  getAllAgentConfigs,
  agentNameMapping,
  parseHireCommand,
  getRecommendedAgents
};
