import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const resolveContentBrandContext = jest.fn(async (
  _userId: number,
  _selection: { businessProfileId?: number; brandToolkitId?: number },
) => ({
  businessProfile: { id: 12, companyName: 'Acme' },
  brandToolkit: { id: 34, name: 'Acme Brand' },
  provenance: { schemaVersion: 1 },
}));

jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({
  resolveContentBrandContext,
  formatContentBrandContext: jest.fn(() => '<approved-context />'),
  brandContextSnapshot: jest.fn((context: Record<string, unknown>) => ({
    businessProfile: context.businessProfile,
    brandToolkit: context.brandToolkit,
    provenance: context.provenance,
  })),
}));

const registry = await import('../mastra/tools/canonicalToolRegistry.js');

describe('canonical widget brand context', () => {
  beforeEach(() => {
    resolveContentBrandContext.mockClear();
  });

  it('rehydrates approved brand context immediately before delayed content execution', async () => {
    const execute = jest.fn(async (_args: unknown, runtime: any) => runtime.mastra.__toolContext);
    const originalTool = registry.canonicalWidgetTools.generate_social_media_post;
    registry.canonicalWidgetTools.generate_social_media_post = {
      inputSchema: { parse: (value: unknown) => value },
      execute,
    };

    try {
      const result = await registry.executeCanonicalWidgetTool(
        'generate_social_media_post',
        { topic: 'Launch' },
        {
          userId: 7,
          threadId: 21,
          companyProfile: { id: 12 } as any,
          brandToolkit: { id: 34 } as any,
        },
      );

      expect(resolveContentBrandContext).toHaveBeenCalledWith(7, {
        businessProfileId: 12,
        brandToolkitId: 34,
      });
      expect(result.brandContextPrompt).toBe('<approved-context />');
      expect(result.brandContextSnapshot).toEqual(expect.objectContaining({
        businessProfile: expect.objectContaining({ id: 12 }),
        brandToolkit: expect.objectContaining({ id: 34 }),
        provenance: expect.objectContaining({ schemaVersion: 1 }),
      }));
    } finally {
      registry.canonicalWidgetTools.generate_social_media_post = originalTool;
    }
  });
});
