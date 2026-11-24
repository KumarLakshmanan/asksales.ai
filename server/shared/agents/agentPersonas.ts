/**
 * Centralized Agent Persona Data — Single Source of Truth (Server)
 *
 * ALL agent names, roles, descriptions, avatars, colors, labels, and display info
 * should be imported from this file. Never hardcode agent persona data elsewhere.
 */

import type { AgentType } from './state.js';

export type AgentPersonaType = AgentType;

export interface AgentPersona {
  type: AgentPersonaType;
  firstName: string;
  fullName: string;
  role: string;
  description: string;
  avatar: string;
  color: string;
  emoji: string;
  hireAction: string;
  hireMessage: string;
  shortLabel: string;
  /** e.g. "Lead Generation Specialist Marcus" */
  displayName: string;
  /** e.g. "Marcus (Lead Generation)" */
  switchLabel: string;
  /** e.g. "🔍 Lead Generation (Marcus)" */
  toolLabel: string;
  requiredIcpScore: number;
}

// ── Core Definitions ───────────────────────────────────────────────────────────

export const AGENT_PERSONAS: Record<string, AgentPersona> = {
  orchestrator: {
    type: 'orchestrator',
    firstName: 'Orchestrator',
    fullName: 'Orchestrator',
    role: 'Orchestrator',
    description: 'Coordinates all agents and manages your marketing workflow',
    avatar: '/agent-avatars/orchestrator.png',
    color: '#6366f1',
    emoji: '🎯',
    hireAction: '',
    hireMessage: '',
    shortLabel: 'Orchestrator',
    displayName: 'Orchestrator',
    switchLabel: 'Orchestrator',
    toolLabel: '🎯 Orchestrator',
    requiredIcpScore: 0,
  },
  supervisor: {
    type: 'supervisor',
    firstName: 'Supervisor',
    fullName: 'Supervisor',
    role: 'Supervisor',
    description: 'Routes conversations to the appropriate specialist agent',
    avatar: '/agent-avatars/orchestrator.png',
    color: '#4f46e5',
    emoji: '🎯',
    hireAction: '',
    hireMessage: '',
    shortLabel: 'Supervisor',
    displayName: 'Supervisor',
    switchLabel: 'Supervisor',
    toolLabel: '🎯 Supervisor',
    requiredIcpScore: 0,
  },
  icp_generation: {
    type: 'icp_generation',
    firstName: 'Orchestrator',
    fullName: 'Orchestrator',
    role: 'ICP Specialist',
    description: 'Creates and refines your Ideal Customer Profile',
    avatar: '/agent-avatars/icp.png',
    color: '#8b5cf6',
    emoji: '🎯',
    hireAction: 'HIRE_ICP_AGENT',
    hireMessage: 'Build an Ideal Customer Profile',
    shortLabel: 'Orchestrator',
    displayName: 'Orchestrator',
    switchLabel: 'Orchestrator',
    toolLabel: '🎯 Orchestrator',
    requiredIcpScore: 0,
  },
  lead_generation: {
    type: 'lead_generation',
    firstName: 'Marcus',
    fullName: 'Marcus Johnson',
    role: 'Lead Generation Specialist',
    description: 'Discovers qualified leads across multiple platforms',
    avatar: '/agent-avatars/leadagent.png',
    color: '#10b981',
    emoji: '🔍',
    hireAction: 'HIRE_LEAD_GEN',
    hireMessage: 'Hire Marcus for lead generation',
    shortLabel: 'Lead Gen',
    displayName: 'Lead Generation Specialist Marcus',
    switchLabel: 'Marcus (Lead Generation)',
    toolLabel: '🔍 Lead Generation (Marcus)',
    requiredIcpScore: 50,
  },
  content_studio: {
    type: 'content_studio',
    firstName: 'Alex',
    fullName: 'Alex Chen',
    role: 'Content Studio Director',
    description: 'Creates engaging marketing content and creative assets',
    avatar: '/agent-avatars/content-studio.png',
    color: '#f59e0b',
    emoji: '✍️',
    hireAction: 'HIRE_CONTENT_STUDIO',
    hireMessage: 'Hire Alex for content creation',
    shortLabel: 'Content',
    displayName: 'Content Studio Director Alex',
    switchLabel: 'Alex (Content Studio)',
    toolLabel: '✍️ Content Studio (Alex)',
    requiredIcpScore: 50,
  },
  outreach: {
    type: 'outreach',
    firstName: 'Emily',
    fullName: 'Emily Rodriguez',
    role: 'Outreach Coordinator',
    description: 'Manages personalized email and SMS outreach campaigns',
    avatar: '/agent-avatars/outreach.png',
    color: '#3b82f6',
    emoji: '📬',
    hireAction: 'HIRE_OUTREACH',
    hireMessage: 'Hire Emily for outreach campaigns',
    shortLabel: 'Outreach',
    displayName: 'Outreach Coordinator Emily',
    switchLabel: 'Emily (Outreach)',
    toolLabel: '📬 Outreach (Emily)',
    requiredIcpScore: 50,
  },
  performance_marketing: {
    type: 'performance_marketing',
    firstName: 'Sarah',
    fullName: 'Sarah Martinez',
    role: 'Performance Marketing Manager',
    description: 'Manages paid advertising, campaign analytics, and performance optimization',
    avatar: '/agent-avatars/performance.png',
    color: '#ec4899',
    emoji: '📊',
    hireAction: 'HIRE_PERFORMANCE',
    hireMessage: 'Hire Sarah for performance marketing',
    shortLabel: 'Performance',
    displayName: 'Performance Marketing Manager Sarah',
    switchLabel: 'Sarah (Performance)',
    toolLabel: '📊 Performance Marketing (Sarah)',
    requiredIcpScore: 50,
  },
};

// ── Accessor Helpers ───────────────────────────────────────────────────────────

export function getPersona(agentType: string): AgentPersona {
  return AGENT_PERSONAS[agentType] || AGENT_PERSONAS.orchestrator;
}

export function getDisplayName(agentType: string): string {
  return getPersona(agentType).displayName;
}

// ── Pre-built Maps (for hot paths that need a plain object) ────────────────────

/** Used by icpExecutor.ts suggest_agents */
export const AGENT_DESC_MAP: Record<string, { name: string; role: string; desc: string; label: string; action: string; agentType: string }> = {
  lead_generation: {
    name: AGENT_PERSONAS.lead_generation.fullName,
    role: AGENT_PERSONAS.lead_generation.role,
    desc: 'finds & qualifies leads using LinkedIn, Google Maps, JustDial, and social platforms',
    label: 'Hire Lead Generation',
    action: AGENT_PERSONAS.lead_generation.hireAction,
    agentType: 'lead_generation',
  },
  content_studio: {
    name: AGENT_PERSONAS.content_studio.fullName,
    role: AGENT_PERSONAS.content_studio.role,
    desc: 'creates social posts, emails, ad copy, images, and videos',
    label: 'Hire Content Studio',
    action: AGENT_PERSONAS.content_studio.hireAction,
    agentType: 'content_studio',
  },
  outreach: {
    name: AGENT_PERSONAS.outreach.fullName,
    role: AGENT_PERSONAS.outreach.role,
    desc: 'runs multi-channel outreach via email, SMS, WhatsApp, and Instagram',
    label: 'Hire Outreach',
    action: AGENT_PERSONAS.outreach.hireAction,
    agentType: 'outreach',
  },
  performance_marketing: {
    name: AGENT_PERSONAS.performance_marketing.fullName,
    role: AGENT_PERSONAS.performance_marketing.role,
    desc: 'manages paid ads on Meta and Google for maximum ROI',
    label: 'Hire Performance Marketing',
    action: AGENT_PERSONAS.performance_marketing.hireAction,
    agentType: 'performance_marketing',
  },
};

/**
 * Build name → agentType lookup for natural language hire detection.
 * Includes first names, full names, and common aliases (all lowercase).
 */
export function buildAgentNameMap(): Record<string, AgentPersonaType> {
  const map: Record<string, AgentPersonaType> = {};

  for (const [, persona] of Object.entries(AGENT_PERSONAS)) {
    const t = persona.type;
    map[persona.firstName.toLowerCase()] = t;
    if (persona.fullName !== persona.firstName) {
      map[persona.fullName.toLowerCase()] = t;
    }
  }

  // Common aliases
  map['lead generation'] = 'lead_generation';
  map['lead agent'] = 'lead_generation';
  map['leads agent'] = 'lead_generation';
  map['leads'] = 'lead_generation';
  map['lead'] = 'lead_generation';
  map['content creation'] = 'content_studio';
  map['content studio'] = 'content_studio';
  map['content agent'] = 'content_studio';
  map['content'] = 'content_studio';
  map['creative content strategist'] = 'content_studio';
  map['content strategist'] = 'content_studio';
  map['ad campaign manager'] = 'performance_marketing';
  map['outreach'] = 'outreach';
  map['outreach agent'] = 'outreach';
  map['email agent'] = 'outreach';
  map['performance marketing'] = 'performance_marketing';
  map['performance agent'] = 'performance_marketing';
  map['marketing agent'] = 'performance_marketing';
  map['ads agent'] = 'performance_marketing';
  map['icp'] = 'icp_generation';
  map['icp agent'] = 'icp_generation';
  map['ideal customer profile'] = 'icp_generation';

  return map;
}

