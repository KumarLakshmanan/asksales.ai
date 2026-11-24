import { describe, expect, it } from '@jest/globals';
import { manualSequenceStepsProblem } from '../../shared/campaignManualFollowUps.js';
import { validateManualSteps } from '../services/outreach/CampaignManualFollowUpService.js';

describe('campaign manual sequence step rule (shared by editor and server)', () => {
  it('names why a sequence cannot be saved', () => {
    expect(manualSequenceStepsProblem('manual', [])).toBe('steps');
    expect(manualSequenceStepsProblem('off', [{ delayMinutes: 60, templateId: 1 }])).toBe('steps');
    expect(manualSequenceStepsProblem('manual', [{ delayMinutes: 1440, templateId: 0 }])).toBe('template');
    expect(manualSequenceStepsProblem('manual', [{ delayMinutes: 120, templateId: 1 }, { delayMinutes: 60, templateId: 2 }])).toBe('delay');
    expect(manualSequenceStepsProblem('manual', [{ delayMinutes: 129601, templateId: 1 }])).toBe('delay');
    expect(manualSequenceStepsProblem('manual', [{ delayMinutes: 60, templateId: 1 }, { delayMinutes: 1440, templateId: 2 }])).toBeNull();
    expect(manualSequenceStepsProblem('off', [])).toBeNull();
  });

  it('keeps the server error messages unchanged', () => {
    expect(() => validateManualSteps('manual', [])).toThrow('Choose manual with one to three template steps, or off with no steps.');
    expect(() => validateManualSteps('manual', [{ delayMinutes: 60, templateId: 0 }]))
      .toThrow('Select approved templates and increasing times within 90 days of the initial message.');
    expect(() => validateManualSteps('manual', [{ delayMinutes: 60, templateId: 3 }])).not.toThrow();
  });
});
