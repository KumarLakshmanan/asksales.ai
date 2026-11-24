/**
 * Agent Switch Helper Tests
 * Tests: dismiss button, action button generation, agent display info
 * 
 * Logic replicated from: langgraph/utils/agentSwitchHelper.ts
 */
import { describe, it, expect } from '@jest/globals';

// ─── Replicated types from state.ts ─────────────────────────────────────────
type AgentType = 'orchestrator' | 'supervisor' | 'icp_generation' | 'lead_generation' | 'content_studio' | 'outreach' | 'performance_marketing';

interface ActionButton {
  id: string;
  label: string;
  action: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: Record<string, any>;
  type?: 'primary' | 'secondary' | 'danger';
}

interface SuggestSwitchResult {
  success: boolean;
  toolName: 'suggest_switch_agents';
  targetAgent: AgentType;
  message: string;
  primaryAgentLabel: string;
  alternativeAgents: AgentType[];
  alternativeAgentLabels: string[];
  reason: string;
}

// ─── Replicated logic from agentSwitchHelper.ts ──────────────────────────────

const AGENT_DISPLAY: Record<string, { emoji: string; label: string; action: string }> = {
  content_studio: { emoji: '🎨', label: 'Content Studio', action: 'switch_content' },
  lead_generation: { emoji: '🎯', label: 'Lead Gen', action: 'switch_leads' },
  outreach: { emoji: '📧', label: 'Outreach', action: 'switch_outreach' },
  performance_marketing: { emoji: '📊', label: 'Performance', action: 'switch_performance' },
};

function buildActionButtons(
  targetAgent: AgentType,
  alternativeAgents: AgentType[],
  callingAgentType: AgentType
): ActionButton[] {
  const actionButtons: ActionButton[] = [];

  const primaryInfo = AGENT_DISPLAY[targetAgent];
  if (primaryInfo) {
    actionButtons.push({
      id: `hire_${targetAgent}`,
      label: `${primaryInfo.emoji} Hire ${primaryInfo.label}`,
      action: primaryInfo.action,
      type: 'primary',
      data: { agentType: targetAgent },
    });
  }

  for (const altAgent of alternativeAgents) {
    const altInfo = AGENT_DISPLAY[altAgent];
    if (altInfo) {
      actionButtons.push({
        id: `hire_${altAgent}`,
        label: `${altInfo.emoji} ${altInfo.label}`,
        action: altInfo.action,
        type: 'secondary',
        data: { agentType: altAgent },
      });
    }
  }

  // Add dismiss option
  actionButtons.push({
    id: 'dismiss_suggestion',
    label: 'Keep current agent',
    action: 'dismiss',
    type: 'secondary',
    data: { agentType: callingAgentType },
  });

  return actionButtons;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Agent Switch Helper', () => {
  describe('buildActionButtons', () => {
    it('should always include a dismiss button', () => {
      const buttons = buildActionButtons('content_studio', [], 'orchestrator');
      const dismissBtn = buttons.find(b => b.id === 'dismiss_suggestion');
      expect(dismissBtn).toBeDefined();
      expect(dismissBtn?.label).toBe('Keep current agent');
      expect(dismissBtn?.action).toBe('dismiss');
    });

    it('should include primary agent button with "Hire" label', () => {
      const buttons = buildActionButtons('content_studio', [], 'orchestrator');
      const primaryBtn = buttons.find(b => b.id === 'hire_content_studio');
      expect(primaryBtn).toBeDefined();
      expect(primaryBtn?.label).toContain('Hire');
      expect(primaryBtn?.label).toContain('Content Studio');
      expect(primaryBtn?.type).toBe('primary');
    });

    it('should include alternative agent buttons', () => {
      const buttons = buildActionButtons(
        'content_studio',
        ['lead_generation', 'outreach'],
        'orchestrator'
      );
      
      expect(buttons.find(b => b.id === 'hire_lead_generation')).toBeDefined();
      expect(buttons.find(b => b.id === 'hire_outreach')).toBeDefined();
    });

    it('should mark alternative buttons as secondary type', () => {
      const buttons = buildActionButtons(
        'content_studio',
        ['lead_generation'],
        'orchestrator'
      );
      
      const altBtn = buttons.find(b => b.id === 'hire_lead_generation');
      expect(altBtn?.type).toBe('secondary');
    });

    it('should include calling agent type in dismiss button data', () => {
      const buttons = buildActionButtons('content_studio', [], 'lead_generation');
      const dismissBtn = buttons.find(b => b.id === 'dismiss_suggestion');
      expect(dismissBtn?.data?.agentType).toBe('lead_generation');
    });

    it('should include target agent type in primary button data', () => {
      const buttons = buildActionButtons('content_studio', [], 'orchestrator');
      const primaryBtn = buttons.find(b => b.id === 'hire_content_studio');
      expect(primaryBtn?.data?.agentType).toBe('content_studio');
    });

    it('should handle empty alternative agents list', () => {
      const buttons = buildActionButtons('content_studio', [], 'orchestrator');
      // Should have primary + dismiss (2 buttons total)
      expect(buttons.length).toBe(2);
    });

    it('should skip unknown agent types gracefully', () => {
      const buttons = buildActionButtons(
        'unknown_agent' as AgentType,
        ['also_unknown' as AgentType],
        'orchestrator'
      );
      // Only dismiss button should be present
      expect(buttons.length).toBe(1);
      expect(buttons[0].id).toBe('dismiss_suggestion');
    });

    it('should include emojis in button labels', () => {
      const buttons = buildActionButtons('content_studio', ['lead_generation'], 'orchestrator');
      expect(buttons[0].label).toMatch(/^🎨/);
      expect(buttons[1].label).toMatch(/^🎯/);
    });
  });

  describe('SuggestSwitchResult type', () => {
    it('should define targetAgent as AgentType', () => {
      const result: SuggestSwitchResult = {
        success: true,
        toolName: 'suggest_switch_agents',
        targetAgent: 'content_studio',
        message: 'Switch to content',
        primaryAgentLabel: 'Content Studio',
        alternativeAgents: [],
        alternativeAgentLabels: [],
        reason: 'Better suited',
      };
      expect(result.targetAgent).toBe('content_studio');
    });

    it('should have alternativeAgents as array', () => {
      const result: SuggestSwitchResult = {
        success: true,
        toolName: 'suggest_switch_agents',
        targetAgent: 'content_studio',
        message: 'Switch to content',
        primaryAgentLabel: 'Content Studio',
        alternativeAgents: ['lead_generation', 'outreach'],
        alternativeAgentLabels: ['Lead Gen', 'Outreach'],
        reason: 'Better suited',
      };
      expect(result.alternativeAgents).toHaveLength(2);
    });
  });
});
