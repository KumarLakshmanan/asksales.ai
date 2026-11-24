import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('performance campaign review contract', () => {
  it('does not let disconnected providers suppress the requested review widget', () => {
    const prompt = readFileSync(resolve(process.cwd(), 'mastra/agents/performanceAgent.ts'), 'utf8');
    expect(prompt).toContain('A disconnected provider MUST NOT prevent creation of the requested Meta + Google review');
    expect(prompt).toContain('Do not substitute check_integration_status for publish_ads');
    expect(prompt).toContain('Always include all platforms the user requested even if one is disconnected');
    expect(prompt).toContain('Do not generate another variation unless a newer explicit user message requests one');
    expect(prompt).toContain('call publish_ads for all requested platforms next');
    expect(prompt).toContain('Generate only a requested platform that is still missing');
    expect(prompt).toContain('Never choose one campaign from earlier context silently');
  });

  it('describes publish_ads as an approval request without provider mutation', () => {
    const tools = readFileSync(resolve(process.cwd(), 'mastra/tools/adsTools.ts'), 'utf8');
    expect(tools).toContain('this tool only requests approval and does not mutate providers');
    expect(tools).toContain("placements: z.array(z.string()).min(1).default(['Automatic'])");
  });

  it('persists the exact reviewed placement choice in the campaign context', () => {
    const executor = readFileSync(resolve(process.cwd(), 'mastra/tools/executors/adsExecutor.ts'), 'utf8');
    expect(executor).toContain("placements: input.placements?.length ? input.placements : ['Automatic']");
  });
});
