import { createLeadAgent } from '../mastra/agents/leadAgent.js';
import { createOutreachAgent } from '../mastra/agents/outreachAgent.js';
import { createContentAgent } from '../mastra/agents/contentAgent.js';
import { createPerformanceAgent } from '../mastra/agents/performanceAgent.js';

describe('specialist agent run isolation', () => {
  test.each([
    ['lead', createLeadAgent],
    ['outreach', createOutreachAgent],
    ['content', createContentAgent],
    ['performance', createPerformanceAgent],
  ])('%s conversations receive independent agent instances', async (_name, createAgent) => {
    const [first, second] = await Promise.all([
      Promise.resolve().then(createAgent),
      Promise.resolve().then(createAgent),
    ]);

    expect(first).not.toBe(second);

    // Agent hooks keep transient approval and generated-resource fields on the
    // instance. A marker written by one concurrent run must never be observable
    // by another conversation's instance.
    (first as unknown as Record<string, unknown>).__concurrencyMarker = 'thread-a';
    expect((second as unknown as Record<string, unknown>).__concurrencyMarker).toBeUndefined();
  });
});
