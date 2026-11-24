import { describe, expect, it, jest } from '@jest/globals';

// Selecting knowledge sources must let the assistant answer from them even
// when the owner left the tool list empty; retrieval stays source-scoped.
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: jest.fn() } }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({
  requireBusinessScope: () => ({ userId: 9, businessProfileId: 7 }),
  currentBusinessScope: () => ({ userId: 9, businessProfileId: 7 }),
}));
jest.unstable_mockModule('../services/assistants/AssistantContext.js', () => ({
  assistantsRuntimeEnabled: () => true,
  freezeAssistant: (value: unknown) => value,
}));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({
  assistantProvenanceCurrent: jest.fn(), assertAssistantFresh: jest.fn(),
}));
jest.unstable_mockModule('../services/assistants/AssistantService.js', () => ({ assistantRow: jest.fn() }));
jest.unstable_mockModule('../services/assistants/AssistantCatalogService.js', () => ({
  assistantCatalog: jest.fn(), assistantPlatformReadiness: jest.fn(),
}));
jest.unstable_mockModule('../services/assistants/AssistantConfiguration.js', () => ({
  assistantReadiness: jest.fn(), parseAssistantDraft: (value: unknown) => value,
}));
const { assistantAgentConfig } = await import('../services/assistants/AssistantResolver.js');

const configuration = (knowledgeIds: number[], tools: string[]) => ({
  agentType: 'tech_support', name: 'Support', description: '', instructions: 'Help.',
  knowledge: { mode: knowledgeIds.length ? 'selected' : 'none', ids: knowledgeIds },
  tools: { mode: tools.length ? 'selected' : 'none', names: tools, approvalRequired: [] },
  privacy: { uncertaintyMessage: 'Not sure.', minimumConfidence: 0.75 },
  policies: { rules: [] }, bindings: [], demonstrations: [],
}) as never;

describe('assistantAgentConfig knowledge tool', () => {
  it('enables the read-only knowledge tool when knowledge sources are selected', () => {
    expect(assistantAgentConfig(configuration([28], []), 'a1').toolsEnabled).toEqual(['answer_from_knowledge_base']);
    expect(assistantAgentConfig(configuration([28], ['escalate_to_human']), 'a1').toolsEnabled)
      .toEqual(['escalate_to_human', 'answer_from_knowledge_base']);
  });
  it('does not add the tool twice or without selected knowledge', () => {
    expect(assistantAgentConfig(configuration([28], ['answer_from_knowledge_base']), 'a1').toolsEnabled).toEqual(['answer_from_knowledge_base']);
    expect(assistantAgentConfig(configuration([], []), 'a1').toolsEnabled).toEqual([]);
  });
});
