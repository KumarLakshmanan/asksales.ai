import { describe, expect, it } from '@jest/globals';
import { DEFAULT_CRM_CONFIGURATION, type CrmConfiguration } from '../../shared/crmConfiguration.js';
import { crmContactStatusForStage, crmLeadStatusForStage, parseCrmStageDecision,
  resolveCrmStageReference, selectAutomaticCrmStage, UNCHANGED_CRM_DECISION } from '../../shared/crmPipeline.js';
import { getInboundReplyTransition } from '../utils/inboundReplyStatus.js';

const configuration: CrmConfiguration = {
  stages: [DEFAULT_CRM_CONFIGURATION.stages[0],
    { key: 'discovery', label: 'Discovery call', type: 'active', color: '#8b5cf6', inFlow: true },
    { key: 'signed', label: 'Contract accepted', type: 'won', color: '#10b981', inFlow: false },
    { key: 'declined', label: 'Offer declined', type: 'lost', color: '#f59e0b', inFlow: true }],
  preferences: DEFAULT_CRM_CONFIGURATION.preferences,
};

describe('configured CRM business outcomes', () => {
  it('updates a custom Won stage even when it is excluded from flow analytics', () => {
    const selected = selectAutomaticCrmStage(configuration, 'discovery', { decision: {
      stageKey: 'signed', outcome: 'won', evidence: 'explicit_acceptance', confidence: 0.99,
    } });
    expect(selected?.key).toBe('signed');
    expect(crmContactStatusForStage(selected!, 'interested')).toBe('won');
    expect(crmLeadStatusForStage(selected, 'interested')).toBe('converted');
  });

  it('does not infer a closed outcome from a label whose type is Active', () => {
    const config = structuredClone(configuration);
    config.stages[2] = { ...config.stages[2], label: 'Won', type: 'active' };
    expect(parseCrmStageDecision({ stageKey: 'signed', outcome: 'won', evidence: 'explicit_acceptance', confidence: 1 },
      { stages: config.stages, currentStageKey: 'discovery' })).toBeUndefined();
    expect(selectAutomaticCrmStage(config, 'discovery', { verifiedOutcome: 'won' })).toBeUndefined();
    expect(crmContactStatusForStage(config.stages[2], 'won')).toBe('contacted');
    expect(crmLeadStatusForStage(config.stages[2], 'won')).toBe('contacted');
  });

  it.each([0.5, 0.9, 0.94])('preserves the stage for uncertain acceptance at confidence %s', confidence => {
    expect(selectAutomaticCrmStage(configuration, 'discovery', { decision: {
      stageKey: 'signed', outcome: 'won', evidence: 'explicit_acceptance', confidence,
    } })).toBeUndefined();
  });

  it('uses explicit rejection for a custom Lost outcome', () => {
    const selected = selectAutomaticCrmStage(configuration, 'discovery', { decision: {
      stageKey: 'declined', outcome: 'lost', evidence: 'explicit_rejection', confidence: 0.98,
    } });
    expect(selected?.key).toBe('declined');
    expect(crmContactStatusForStage(selected!, 'interested')).toBe('lost');
    expect(crmLeadStatusForStage(selected, 'interested')).toBe('lost');
  });

  it.each(['signed', 'declined'])('routine support replies cannot reopen %s', current => {
    expect(selectAutomaticCrmStage(configuration, current, { decision: {
      stageKey: 'discovery', outcome: 'active', evidence: 'progress', confidence: 1,
    }, legacyStage: 'ticket_open' })?.key).toBe(current);
    expect(getInboundReplyTransition('interested', current, configuration)).toEqual({
      status: current === 'signed' ? 'won' : 'lost', pipelineStatus: current,
    });
  });

  it('does not let an older specialist hint override a validated unchanged decision', () => {
    expect(selectAutomaticCrmStage(configuration, 'discovery', {
      decision: UNCHANGED_CRM_DECISION, legacyStage: 'won',
    })).toBeUndefined();
    expect(selectAutomaticCrmStage(configuration, 'discovery', { legacyStage: 'won' })).toBeUndefined();
  });

  it('advances genuine inbound replies into a configured active stage and preserves mature stages', () => {
    expect(getInboundReplyTransition('new', 'new', configuration)).toEqual({ status: 'replied', pipelineStatus: 'discovery' });
    expect(getInboundReplyTransition('interested', 'discovery', configuration)).toEqual({ status: 'interested', pipelineStatus: 'discovery' });
    expect(resolveCrmStageReference(configuration.stages, 'CONTRACT ACCEPTED')?.key).toBe('signed');
    expect(resolveCrmStageReference(DEFAULT_CRM_CONFIGURATION.stages, 'negotiation')?.key).toBe('negotiations');
    expect(resolveCrmStageReference(DEFAULT_CRM_CONFIGURATION.stages, 'ticket_closed')?.key).toBe('ticket_close');
  });
});
