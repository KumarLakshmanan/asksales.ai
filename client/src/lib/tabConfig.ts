/**
 * Tab Configuration for Chat Sidebar Tabs
 * 
 * Client-facing re-export of the shared conversation tab registry, plus
 * browser-only agent navigation mappings.
 * 
 * Used by the conversations page and any component that manages chat sidebar tabs.
 */

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
} from '../../../shared/conversationTabRegistry';

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

// ── Agent Hire Tab Mapping ─────────────────────────────────────────────────────
// Maps agent IDs (from the UI hire button) to the tab type.
// All routing logic is handled by the backend orchestrator.

export const AGENT_HIRE_TAB_MAP: Record<string, { tabType: string }> = {
  'lead-generation': { tabType: TAB_TYPES.LEADS },
  'content-studio': { tabType: TAB_TYPES.CONTENT_STUDIO },
  'outreach': { tabType: TAB_TYPES.OUTREACH },
  'performance-marketing': { tabType: TAB_TYPES.PERFORMANCE_MARKETING },
  'icp-generation': { tabType: TAB_TYPES.AGENT_CHOOSE },
};

