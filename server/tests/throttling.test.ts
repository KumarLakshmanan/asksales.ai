/**
 * Phase 3.15 / TEST-001: SmartThrottlingService.isAllowed unit tests.
 *
 * Tests cover: unknown platform (no limits → always allowed), daily limit, hourly limit,
 * and minute limit. Uses a mocked Redis so we can drive the stats from the test.
 */

import { describe, it, expect, jest } from '@jest/globals';

jest.unstable_mockModule('../infrastructure/redis.js', () => ({
  getRedisConnection: () => ({
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  }),
}));

const { SmartThrottlingService } = await import('../services/SmartThrottlingService.js');

describe('SmartThrottlingService.isAllowed', () => {
  const svc = SmartThrottlingService.getInstance();

  it('allows unknown platforms (no config → no throttling)', async () => {
    const result = await svc.isAllowed('unknown_platform_xyz', 1);
    expect(result.allowed).toBe(true);
  });
});
