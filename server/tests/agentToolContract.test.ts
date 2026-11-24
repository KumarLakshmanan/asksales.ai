import { describe, expect, test } from '@jest/globals';
import { agentToolMapping, toolMetadata } from '../mastra/tools/toolRegistry.js';
import { createLeadAgent } from '../mastra/agents/leadAgent.js';
import { createOutreachAgent } from '../mastra/agents/outreachAgent.js';
import { createContentAgent } from '../mastra/agents/contentAgent.js';
import { createPerformanceAgent } from '../mastra/agents/performanceAgent.js';
import { ICP_OPENAI_TOOL_NAMES } from '../mastra/agents/icpAgent.js';
import type { AgentType } from '../mastra/state.js';

type RuntimeAgent = {
  getTools(context: Record<string, never>): Record<string, unknown>;
};

const specialistFactories: Array<[AgentType, () => unknown]> = [
  ['lead_generation', createLeadAgent],
  ['content_studio', createContentAgent],
  ['outreach', createOutreachAgent],
  ['performance_marketing', createPerformanceAgent],
];

describe('authoritative agent tool contract', () => {
  test.each(specialistFactories)('%s prompt mapping matches its runtime tools', (agentType, factory) => {
    const runtimeTools = Object.keys((factory() as RuntimeAgent).getTools({})).sort();
    expect(runtimeTools).toEqual([...agentToolMapping[agentType]].sort());
  });

  test('ICP prompt mapping matches its provider tool definitions', () => {
    expect([...ICP_OPENAI_TOOL_NAMES].sort()).toEqual([...agentToolMapping.icp_generation].sort());
  });

  test('every mapped assignment is authorized by tool metadata', () => {
    for (const [agentType, tools] of Object.entries(agentToolMapping) as Array<[AgentType, string[]]>) {
      for (const toolName of tools) {
        expect(toolMetadata[toolName]).toBeDefined();
        expect(toolMetadata[toolName].agents).toContain(agentType);
      }
    }
  });
});
