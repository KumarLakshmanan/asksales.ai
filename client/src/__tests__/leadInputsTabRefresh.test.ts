import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('lead inputs result-tab refresh', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx'),
    'utf8',
  );

  it('accepts either canonical thread field and remounts on a durable result revision', () => {
    expect(source).toContain('const leadInputsThreadId = eventThreadId;');
    expect(source).toContain('setLeadInputsRevision(revision => revision + 1);');
    expect(source).toContain('key={`lead-inputs-${currentThreadId}-${leadInputsRevision}`}');
  });
});
