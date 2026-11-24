import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Platform billing reserves the customer's wallet in WhatsAppApiService.dispatch.
 * A WhatsApp message posted to Meta anywhere else is one we pay Meta for and
 * never charge (and it skips opt-outs and readiness checks too).
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const skip = new Set(['node_modules', 'tests', 'dist', 'coverage', 'uploads', 'logs']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    if (skip.has(name) || name.startsWith('.')) return [];
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(?:ts|mts|js|mjs)$/.test(name) && !name.endsWith('.d.ts') ? [full] : [];
  });
}

const service = path.join(root, 'services', 'whatsappApiService.ts');
const whatsappPayload = /messaging_product['"]?\s*:\s*['"]whatsapp['"]/;
// Run by hand for Meta App Review, against a test number; not part of the app.
const operatorScripts = new Set([path.join(root, 'scripts', 'test-app-review.mjs')]);

describe('every WhatsApp send goes through dispatch', () => {
  it('only the WhatsApp service builds WhatsApp message payloads', () => {
    const offenders = sourceFiles(root)
      .filter(file => file !== service && !operatorScripts.has(file) && whatsappPayload.test(readFileSync(file, 'utf8')))
      .map(file => path.relative(root, file));
    expect(offenders).toEqual([]);
  });

  it('inside the service, only dispatch posts to the messages endpoint', () => {
    const source = readFileSync(service, 'utf8');
    expect(source.match(/\/messages`/g)).toHaveLength(1);
    expect(source).toMatch(/private async postMessage\([^)]*\)[^{]*\{\s*const url = `[^`]*\/messages`/);
    const callers = [...source.matchAll(/this\.postMessage\(/g)];
    expect(callers).toHaveLength(1);
    const dispatchStart = source.indexOf('private async dispatch(');
    const dispatchEnd = source.indexOf('private async postMessage(');
    expect(callers[0].index).toBeGreaterThan(dispatchStart);
    expect(callers[0].index).toBeLessThan(dispatchEnd);
    expect(source.slice(dispatchStart, dispatchEnd)).toContain('reserveWhatsAppSend');
  });
});
