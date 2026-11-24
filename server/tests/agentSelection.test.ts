import { describe, expect, it } from '@jest/globals';
import { buildApprovedIcpAgentSelection, icpAgentRecommendationSentence } from '../mastra/agentSelection.js';

describe('post-ICP agent selection', () => {
  it('offers Emily for an outreach-only pipeline without suggesting a lead search', () => {
    const result = buildApprovedIcpAgentSelection({ agentPipeline: ['icp_generation', 'outreach'] });
    expect(result.recommendedAgents).toEqual(['outreach']);
    expect(result.actionButtons.map(button => button.action)).toEqual(['HIRE_OUTREACH', 'OPEN_TAB']);
  });
  it.each([undefined, [], ['icp_generation'] as const])('offers all specialists when no team is selected: %j', pipeline => {
    const result = buildApprovedIcpAgentSelection({ agentPipeline: pipeline ? [...pipeline] : undefined });
    expect(result.recommendedAgents).toEqual(['lead_generation', 'content_studio', 'outreach', 'performance_marketing']);
    expect(result.actionButtons).toContainEqual(expect.objectContaining({ action: 'OPEN_TAB', data: { tabType: 'agentchoose' } }));
  });
  it('preserves the selected specialist set and does not combine it into an execution command', () => {
    const result = buildApprovedIcpAgentSelection({ agentPipeline: ['content_studio', 'outreach'] });
    expect(result.recommendedAgents).toEqual(['content_studio', 'outreach']);
    expect(result.actionButtons.map(button => button.action)).toEqual(['HIRE_CONTENT_STUDIO', 'HIRE_OUTREACH', 'OPEN_TAB']);
  });
  it('orders the choices by ICP match when no team is selected', () => {
    const scores = { lead_generation: 92, outreach: 85, content_studio: 40, performance_marketing: 0 };
    const result = buildApprovedIcpAgentSelection({ agentPipeline: [] }, scores);
    expect(result.recommendedAgents).toEqual(['lead_generation', 'outreach', 'content_studio']);
    expect(result.actionButtons.map(button => button.action)).toEqual(['HIRE_LEAD_GEN', 'HIRE_OUTREACH', 'HIRE_CONTENT_STUDIO', 'HIRE_PERFORMANCE', 'OPEN_TAB']);
    expect(result.actionButtons[0].type).toBe('primary');
    expect(icpAgentRecommendationSentence(scores)).toBe('For this ICP I recommend starting with **Marcus (Lead Generation), 92% match**, then Emily (Outreach), 85% match and Alex (Content Studio), 40% match.');
  });
  it('keeps a selected team over ICP scores and says nothing without scores', () => {
    const result = buildApprovedIcpAgentSelection({ agentPipeline: ['outreach'] }, { lead_generation: 99, outreach: 10 });
    expect(result.recommendedAgents).toEqual(['outreach']);
    expect(icpAgentRecommendationSentence(null)).toBeNull();
    expect(icpAgentRecommendationSentence({ outreach: 0 })).toBeNull();
  });
});
