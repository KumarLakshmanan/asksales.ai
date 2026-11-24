import { describe, expect, it } from 'vitest';
import { policyValidationMessage } from '@/lib/support-policy-rules';
import { createSupportPolicyRule, replaceSupportPolicyRules, supportPolicyRules } from '@/lib/support-runtime-options';

describe('owner Support AI policy editor validation', () => {
  it('accepts the documented fixed-window policy contract', () => {
    expect(policyValidationMessage([{
      id: 'owner-rate',
      type: 'rate_limit',
      enabled: true,
      config: { limit: 15, windowSeconds: 3600, action: 'escalate' },
    }])).toBeNull();
  });

  it('rejects legacy aliases and malformed operating hours', () => {
    expect(policyValidationMessage([{
      id: 'legacy-rate',
      type: 'rate_limit',
      enabled: true,
      config: { maxMessages: 15, windowMinutes: 60 },
    }])).not.toBeNull();
    expect(policyValidationMessage([{
      id: 'hours',
      type: 'operating_hours',
      enabled: true,
      config: {
        timezone: 'Asia/Kolkata',
        start: '9:00',
        end: '18:00',
        outsideHoursAction: 'auto_reply_with_hours',
      },
    }])).not.toBeNull();
  });

  it('creates client-editable defaults and preserves surrounding policy metadata', () => {
    const rule = createSupportPolicyRule('operating_hours', 2);
    const next = replaceSupportPolicyRules({ schemaVersion: 1, rules: [] }, [rule]);

    expect(policyValidationMessage(next)).toBeNull();
    expect((next as { schemaVersion: number }).schemaVersion).toBe(1);
    expect(supportPolicyRules(next)).toEqual([rule]);
  });
});
