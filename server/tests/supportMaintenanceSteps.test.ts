import { describe, expect, it, jest } from '@jest/globals';
import { assertMaintenanceSucceeded, runMaintenanceSteps } from '../services/supportMaintenanceSteps.js';

describe('support maintenance step isolation', () => {
  it('runs every step after a failure and reports the failed step', async () => {
    const log = { error: jest.fn() };
    const purge = jest.fn(async () => 3);
    const run = await runMaintenanceSteps([
      { name: 'slaBreaches', run: async () => { throw new Error('sla query failed'); } },
      { name: 'privacyVaultPurge', run: purge },
    ], log as any);

    expect(purge).toHaveBeenCalledTimes(1);
    expect(run.results).toEqual({ privacyVaultPurge: 3 });
    expect(run.failed).toEqual(['slaBreaches']);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ step: 'slaBreaches' }), 'Support maintenance step failed');
    expect(() => assertMaintenanceSucceeded('Support maintenance', run)).toThrow('1 step(s) failed (slaBreaches)');
  });

  it('does not throw when every step succeeds', async () => {
    const run = await runMaintenanceSteps([{ name: 'a', run: async () => 1 }], { error: jest.fn() } as any);
    expect(() => assertMaintenanceSucceeded('Support maintenance', run)).not.toThrow();
  });
});
