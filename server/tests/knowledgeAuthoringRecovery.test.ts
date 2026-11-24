import { beforeEach, describe, it, expect, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';
const extractedPreview = jest.fn<(...args: any[]) => Promise<any>>(async () => null);
jest.unstable_mockModule('../services/knowledge/KnowledgeReadinessService.js', () => ({
  knowledgeReadinessService: { extractedText: extractedPreview },
}));
let entries: any[] = [];
const index = jest.fn<
  (userId: number, entryId: number, text: string) => Promise<void>
>(async () => {});
const metadataDraft = jest.fn(async () => ({
  entry: { id: 1, title: 'New intended title' },
  draft: { versionId: 21, status: 'ready_for_review' },
}));
const model = {
  findById: jest.fn(async (id: number, userId: number) => {
    const e = entries.find((x) => x.id === id && x.userId === userId);
    return e ? { ...e } : null;
  }),
  update: jest.fn(async (id: number, userId: number, data: any) => {
    const e = entries.find((x) => x.id === id && x.userId === userId);
    if (!e) return null;
    for (const [k, v] of Object.entries(data)) if (v !== undefined) e[k] = v;
    return { ...e };
  }),
  create: jest.fn(async (data: any) => {
    const e = { id: entries.length + 1, ...data };
    entries.push(e);
    return { ...e };
  }),
  updateIfUnchanged: jest.fn(async (id: number, userId: number, data: any) =>
    model.update(id, userId, data),
  ),
  createBatch: jest.fn(
    async (_user: number, _key: string, candidates: any[]) => {
      if (!entries.length)
        entries = candidates.map((data, index) => ({ id: index + 1, ...data }));
      return entries.map((entry) => ({ ...entry }));
    },
  ),
  claimBatchItem: jest.fn(async (id: number) => {
    const e = entries.find((x) => x.id === id);
    e.processingStatus = 'processing';
    return { ...e };
  }),
};
jest.unstable_mockModule('../models/knowledgeBase/functions', () => ({
  KnowledgeBaseModel: model,
}));
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../services/billing/entitlements.js', () => ({
  normalizeCapacityError: () => null,
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}));
jest.unstable_mockModule('../services/CreditDeductionHooks.js', () => ({
  deductCreditsForKnowledgeBase: jest.fn(),
  deductCreditsForKnowledgeBaseItem: jest.fn(),
}));
jest.unstable_mockModule('../services/StorageService.js', () => ({
  StorageService: { getInstance: jest.fn() },
}));
jest.unstable_mockModule('../queues/index.js', () => ({
  queueRegistry: { addJob: jest.fn() },
  QUEUE_NAMES: { KNOWLEDGE_BASE: 'synthetic' },
}));
jest.unstable_mockModule(
  '../services/KnowledgeBaseProcessingService.js',
  () => ({ processKnowledgeBaseEntryIngestion: jest.fn() }),
);
jest.unstable_mockModule('../services/KnowledgeBaseService.js', () => ({
  knowledgeBaseService: { indexEntry: index },
}));
jest.unstable_mockModule(
  '../services/knowledge/KnowledgeGovernanceService.js',
  () => ({
    knowledgeGovernanceService: { updateSourceMetadata: metadataDraft },
  }),
);
const controller = await import('../controllers/knowledgeBaseController.js');
const req = (body: any) => ({
  user: { id: 9 },
  params: { id: '1' },
  headers: {},
  body,
});
function res() {
  const r: any = {
    statusCode: 200,
    body: null,
    status(n: number) {
      this.statusCode = n;
      return this;
    },
    json(body: any) {
      this.body = body;
      return this;
    },
  };
  return r;
}
beforeEach(() => {
  entries = [];
  jest.clearAllMocks();
  index.mockImplementation(async () => {});
  extractedPreview.mockResolvedValue(null);
});
describe('knowledge CRUD audit reproductions using synthetic in-memory records', () => {
  it('previews the current version and index instead of obsolete legacy chunk embedding flags', async () => {
    entries = [{id:1,userId:9,type:'url',content:JSON.stringify({chunks:[{text:'Old text',hasEmbedding:false}]})}];
    const current = {extractedText:'Current source',chunks:[{index:0,text:'Current source',hasEmbedding:true}],
      embeddingsGenerated:true,extractionSource:'published_version',readiness:{status:'privacy_blocked'}};
    extractedPreview.mockResolvedValue(current);
    const output = res();
    await controller.getKnowledgeBaseExtractedText(req({}) as any,output);
    expect(output.body).toMatchObject(current);
    expect(extractedPreview).toHaveBeenCalledWith(9,1);
  });
  it('marks legacy embedding claims unknown when there is no current version', async () => {
    entries = [{id:1,userId:9,type:'url',content:JSON.stringify({extractedText:'Old text',embeddingsGenerated:true,chunks:[{text:'Old text',hasEmbedding:true}]})}];
    const output = res();
    await controller.getKnowledgeBaseExtractedText(req({}) as any,output);
    expect(output.body).toMatchObject({extractionSource:'legacy_preview',embeddingsGenerated:false,chunks:[{hasEmbedding:null}]});
    expect(output.body.extractionWarnings.join(' ')).toContain('current index readiness is unavailable');
  });
  it('does not expose raw or blocked source previews to a business member', async () => {
    const output = res();
    await withBusinessScope({userId:9,actorUserId:10,businessProfileId:42,role:'member'}, () =>
      controller.getKnowledgeBaseExtractedText({...req({}),user:{id:10}} as any,output));
    expect(output.statusCode).toBe(403);
    expect(extractedPreview).not.toHaveBeenCalled();
    expect(model.findById).not.toHaveBeenCalled();
  });
  it('KB-04 rejects blank content before any source update or indexing', async () => {
    entries = [
      {
        id: 1,
        userId: 9,
        type: 'document',
        title: 'Reset guide',
        content: 'Approved reset guidance',
        businessProfileId: null,
        processingStatus: 'completed',
      },
    ];
    const response = res();
    await controller.updateKnowledgeBaseEntry(
      req({ content: '   ' }) as any,
      response,
    );
    expect(response.statusCode).toBe(400);
    expect(entries[0].content).toBe('Approved reset guidance');
    expect(entries[0].processingStatus).toBe('completed');
    expect(model.update).not.toHaveBeenCalled();
    expect(model.updateIfUnchanged).not.toHaveBeenCalled();
    expect(index).not.toHaveBeenCalled();
  });
  it.each(['file', 'url'])(
    'KB-05 %s title edit uses the governed metadata draft path',
    async (type) => {
      entries = [
        {
          id: 1,
          userId: 9,
          type,
          title: 'Old reviewed title',
          content: 'existing extracted JSON',
          businessProfileId: null,
          processingStatus: 'completed',
        },
      ];
      const response = res();
      await controller.updateKnowledgeBaseEntry(
        req({ title: 'New intended title' }) as any,
        response,
      );
      expect(response.statusCode).toBe(200);
      expect(metadataDraft).toHaveBeenCalled();
      expect(index).not.toHaveBeenCalled();
      expect(model.updateIfUnchanged).not.toHaveBeenCalled();
    },
  );
  it('KB-07 returns explicit partial receipts and resumes the same durable entries', async () => {
    let fails = true;
    index.mockImplementation(async (_user: any, id: any) => {
      if (id === 2 && fails) throw new Error('synthetic index outage');
    });
    const body = {
      requestId: 'synthetic-request-123',
      qas: [
        { question: 'Reset?', answer: 'Blue button' },
        { question: 'Hours?', answer: 'Nine AM' },
      ],
    };
    const response = res();
    await controller.createQAEntry(req(body) as any, response);
    expect(response.statusCode).toBe(207);
    expect(response.body.success).toBe(false);
    expect(response.body.results).toEqual([
      { entryId: 1, status: 'completed' },
      { entryId: 2, status: 'failed' },
    ]);
    fails = false;
    const retry = res();
    await controller.createQAEntry(req(body) as any, retry);
    expect(retry.statusCode).toBe(201);
    expect(entries).toHaveLength(2);
    expect(index.mock.calls.filter((call) => call[1] === 1)).toHaveLength(1);
  });
  it('KB-07 validates the whole batch and stable identity before creating any rows', async () => {
    for (const body of [
      {
        qas: [
          { question: 'Reset?', answer: 'Blue button' },
          { question: 'Hours?', answer: ' ' },
        ],
      },
      { qas: [{ question: 'Reset?', answer: 'Blue button' }] },
    ]) {
      const response = res();
      await controller.createQAEntry(req(body) as any, response);
      expect(response.statusCode).toBe(400);
    }
    expect(model.createBatch).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
  });
});
