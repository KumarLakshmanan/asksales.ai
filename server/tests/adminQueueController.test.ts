import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getJobs = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getJobCountByTypes = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getJob = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clean = jest.fn<any>();
const getQueue = jest.fn(() => ({
  getJobs,
  getJobCountByTypes,
  getJob,
  clean,
  pause: jest.fn(),
  resume: jest.fn(),
}));

jest.unstable_mockModule('../queues/index.js', () => ({
  QUEUE_NAMES: {
    OUTREACH: 'outreach',
    CONTENT_GENERATION: 'content-generation',
  },
  queueRegistry: {
    getQueue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAllQueueMetrics: jest.fn<any>().mockResolvedValue([]),
  },
}));

const {
  listQueueJobs,
  retryJob,
  removeJob,
  cleanQueue,
} = await import('../controllers/adminQueueController.js');

function responseDouble() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: any = {
    statusCode: 200,
    payload: undefined as unknown,
    status: jest.fn<(code: number) => typeof response>((code) => {
      response.statusCode = code;
      return response;
    }),
    json: jest.fn<(payload: unknown) => typeof response>((payload) => {
      response.payload = payload;
      return response;
    }),
  };
  return response;
}

describe('admin queue controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getJobs.mockResolvedValue([]);
    getJobCountByTypes.mockResolvedValue(0);
    getJob.mockResolvedValue(null);
    clean.mockResolvedValue([]);
  });

  it('rejects unsupported job status filters before touching Redis', async () => {
    const response = responseDouble();
    await listQueueJobs({
      params: { queueName: 'outreach' },
      query: { status: 'unknown' },
    } as never, response as never);

    expect(response.statusCode).toBe(400);
    expect(getQueue).not.toHaveBeenCalled();
  });

  it('bounds queue job pages to one hundred records', async () => {
    const response = responseDouble();
    await listQueueJobs({
      params: { queueName: 'outreach' },
      query: { start: '0', end: '100' },
    } as never, response as never);

    expect(response.statusCode).toBe(400);
    expect(getQueue).not.toHaveBeenCalled();
  });

  it('returns paginated diagnostics with secrets and PII redacted', async () => {
    const job = {
      id: 'job-1',
      name: 'send_outreach_message',
      data: {
        userId: 42,
        email: 'customer@example.com',
        apiKey: 'super-secret',
        prompt: 'Call +91 98765 43210 and email customer@example.com',
      },
      opts: { attempts: 3 },
      attemptsMade: 1,
      failedReason: 'Bearer abc.def customer@example.com',
      stacktrace: ['request token=secret-value'],
      returnvalue: { accessToken: 'provider-token', result: 'sent to customer@example.com' },
      timestamp: 1,
      processedOn: 2,
      finishedOn: 3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getState: jest.fn<any>().mockResolvedValue('failed'),
    };
    getJobs.mockResolvedValue([job]);
    getJobCountByTypes.mockResolvedValue(51);

    const response = responseDouble();
    await listQueueJobs({
      params: { queueName: 'outreach' },
      query: { status: 'failed', start: '0', end: '49' },
    } as never, response as never);

    expect(response.statusCode).toBe(200);
    const payload = response.payload as {
      data: {
        jobs: Array<{
          data: Record<string, unknown>;
          failedReason: string;
          returnvalue: Record<string, unknown>;
        }>;
        total: number;
        hasMore: boolean;
      };
    };
    expect(payload.data.total).toBe(51);
    expect(payload.data.hasMore).toBe(true);
    expect(payload.data.jobs[0].data.email).toBe('[REDACTED]');
    expect(payload.data.jobs[0].data.apiKey).toBe('[REDACTED]');
    expect(payload.data.jobs[0].data.prompt).not.toContain('customer@example.com');
    expect(payload.data.jobs[0].failedReason).not.toContain('abc.def');
    expect(payload.data.jobs[0].returnvalue.accessToken).toBe('[REDACTED]');
  });

  it('only retries jobs in the failed state', async () => {
    const retry = jest.fn();
    getJob.mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getState: jest.fn<any>().mockResolvedValue('completed'),
      retry,
    });
    const response = responseDouble();

    await retryJob({
      params: { queueName: 'outreach', jobId: 'job-1' },
      user: { id: 1 },
    } as never, response as never);

    expect(response.statusCode).toBe(409);
    expect(retry).not.toHaveBeenCalled();
  });

  it('does not remove an active job and misrepresent it as cancelled', async () => {
    const remove = jest.fn();
    getJob.mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getState: jest.fn<any>().mockResolvedValue('active'),
      remove,
    });
    const response = responseDouble();

    await removeJob({
      params: { queueName: 'outreach', jobId: 'job-1' },
      user: { id: 1 },
    } as never, response as never);

    expect(response.statusCode).toBe(409);
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects an excessive queue cleanup grace period', async () => {
    const response = responseDouble();
    await cleanQueue({
      params: { queueName: 'outreach' },
      body: { status: 'failed', grace: 31 * 24 * 60 * 60 * 1000 },
      user: { id: 1 },
    } as never, response as never);

    expect(response.statusCode).toBe(400);
    expect(clean).not.toHaveBeenCalled();
  });
});
