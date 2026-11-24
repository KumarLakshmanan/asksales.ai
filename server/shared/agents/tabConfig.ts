/**
 * Tab Configuration for Agent ↔ Frontend Tab Mapping
 * 
 * Central source of truth for which tabs to open when agents are hired/transitioned,
 * and which tabs to open when specific tools execute.
 * 
 * Both the server (LangGraph nodes/executors) and client (conversations page)
 * should reference these mappings to keep tab behavior consistent.
 */

import type { AgentType } from './state';
import {
  CONTENT_TAB_INITIAL_MAP,
  CONTENT_TAB_TYPE_MAP,
  HEADER_AGENT_TAB_MAP,
  LEGACY_TAB_ALIASES,
  TAB_LABELS,
  TAB_TYPES,
  VALID_TAB_TYPES,
  getTabLabel,
  normalizeTabType,
  type TabType,
} from '../../../shared/conversationTabRegistry.ts';

export {
  CONTENT_TAB_INITIAL_MAP,
  CONTENT_TAB_TYPE_MAP,
  HEADER_AGENT_TAB_MAP,
  LEGACY_TAB_ALIASES,
  TAB_LABELS,
  TAB_TYPES,
  VALID_TAB_TYPES,
  getTabLabel,
  normalizeTabType,
  type TabType,
};

// ── Agent → Tab Mapping ────────────────────────────────────────────────────────
// When an agent is hired/transitioned to, these tabs should be opened automatically
// so the user can see the agent's workspace immediately.

export interface AgentTabConfig {
  /** Primary tab to open when this agent starts */
  tabType: string;
  /** Label for the tab */
  tabLabel: string;
  /** Additional tabs to open (if any) */
  additionalTabs?: Array<{ tabType: string; tabLabel: string }>;
}

export const AGENT_TAB_MAP: Record<AgentType, AgentTabConfig> = {
  icp_generation: {
    tabType: TAB_TYPES.ICP,
    tabLabel: TAB_LABELS[TAB_TYPES.ICP],
  },
  lead_generation: {
    tabType: TAB_TYPES.LEADS,
    tabLabel: TAB_LABELS[TAB_TYPES.LEADS],
  },
  content_studio: {
    tabType: TAB_TYPES.CONTENT_STUDIO,
    tabLabel: TAB_LABELS[TAB_TYPES.CONTENT_STUDIO],
  },
  outreach: {
    tabType: TAB_TYPES.OUTREACH,
    tabLabel: TAB_LABELS[TAB_TYPES.OUTREACH],
  },
  performance_marketing: {
    tabType: TAB_TYPES.PERFORMANCE_MARKETING,
    tabLabel: TAB_LABELS[TAB_TYPES.PERFORMANCE_MARKETING],
  },
  // orchestrator and supervisor don't have their own tabs
  orchestrator: {
    tabType: TAB_TYPES.OVERVIEW,
    tabLabel: TAB_LABELS[TAB_TYPES.OVERVIEW],
  },
  supervisor: {
    tabType: TAB_TYPES.OVERVIEW,
    tabLabel: TAB_LABELS[TAB_TYPES.OVERVIEW],
  },
};

// ── Tool → Tab Mapping ─────────────────────────────────────────────────────────
// When a tool finishes execution, these tabs should be opened to show results.

export interface ToolTabConfig {
  tabType: string;
  tabLabel: string;
}


// ── Agent Hire Tab Mapping (for client-side hire button) ───────────────────────
// Maps agent IDs (from the UI hire button) to the tab type and the natural language hire message.
// Hire messages sourced from centralized agentPersonas.ts

import { AGENT_PERSONAS } from './agentPersonas';

export const AGENT_HIRE_TAB_MAP: Record<string, { tabType: string; message: string }> = {
  'lead-generation': { tabType: TAB_TYPES.LEADS, message: AGENT_PERSONAS.lead_generation.hireMessage },
  'content-studio': { tabType: TAB_TYPES.CONTENT_STUDIO, message: AGENT_PERSONAS.content_studio.hireMessage },
  'outreach': { tabType: TAB_TYPES.OUTREACH, message: AGENT_PERSONAS.outreach.hireMessage },
  'performance-marketing': { tabType: TAB_TYPES.PERFORMANCE_MARKETING, message: AGENT_PERSONAS.performance_marketing.hireMessage },
  'icp-generation': { tabType: TAB_TYPES.AGENT_CHOOSE, message: AGENT_PERSONAS.icp_generation.hireMessage },
};

