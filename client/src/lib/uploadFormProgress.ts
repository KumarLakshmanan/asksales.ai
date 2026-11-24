/** XHR is used only for uploads where the browser can report bytes transferred. */
export function uploadFormWithProgress(url: string, form: FormData, options: {
  headers: Headers; signal?: AbortSignal | null; onProgress: (percent: number) => void;
}): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    if (options.signal?.aborted) { reject(new DOMException('Upload cancelled', 'AbortError')); return; }
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.timeout = 180_000;
    options.headers.forEach((value, key) => { if (key.toLowerCase() !== 'content-type') xhr.setRequestHeader(key, value); });
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) options.onProgress(Math.min(100, Math.round(event.loaded / event.total * 100)));
    };
    xhr.onload = () => {
      cleanup();
      let data: unknown = xhr.responseText;
      try { data = JSON.parse(xhr.responseText); } catch { /* Return text errors unchanged. */ }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => { cleanup(); reject(new Error('Upload connection lost. Check the saved draft before uploading again.')); };
    xhr.ontimeout = () => { cleanup(); reject(new Error('Upload timed out. Check the saved draft before uploading again.')); };
    xhr.onabort = () => { cleanup(); reject(new DOMException('Upload cancelled', 'AbortError')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    xhr.send(form);
  });
}
