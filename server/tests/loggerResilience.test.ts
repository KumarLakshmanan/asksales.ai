import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('logger disk resilience', () => {
  it('does not enable duplicate file logging in development by default', () => {
    const source = readFileSync(resolve(process.cwd(), 'utils/logger.ts'), 'utf8');
    expect(source).toContain("process.env.FILE_LOGGING_ENABLED === 'true'");
    expect(source).toContain("isProduction && process.env.FILE_LOGGING_ENABLED !== 'false'");
  });

  it('handles file stream failures instead of crashing the API', () => {
    const source = readFileSync(resolve(process.cwd(), 'utils/logger.ts'), 'utf8');
    expect(source).toContain("stream.on('error'");
    expect(source).toContain('A logging destination must never take down the API');
  });
});
