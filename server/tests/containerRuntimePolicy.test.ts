import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';

describe('production container runtime policy', () => {
  it('pins the supported Node runtime and supplies ffmpeg/ffprobe to API and worker images', async () => {
    const [apiDockerfile, workerDockerfile] = await Promise.all([
      readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
      readFile(new URL('../Dockerfile.worker', import.meta.url), 'utf8'),
    ]);
    for (const dockerfile of [apiDockerfile, workerDockerfile]) {
      expect(dockerfile).toContain('node:24.18.1-alpine');
      expect(dockerfile).toMatch(/(?:apk add --no-cache|apt-get install -y --no-install-recommends\s*\\)\s+chromium ffmpeg/);
      expect(dockerfile).toContain('BROWSER_EXECUTABLE_PATH=/usr/bin/chromium');
    }
    expect(apiDockerfile).toContain('node:24.18.1-bookworm-slim AS runtime');
    expect(apiDockerfile).toContain('META_AD_LIBRARY_PYTHON=/opt/scrapling/bin/python');
    expect(apiDockerfile).toContain('pip install --no-cache-dir -r /tmp/requirements-scrapling.txt');
  });
});
