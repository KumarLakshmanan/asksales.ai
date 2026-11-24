import { describe, expect, it } from '@jest/globals';
import { localStoragePath } from '../utils/localStoragePath.js';

describe('shared local upload directory', () => {
  it.each([
    'file:///app/server/utils/localStoragePath.ts',
    'file:///app/server/dist/index.js',
    'file:///app/server/dist/worker-entry.js',
    'file:///app/server/dist/utils/localStoragePath.js',
  ])('resolves source and bundled modules consistently: %s', (moduleUrl) => {
    expect(localStoragePath(moduleUrl, '')).toBe('/app/server/uploads');
  });

  it('uses the configured persistent volume for both serving and storage', () => {
    expect(localStoragePath('file:///app/server/dist/index.js', '/data/uploads')).toBe('/data/uploads');
  });
});
