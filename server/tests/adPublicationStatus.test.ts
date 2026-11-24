import { describe, expect, it } from '@jest/globals';
import { summarizeAdPublication } from '../../shared/adPublicationStatus.js';

describe('truthful per-platform publication summaries', () => {
  it.each([
    [['active', 'active'], 'active', false, true],
    [['provider_created', 'provider_created'], 'provider_created', false, true],
    [['active', 'provider_created'], 'partial_success', false, true],
    [['queued', 'failed'], 'partial_success', true, true],
    [['active', 'failed'], 'partial_success', false, true],
    [['running', 'queued'], 'running', true, true],
    [['gated', 'gated'], 'gated', false, false],
    [['blocked', 'gated'], 'blocked', false, false],
    [['failed', 'failed'], 'failed', false, false],
  ] as const)('summarizes %j as %s', (states, status, pending, success) => {
    expect(summarizeAdPublication(states.map(value => ({ status: value })))).toEqual(expect.objectContaining({ status, pending, success }));
  });
});
