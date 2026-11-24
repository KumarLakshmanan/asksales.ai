import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { MediaQuery, SupportMediaDecision } from '../services/supportMedia/types.js';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';

const queries: Array<{ sql: string; params: unknown[] }> = [];
const relevance = jest.fn(async ({ rows }: { rows: unknown[] }) => rows);
jest.unstable_mockModule('../services/supportMedia/MediaRelevanceSelector.js', () => ({ selectRelevantMediaCandidates: relevance }));
let enabledVector = false;
let current = true;
const row = { id: 30, asset_id: 30, evidence_id: 'MEDIA-2-V1-A30', gallery_id: 2, gallery_version_id: 20,
  name: 'Opal Room', gallery_title: 'Opal Room', owner_description: 'Owner description', alt_text: 'Opal room image',
  owner_tags: ['opal room'], entity_tags: ['opal room'], score: 1, checksum: 'checksum', derivative_storage_file_id: 99, mime_type: 'image/jpeg' };
const execute = jest.fn(async (query: SQL) => {
  const compiled = new PgDialect().sqlToQuery(query);
  queries.push(compiled);
  if (compiled.sql.includes('FROM knowledge_runtime_settings')) return { rows: enabledVector
    ? [{ id: 1, provider: 'openai', model: 'test', dimensions: 3 }] : [] };
  if (compiled.sql.includes('FROM support_media_assets a') || compiled.sql.includes('FROM support_media_asset_embeddings e')) return { rows: current ? [row] : [] };
  return { rows: [] };
});
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute,
  transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({ execute }),
} }));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({ embeddingService: {
  generateEmbedding: jest.fn(async () => ({ dimensions: 3, vector: [0.2, 0.3, 0.4] })),
} }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn(), error: jest.fn() } }));
const { mediaGateway } = await import('../services/supportMedia/MediaGateway.js');
const { MediaRetrievalStage } = await import('../services/agents/pipeline/stages/MediaRetrievalStage.js');
const { MediaSelectionStage } = await import('../services/agents/pipeline/stages/MediaSelectionStage.js');
const query: MediaQuery = { tenantId: 9, businessProfileId: null, channel: 'web', audience: 'customer',
  purpose: 'support_answer', mediaIntent: 'explicit', redactedText: 'Opal Room', limit: 5 };
const decision: SupportMediaDecision = { intent: 'explicit', reason: 'Matched owner image',
  selections: [{ evidenceId: row.evidence_id, caption: 'MODEL CAPTION MUST NOT BE USED', order: 0 }] };
const originalFlag = process.env.SUPPORT_MEDIA_V1_ENABLED;

describe('current media authorization runtime', () => {
  it('fails closed without media when the relevance model is unavailable', async () => {
    relevance.mockRejectedValueOnce(new Error('Provider unavailable'));
    expect((await mediaGateway.retrieve(query)).status).toBe('unavailable');
  });
  beforeEach(() => { delete process.env.SUPPORT_MEDIA_V1_ENABLED; queries.length = 0; current = true; enabledVector = false; jest.clearAllMocks(); });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.SUPPORT_MEDIA_V1_ENABLED;
    else process.env.SUPPORT_MEDIA_V1_ENABLED = originalFlag;
  });

  it.each([
    { readOnlyInformation: true },
    { documentService: 'resort', capability: { name: 'asset.deliver', kind: 'context' } },
  ])('does not substitute room photos for a brochure document request or menu step', async playbookDirective => {
    const ctx = { message: { userId: 9, channel: 'whatsapp', inboundText: 'Please share corporate brochure images' },
      metadata: { playbookDirective }, verifiedMedia: [row],
      mediaRetrieval: { intent: 'explicit', status: 'selected', evidence: [row] },
    } as unknown as PipelineContext;
    await new MediaRetrievalStage().execute(ctx);
    expect(ctx.verifiedMedia).toEqual([]);
    expect(ctx.mediaRetrieval).toBeUndefined();
    expect(queries).toEqual([]);
  });

  it('uses the same tenant/current-version/date/audience/purpose/profile checks in compiled lexical, vector and verification SQL', async () => {
    enabledVector = true;
    expect((await mediaGateway.retrieve(query)).status).toBe('selected');
    const verified = await mediaGateway.verify(9, 'web', decision, query);
    expect(verified[0].caption).toBe('Owner description');
    const reads = queries.filter(item => item.sql.includes('FROM support_media_assets a') || item.sql.includes('FROM support_media_asset_embeddings e'));
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      for (const boundary of [
        'g.user_id =', 'v.user_id = g.user_id AND v.gallery_id = g.id',
        'g.current_published_version_id = v.id', "g.status = 'active' AND v.status = 'published'",
        'v.effective_at <= NOW()', 'v.expires_at > NOW()', 'g.business_profile_id IS NULL',
        "g.audience IN ('customer', 'internal')", 'ANY(g.allowed_channels)', 'ANY(g.usage_scopes)',
        'a.user_id = g.user_id AND a.gallery_id = g.id AND a.gallery_version_id = v.id',
        "a.publication_state = 'published' AND a.retired_at IS NULL",
        "a.sensitivity IN ('public', 'business', 'internal')",
      ]) expect(read.sql).toContain(boundary);
      expect(read.params).toContain(9);
      expect(read.params).toContain('web');
      expect(read.params).toContain('customer');
      expect(read.params).toContain('support_answer');
      expect(read.sql).not.toContain('::INTEGER IS NULL OR g.business_profile_id');
    }
  });
  it('retrieves explicitly requested public media while a read-only playbook blocks personal-data intake', async () => {
    const ctx = { message: { userId: 9, channel: 'whatsapp', inboundText: 'Show Opal Room photos', metadata: {} },
      metadata: { businessProfileId: 42, playbookDirective: { nodeId: 'privacy-blocked', readOnlyInformation: true } },
      nlu: { intent: 'faq', semanticRequest: { action: 'information', service: 'stay', explicit: true,
        topicSwitch: false, pricingRequested: false, media: 'explicit', confidence: 0.99 } },
    } as unknown as PipelineContext;
    await new MediaRetrievalStage().execute(ctx);
    expect(ctx.mediaRetrieval?.status).toBe('selected'); expect(ctx.verifiedMedia).toHaveLength(1);
    expect(ctx.metadata!.playbookDirective.nodeId).toBe('privacy-blocked');
    const reads = queries.filter(item => item.sql.includes('a.evidence_id=ANY'));
    expect(reads[0].params).toEqual(expect.arrayContaining([9,42,'whatsapp','customer','support_answer']));
  });
  it('does not attach merely helpful photos to a read-only knowledge answer', async () => {
    const ctx = { message: { userId: 9, channel: 'whatsapp', inboundText: 'Compare room details', metadata: {} },
      metadata: { playbookDirective: { readOnlyInformation: true } },
      nlu: { semanticRequest: { action: 'information', service: 'stay', explicit: true, topicSwitch: false,
        pricingRequested: false, media: 'helpful', confidence: 0.99 } },
    } as unknown as PipelineContext;
    await new MediaRetrievalStage().execute(ctx);
    expect(queries).toEqual([]); expect(ctx.verifiedMedia).toEqual([]);
  });

  it('normalizes the real channel consistently and binds an explicit profile at verification', async () => {
    await mediaGateway.verify(9, 'instagram_comment', decision, { businessProfileId: 42, audience: 'internal', purpose: 'internal_assist' });
    const read = queries.find(item => item.sql.includes('a.evidence_id=ANY'))!;
    expect(read.sql).toContain('g.business_profile_id IS NULL OR g.business_profile_id =');
    expect(read.params).toEqual(expect.arrayContaining([9, 42, 'instagram', 'internal', 'internal_assist']));
  });

  it('does not accept stale previously retrieved selections or a missing authorization context', async () => {
    expect((await mediaGateway.retrieve(query)).status).toBe('selected');
    current = false;
    expect(await mediaGateway.verify(9, 'web', decision, query)).toEqual([]);
    queries.length = 0;
    expect(await mediaGateway.verify(9, 'web', decision, undefined as never)).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it.each(['advisory', 'customer'])('passes the retrieval scope to both pipeline verification calls in %s mode', async executionMode => {
    const ctx = { message: { userId: 9, channel: 'web', inboundText: 'Show photos of Opal Room',
      metadata: { executionMode } }, metadata: { businessProfileId: 42 }, nlu: { semanticRequest: {
        action: 'information', service: 'stay', explicit: true, topicSwitch: false, pricingRequested: false, media: 'explicit', confidence: 0.99,
      } },
      agentResult: {}, guardrailResult: { action: 'allow' } } as unknown as PipelineContext;
    await new MediaRetrievalStage().execute(ctx);
    await new MediaSelectionStage().execute(ctx);
    const reads = queries.filter(item => item.sql.includes('a.evidence_id=ANY'));
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(read.params).toEqual(expect.arrayContaining([
      42, 'web', 'support_answer', executionMode === 'advisory' ? 'internal' : 'customer',
    ]));
  });

  it('preserves a valid text answer when late media verification is unavailable', async () => {
    const ctx = { message: { userId: 9, channel: 'web', metadata: {} }, metadata: {},
      mediaRetrieval: { intent: 'explicit', evidence: [], reason: 'Matched', status: 'selected' },
      agentResult: { replyText: 'Check-in is at 2 PM.' }, guardrailResult: { action: 'allow' } } as unknown as PipelineContext;
    const verification = jest.spyOn(mediaGateway, 'verify').mockRejectedValueOnce(new Error('Database temporarily unavailable'));
    try {
      const result = await new MediaSelectionStage().execute(ctx);
      expect(result.agentResult?.replyText).toBe('Check-in is at 2 PM.');
      expect(result.verifiedMedia).toEqual([]);
    } finally { verification.mockRestore(); }
  });
});
