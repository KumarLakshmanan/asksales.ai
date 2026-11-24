import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendSupportReply } from '@/lib/support-reply-intent';

beforeEach(() => { sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true); });
function options(scope = 'member:7:ticket:1') {
  return { scope, content: 'Reviewed message', files: [] as File[], isCurrent: () => true,
    upload: vi.fn(async (file: File) => ({ fileId: 31, name: file.name, type: file.type })), send: vi.fn(async (_body: unknown) => {}) };
}
function file(content: string) {
  return { name: 'same.txt', type: 'text/plain', size: content.length,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer } as File;
}

describe('scoped support reply recovery', () => {
  it('reuses uploaded attachment IDs after reload; changed bytes create a distinct reviewed intent', async () => {
    const o = options(); o.files = [file('one')];
    o.send.mockRejectedValueOnce(new Error('Committed response lost'));
    await expect(sendSupportReply(o)).rejects.toThrow(/may have been accepted/);
    const first = o.send.mock.calls[0][0];
    await sendSupportReply(o);
    expect(o.upload).toHaveBeenCalledTimes(1);
    expect(o.send.mock.calls[1][0]).toEqual(first);
    o.files = [file('two')]; await sendSupportReply(o);
    expect(o.upload).toHaveBeenCalledTimes(2);
    expect(o.send.mock.calls[2][0]).not.toEqual(first);
  });
  it('keeps separate intents for edits, ticket, identity and auth realm; no stored reply text', async () => {
    const o = options(); o.send.mockRejectedValue(new Error('Uncertain'));
    const keys = [];
    for (const [scope, content] of [['member:7:ticket:1','one'],['member:7:ticket:1','two'],['member:8:ticket:1','one'],['member:7:ticket:2','one'],['owner:7:ticket:1','one']]) {
      await expect(sendSupportReply({ ...o, scope, content })).rejects.toThrow();
      keys.push((o.send.mock.calls.at(-1)![0] as { idempotencyKey: string }).idempotencyKey);
    }
    expect(new Set(keys).size).toBe(5);
    for (let index = 0; index < sessionStorage.length; index++) {
      const stored = sessionStorage.getItem(sessionStorage.key(index)!)!;
      expect(stored).not.toContain('"content"'); expect(stored).not.toContain('"one"');
    }
  });
  it('requires review before sending changed content after an uncertain outcome', async () => {
    const o = options(); o.send.mockRejectedValueOnce(new Error('Uncertain'));
    await expect(sendSupportReply(o)).rejects.toThrow();
    vi.mocked(window.confirm).mockReturnValue(false);
    await expect(sendSupportReply({ ...o, content: 'Changed reply' })).rejects.toThrow(/cancelled/);
    expect(o.send).toHaveBeenCalledTimes(1);
    await sendSupportReply(o);
    expect(o.send.mock.calls[1][0]).toEqual(o.send.mock.calls[0][0]);
  });
  it('does not post after the authenticated scope changes during an upload', async () => {
    let current = true; const o = options(); o.files = [file('one')]; o.isCurrent = () => current;
    o.upload.mockImplementation(async f => { current = false; return { fileId: 31, name: f.name, type: f.type }; });
    await expect(sendSupportReply(o)).rejects.toThrow(/account changed/);
    expect(o.send).not.toHaveBeenCalled();
  });
  it('blocks a simultaneous attempt and does not send when safe retry storage is unavailable', async () => {
    const o = options(); let release!: () => void;
    o.send.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const first = sendSupportReply(o);
    await vi.waitFor(() => expect(o.send).toHaveBeenCalledTimes(1));
    await expect(sendSupportReply(o)).rejects.toThrow(/already being prepared/);
    release(); await first;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Disabled'); });
    const next = options(); await expect(sendSupportReply(next)).rejects.toThrow(/storage is unavailable/);
    expect(next.send).not.toHaveBeenCalled(); spy.mockRestore();
  });
});
