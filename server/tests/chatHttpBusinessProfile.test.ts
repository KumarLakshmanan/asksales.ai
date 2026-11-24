import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { sendMessageSchema } from '../middleware/schemas.js';
import { validateBody } from '../middleware/validation.js';

const findProfile = jest.fn<any>();
const defaultProfile = jest.fn<any>();
const createThread = jest.fn<any>();
const saveMessage = jest.fn<any>();
const release = jest.fn();
const checkCredits = jest.fn<any>();

jest.unstable_mockModule('../models/companySettings/functions.js', () => ({
  getCompanySettingsById: findProfile, getCompanySettingsByUserId: defaultProfile,
}));
jest.unstable_mockModule('../models/chatThreads/functions.js', () => ({
  getChatThreadById: jest.fn(), createChatThread: createThread, updateChatThread: jest.fn(),
  updateChatThreadTimestamp: jest.fn(), updateChatThreadMetadata: jest.fn(),
  getChatThreadMetadata: jest.fn(), clearPendingApprovalIfMatches: jest.fn(),
}));
jest.unstable_mockModule('../mastra/index.js', () => ({
  processMessage: jest.fn(), handleApproval: jest.fn(), switchAgent: jest.fn(),
  getConversationState: jest.fn(), createInitialState: () => ({ messages: [] }),
  getAgentDisplayName: (name: string) => name,
}));
jest.unstable_mockModule('../services/agents/ThreadService.js', () => ({ ThreadService: {
  acquireThreadMutex: async () => ({ release }), loadThreadState: async () => ({ messages: [] }),
} }));
jest.unstable_mockModule('../services/agents/MessageService.js', () => ({ MessageService: { saveMessage } }));
jest.unstable_mockModule('../middleware/creditCheck.js', () => ({ checkUserCredits: checkCredits }));
jest.unstable_mockModule('../services/LLMConfigService.js', () => ({
  getUserLLMConfig: async () => ({ modelName: 'test-only' }), getModelFallbackConfig: jest.fn(),
}));
jest.unstable_mockModule('../mastra/unifiedRouter.js', () => ({
  runUnifiedRouter: async () => ({ needsClarification: true, response: 'Which audience should we target?' }),
}));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({
  webSocketEmitter: { emitChatMessage: jest.fn() },
}));

jest.unstable_mockModule('../services/ConversationRequestCoordinator.js',()=>({
  conversationRequests:{run:async(_identity:unknown,work:()=>unknown)=>work()},
  currentConversationRequest:()=>undefined,bindConversationRequest:async()=>{},bindConversationWorkflow:async()=>{},checkpointConversationRequest:async()=>{},assertConversationRequestActive:async()=>{},
  ConversationRequestError:class extends Error {},
}));

const { langGraphMessageHandler } = await import('../mastra/chatController.js');

async function invoke(body: Record<string, unknown>) {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const req = { user: { id: 1 }, headers: {}, body: { content: 'Prepare my campaign', ...body } } as unknown as Request;
  const next = jest.fn();
  validateBody(sendMessageSchema)(req, res as unknown as Response, next);
  expect(next).toHaveBeenCalledWith();
  await langGraphMessageHandler(req, res as unknown as Response);
  return res;
}

describe('HTTP chat business profile ownership and forwarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findProfile.mockResolvedValue({ id: 42, userId: 1 });
    defaultProfile.mockResolvedValue({ id: 10, userId: 1 });
    checkCredits.mockResolvedValue({ allowed: true });
    createThread.mockResolvedValue({ id: 209, userId: 1 });
    saveMessage.mockImplementation(async (message: Record<string, unknown>) => ({ ...message, id: 501, createdAt: new Date() }));
  });

  it('creates the campaign with the explicitly selected owned business, not the default', async () => {
    const res = await invoke({ businessProfileId: 42 });
    expect(findProfile).toHaveBeenCalledWith(42);
    expect(defaultProfile).not.toHaveBeenCalled();
    expect(createThread).toHaveBeenCalledWith(1, undefined, 42);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ threadId: 209 }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('retains default-business behavior when no profile was selected', async () => {
    const res = await invoke({});
    expect(findProfile).not.toHaveBeenCalled();
    expect(defaultProfile).toHaveBeenCalledWith(1);
    expect(createThread).toHaveBeenCalledWith(1, undefined, 10);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it.each([0, -1, 'invalid', 1.5, null])('rejects invalid profile ID %p before creating a campaign', async businessProfileId => {
    const res = await invoke({ businessProfileId });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(findProfile).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
    expect(checkCredits).not.toHaveBeenCalled();
  });

  it.each([null, { id: 42, userId: 2 }])('rejects missing or another user’s profile: %p', async profile => {
    findProfile.mockResolvedValue(profile);
    const res = await invoke({ businessProfileId: 42 });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(createThread).not.toHaveBeenCalled();
    expect(defaultProfile).not.toHaveBeenCalled();
    expect(checkCredits).not.toHaveBeenCalled();
  });
});
