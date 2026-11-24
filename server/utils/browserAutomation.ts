import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';

const SYSTEM_CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
] as const;

export function resolveChromiumExecutable(): string {
  const configured = process.env.BROWSER_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`Configured Chromium executable does not exist: ${configured}`);
    }
    return configured;
  }

  const detected = SYSTEM_CHROMIUM_CANDIDATES.find(candidate => existsSync(candidate));
  if (!detected) {
    throw new Error('Chromium is required for PDF and screenshot generation. Set BROWSER_EXECUTABLE_PATH.');
  }
  return detected;
}

export async function launchSystemChromium(options: { untrustedContent?: boolean } = {}): Promise<Browser> {
  return chromium.launch({
    executablePath: resolveChromiumExecutable(),
    headless: true,
    chromiumSandbox: Boolean(options.untrustedContent),
    args: options.untrustedContent ? [
      '--disable-dev-shm-usage', '--disable-background-networking', '--disable-quic',
      '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ] : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}
