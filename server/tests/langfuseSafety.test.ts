import { beforeEach, describe, expect, it, jest } from '@jest/globals';

process.env.LANGFUSE_ENABLED = 'true';
process.env.LANGFUSE_SECRET_KEY = 'synthetic-only';
process.env.LANGFUSE_PUBLIC_KEY = 'synthetic-only';
const end = jest.fn<(...args: unknown[]) => Promise<void>>();
const generation = jest.fn<(...args: unknown[]) => { end: typeof end }>();
const trace = jest.fn<(...args: unknown[]) => { generation: typeof generation }>();
jest.unstable_mockModule('langfuse', () => ({ Langfuse: class { trace = trace; } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info() {}, warn() {}, error() {} } }));
const { traceLangfuseGeneration } = await import('../infrastructure/langfuse.js');
const options = { context: { userId: 1, purpose: 'test', service: 'test', provider: 'synthetic' },
  model: 'synthetic', messages: [{ role: 'user', content: 'audit@example.test private body' }] };
beforeEach(() => { jest.clearAllMocks(); end.mockResolvedValue(undefined);
  generation.mockReturnValue({ end }); trace.mockReturnValue({ generation }); });

describe('observational tracing', () => {
  it.each(['trace', 'generation', 'end'])('never repeats successful work when %s fails', async step => {
    if (step === 'trace') trace.mockImplementationOnce(() => { throw new Error('synthetic'); });
    if (step === 'generation') generation.mockImplementationOnce(() => { throw new Error('synthetic'); });
    if (step === 'end') end.mockRejectedValueOnce(new Error('synthetic'));
    const result = { success: true, content: 'private response' };
    const work = jest.fn<() => Promise<typeof result>>().mockResolvedValue(result);
    expect(await traceLangfuseGeneration(options, work)).toBe(result);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('preserves the original operation error even if error telemetry fails', async () => {
    const error = new Error('private failure'); end.mockRejectedValueOnce(new Error('telemetry'));
    const work = jest.fn<() => Promise<never>>().mockRejectedValue(error);
    await expect(traceLangfuseGeneration(options, work)).rejects.toBe(error);
    expect(work).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(end.mock.calls)).not.toContain('private failure');
  });
  it('exports metadata and usage without customer prompt/output bodies', async () => {
    await traceLangfuseGeneration(options, async () => ({ content: 'private response',
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } }));
    const payload = JSON.stringify([trace.mock.calls, generation.mock.calls, end.mock.calls]);
    expect(payload).not.toContain('private'); expect(payload).not.toContain('audit@example.test');
    expect(payload).toContain('totalTokens');
  });
});
