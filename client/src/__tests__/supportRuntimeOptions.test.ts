import { describe, expect, it } from 'vitest';
import {
  SUPPORT_CHANNEL_OPTIONS,
  SUPPORT_TOOL_OPTIONS,
  supportToolsForAgent,
  supportPolicyRuleSummary,
  supportPolicyRules,
} from '@/lib/support-runtime-options';

describe('support runtime presentation', () => {
  it('presents every supported channel and unique tool once', () => {
    expect(SUPPORT_CHANNEL_OPTIONS.map((item) => item.value)).toContain('web');
    expect(new Set(SUPPORT_TOOL_OPTIONS.map((item) => item.value)).size).toBe(SUPPORT_TOOL_OPTIONS.length);
  });

  it('shows only the specialist preset plus any explicitly enabled custom tool', () => {
    const techTools = supportToolsForAgent('tech_support').map((item) => item.value);
    expect(techTools).toContain('create_support_ticket');
    expect(techTools).not.toContain('create_booking');
    expect(supportToolsForAgent('tech_support', ['create_booking']).map((item) => item.value))
      .toContain('create_booking');
  });

  it('normalizes wrapped policy rules and creates a useful summary', () => {
    const rules = supportPolicyRules({ rules: [{
      id: 'confidence', type: 'escalation_threshold', enabled: true, config: { threshold: 0.75 },
    }] });
    expect(rules).toHaveLength(1);
    expect(supportPolicyRuleSummary(rules[0])).toBe('Hand off below 75% confidence');
  });
});
