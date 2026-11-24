import { describe, expect, it } from '@jest/globals';
import { resolveChromiumExecutable } from '../utils/browserAutomation.js';

describe('system Chromium browser policy', () => {
  it('uses the explicitly configured executable and fails closed when it is missing', () => {
    const previous = process.env.BROWSER_EXECUTABLE_PATH;
    process.env.BROWSER_EXECUTABLE_PATH = '/definitely/not/a/browser';
    try {
      expect(() => resolveChromiumExecutable()).toThrow('Configured Chromium executable does not exist');
    } finally {
      if (previous === undefined) delete process.env.BROWSER_EXECUTABLE_PATH;
      else process.env.BROWSER_EXECUTABLE_PATH = previous;
    }
  });
});
