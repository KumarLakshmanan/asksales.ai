import { buildIcpSystemPrompt } from '../mastra/agents/icpAgent.js';
import { getICPGeneratorPromptWithContext } from '../services/promptTemplates.js';
import { ICP_CHANNEL_SELECTION_POLICY } from '../utils/icpChannelPolicy.js';
import type { AgentState } from '../mastra/state.js';

describe('ICP explicit channel scope', () => {
  it.each([
    ['specialist', () => buildIcpSystemPrompt({} as AgentState)],
    ['structured generator', () => getICPGeneratorPromptWithContext()],
    ['profile refinement', () => getICPGeneratorPromptWithContext({ primaryChannels: ['google_maps'] }, { platforms: ['justdial'] })],
  ] as const)('%s uses the same explicit-selection policy without mandatory channel expansion', (_name, makePrompt) => {
    const prompt = makePrompt();
    expect(prompt).toContain(ICP_CHANNEL_SELECTION_POLICY);
    expect(prompt).not.toMatch(/ALWAYS include BOTH|Never use only "google_maps"/);
    expect(prompt).toContain('cafes in Coimbatore using only Google Maps Business Search" -> ["google_maps"]');
    expect(prompt).toContain('Unrelated ICP edits must preserve the previously selected channels');
  });
});
