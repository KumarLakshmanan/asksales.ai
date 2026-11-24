import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { normalizeSupportImage } from './boundedImageNormalization.js';

export const DEMO_MAX_BYTES = 5 * 1024 * 1024;
export const DEMO_MAX_TEXT = 40_000;
const require = createRequire(import.meta.url);

// The PDF parser runs in a disposable process, with a heap cap and a hard
// deadline. Its stdout and extracted text are independently bounded.
export async function extractBoundedPdf(buffer: Buffer): Promise<string> {
  if (buffer.length > DEMO_MAX_BYTES || buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid or oversized PDF');
  const code = `
    const parse = require(process.argv[1]);
    const chunks = []; let size = 0;
    process.stdin.on('data', chunk => { size += chunk.length; if (size > 5242880) process.exit(1); chunks.push(chunk); });
    process.stdin.on('end', async () => {
      try {
        let length = 0; let pages = 0;
        const result = await parse(Buffer.concat(chunks), { max: 21, pagerender: async page => {
          if (++pages > 20) throw new Error('Page limit');
          const content = await page.getTextContent();
          const text = content.items.map(item => item.str || '').join(' ');
          length += text.length; if (length > 40000) throw new Error('Text limit');
          return text;
        }});
        if (result.numpages > 20 || result.text.length > 40000) throw new Error('PDF limit');
        process.stdout.write(JSON.stringify({ text: result.text }));
      } catch { process.exitCode = 1; }
    });`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=128', '--input-type=commonjs', '-e', code, require.resolve('pdf-parse')], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production' },
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error('PDF parsing failed or exceeded its 20-page, text, memory, or time limit'));
    };
    const timer = setTimeout(fail, 8_000);
    child.once('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 256 * 1024) { fail(); return; }
      chunks.push(chunk);
    });
    child.once('close', status => {
      if (settled) return;
      if (status !== 0) { fail(); return; }
      try {
        const text = JSON.parse(Buffer.concat(chunks).toString('utf8')).text;
        if (typeof text !== 'string' || !text.trim() || text.length > DEMO_MAX_TEXT) { fail(); return; }
        settled = true;
        clearTimeout(timer);
        resolve(text);
      } catch { fail(); }
    });
    child.stdin.end(buffer);
  });
}

export async function prepareDemoInput(buffer: Buffer, mimeType: string): Promise<{ text: string; image?: Buffer }> {
  if (!buffer.length || buffer.length > DEMO_MAX_BYTES) throw new Error('Demo files must be between 1 byte and 5 MiB');
  if (mimeType === 'application/pdf') return { text: await extractBoundedPdf(buffer) };
  const signatures = {
    'image/png': buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/jpeg': buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
    'image/webp': buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP',
  };
  if (!signatures[mimeType as keyof typeof signatures]) throw new Error('Only genuine PDF, PNG, JPEG, or WebP files are supported');
  const { derivative: image } = await normalizeSupportImage(buffer);
  return { text: '', image };
}
