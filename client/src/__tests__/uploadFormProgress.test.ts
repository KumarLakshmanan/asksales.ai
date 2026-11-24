import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { uploadFormWithProgress } from '@/lib/uploadFormProgress';

class FakeXhr {
  static latest: FakeXhr;
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  withCredentials = false;
  timeout = 0;
  status = 200;
  responseText = '{"success":true}';
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  ontimeout?: () => void;
  open = vi.fn(); setRequestHeader = vi.fn(); send = vi.fn();
  abort = vi.fn(() => this.onabort?.());
  constructor() { FakeXhr.latest = this; }
}
beforeEach(() => vi.stubGlobal('XMLHttpRequest', FakeXhr));
afterEach(() => vi.unstubAllGlobals());

it('reports actual transferred bytes while retaining authentication and browser multipart headers', async () => {
  const progress = vi.fn();
  const result = uploadFormWithProgress('/api/upload', new FormData(), { headers: new Headers({ authorization: 'Bearer test', 'x-xsrf-token': 'csrf', 'Content-Type': 'invalid' }), onProgress: progress });
  const xhr = FakeXhr.latest;
  expect(xhr.withCredentials).toBe(true);
  expect(xhr.setRequestHeader).toHaveBeenCalledWith('authorization', 'Bearer test');
  expect(xhr.setRequestHeader).toHaveBeenCalledWith('x-xsrf-token', 'csrf');
  expect(xhr.setRequestHeader).not.toHaveBeenCalledWith('content-type', expect.anything());
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
  expect(progress).toHaveBeenCalledWith(25);
  xhr.onload?.();
  await expect(result).resolves.toEqual({ status: 200, data: { success: true } });
});

it('rejects network uncertainty without retrying the upload', async () => {
  const result = uploadFormWithProgress('/api/upload', new FormData(), { headers: new Headers(), onProgress: vi.fn() });
  const error = expect(result).rejects.toThrow('Check the saved draft');
  FakeXhr.latest.onerror?.();
  await error;
  expect(FakeXhr.latest.send).toHaveBeenCalledTimes(1);
});
