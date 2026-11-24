import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addJob = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const initialize = jest.fn<any>();

jest.unstable_mockModule('../queues/index.js', () => ({
  QUEUE_NAMES: {
    IMAGE_GENERATION: 'image-generation',
    VIDEO_GENERATION: 'video-generation',
    WEB_SCRAPING: 'web-scraping',
    EMAIL_SENDING: 'email-sending',
    SMS_SENDING: 'sms-sending',
    LEAD_ENRICHMENT: 'lead-enrichment',
    OUTREACH: 'outreach',
    EMBEDDING: 'embedding',
  },
  queueRegistry: {
    addJob,
    initialize,
    getAllQueueMetrics: jest.fn(),
  },
}));

jest.unstable_mockModule('uuid', () => ({
  v4: () => 'correlation-1',
}));
jest.unstable_mockModule('../services/agents/orchestration/SupportConversationTurn.js', () => ({
  registerSupportTurnInput: jest.fn<(...args: unknown[]) => Promise<null>>().mockResolvedValue(null),
}));

const { jobDispatcher } = await import('../queues/JobDispatcher.js');

describe('JobDispatcher processor contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    addJob.mockResolvedValue('job-1');
    initialize.mockResolvedValue(undefined);
  });

  it('rejects tools that have no registered worker instead of stranding a job', async () => {
    await expect(jobDispatcher.dispatch('publish_meta_ads', {
      userId: 1,
      campaignId: 10,
    })).rejects.toThrow('no registered queue processor');
    expect(addJob).not.toHaveBeenCalled();
  });

  it('rejects malformed processor payloads before enqueueing', async () => {
    await expect(jobDispatcher.dispatch('generate_image', {
      userId: 1,
      prompt: '',
    })).rejects.toThrow('Invalid payload');
    expect(addJob).not.toHaveBeenCalled();
  });

  it('routes a valid media job to its live worker and adds the durable envelope', async () => {
    const result = await jobDispatcher.dispatch('generate_image', {
      userId: 7,
      threadId: 9,
      prompt: 'A clean product photograph',
    });

    expect(result).toEqual({
      jobId: 'job-1',
      queue: 'image-generation',
      status: 'queued',
      correlationId: 'correlation-1',
    });
    expect(addJob).toHaveBeenCalledWith(
      'image-generation',
      'generate_image',
      expect.objectContaining({
        userId: 7,
        threadId: 9,
        prompt: 'A clean product photograph',
        correlationId: 'correlation-1',
        createdAt: expect.any(String),
      }),
      { priority: undefined, delay: undefined },
    );
  });

  it('rejects empty social outreach content rather than completing a no-op job', async () => {
    await expect(jobDispatcher.dispatch('start_outreach_campaign', {
      userId: 1,
      leadId: 5,
      channel: 'instagram',
      message: '',
    })).rejects.toThrow('Invalid payload');
    expect(addJob).not.toHaveBeenCalled();
  });
  it.each(['process_whatsapp_webhook', 'process_instagram_webhook', 'process_facebook_webhook'])('deduplicates retried %s events without collapsing different messages or tenants', async tool => {
    const payload = { userId: 9, conversationId: 615, phoneNumberId: 'receiving-account',
      providerAccountId: 'receiving-account', inboundMessageId: 7404, messageId: 'provider-message', inboundText: 'Change the dates' };
    const jobs = new Set<string>();
    addJob.mockImplementation(async (_queue: unknown, _tool: unknown, _data: unknown, options: { jobId: string }) => {
      jobs.add(options.jobId); return options.jobId;
    });
    const first = await jobDispatcher.dispatch(tool, payload);
    const retry = await jobDispatcher.dispatch(tool, { ...payload, inboundText: 'Same event after privacy preparation' });
    expect(retry.jobId).toBe(first.jobId);
    expect(first.jobId).toMatch(/^inbound-[a-f0-9]{64}$/);
    expect(jobs.size).toBe(1);
    await jobDispatcher.dispatch(tool, { ...payload, inboundMessageId: 7405 });
    await jobDispatcher.dispatch(tool, { ...payload, userId: 10 });
    await jobDispatcher.dispatch(tool, { ...payload, phoneNumberId: 'other-account', providerAccountId: 'other-account' });
    expect(jobs.size).toBe(4);
  });
  it('keeps explicit caller job identities and scopes legacy provider IDs', async () => {
    const payload = { userId: 9, conversationId: 615, messageId: 'provider-message', inboundText: 'Hello' };
    await jobDispatcher.dispatch('process_whatsapp_webhook', payload, { jobId: 'caller-owned-id' });
    expect(addJob.mock.calls.at(-1)?.[3]).toMatchObject({ jobId: 'caller-owned-id' });
    await jobDispatcher.dispatch('process_whatsapp_webhook', payload);
    const firstOptions = addJob.mock.calls.at(-1)?.[3] as { jobId?: string } | undefined;
    const first = firstOptions?.jobId;
    await jobDispatcher.dispatch('process_whatsapp_webhook', { ...payload, messageId: 'another-message' });
    const nextOptions = addJob.mock.calls.at(-1)?.[3] as { jobId?: string } | undefined;
    expect(nextOptions?.jobId).not.toBe(first);
  });
});
