import { describe, expect, it } from '@jest/globals';
import { buildPipelineStatusPrompt, pipelineAgentLabel } from '../mastra/utils/pipelinePrompt.js';
import { getPersona } from '../mastra/agentPersonas.js';

const options = {
  workLabel: 'lead generation',
  handoffExample: (nextName: string) => `Over to ${nextName}.`,
};

describe('specialist pipeline status prompt', () => {
  it('names teammates exactly as the chat displays them', () => {
    for (const agent of ['lead_generation', 'content_studio', 'outreach', 'performance_marketing']) {
      expect(pipelineAgentLabel(agent)).toContain(getPersona(agent).firstName);
    }
    const prompt = buildPipelineStatusPrompt({
      agentPipeline: ['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'],
      agentPipelineIndex: 1,
    }, options);
    expect(prompt).toContain('Marcus');
    expect(prompt).toContain('Alex');
    expect(prompt).toContain('Emily');
    expect(prompt).toContain('Sarah');
    expect(prompt).not.toMatch(/Sophia|Priya/);
  });

  it('hands off to the next teammate by its displayed name', () => {
    const prompt = buildPipelineStatusPrompt({
      agentPipeline: ['lead_generation', 'content_studio'], agentPipelineIndex: 0,
    }, options);
    expect(prompt).toContain('← YOU ARE HERE');
    expect(prompt).toContain(`hand off to the next agent: ${pipelineAgentLabel('content_studio')}`);
    expect(prompt).toContain(`Over to ${pipelineAgentLabel('content_studio')}.`);
  });

  it('does not ask the last agent to hand off, and is empty without a pipeline', () => {
    const last = buildPipelineStatusPrompt({
      agentPipeline: ['lead_generation', 'content_studio'], agentPipelineIndex: 1,
    }, options);
    expect(last).toContain('LAST agent in the pipeline');
    expect(last).not.toContain('hand off to the next agent');
    expect(buildPipelineStatusPrompt({ agentPipeline: [], agentPipelineIndex: 0 }, options)).toBe('');
  });
});
