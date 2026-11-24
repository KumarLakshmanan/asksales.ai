import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyProviderDatasetOutcome,
  classifyReviewedProviderOutcome,
  isTerminalProviderReceiptStatus,
  isProviderDatasetEmptyResult,
  isProviderDatasetErrorResult,
  partitionProviderDatasetResults,
} from '../services/workflow/providerDatasetResults';

describe('provider dataset reconciliation', () => {
  it.each([
    [{ persisted: 0, duplicates: 0, rejected: 5 }, 'succeeded_empty'],
    [{ persisted: 1, duplicates: 0, rejected: 4 }, 'succeeded'],
    [{ persisted: 0, duplicates: 1, rejected: 4 }, 'succeeded'],
    [{ persisted: 0, duplicates: 0, rejected: 1, persistenceErrors: 1 }, 'failed'],
    [{ persisted: 1, duplicates: 0, rejected: 1, providerErrors: 1 }, 'partial_success'],
  ] as const)('separates reviewed filtering from actual errors: %j', (metrics, status) => {
    expect(classifyReviewedProviderOutcome(metrics)).toBe(status);
  });

  it('keeps incremental saves running until the workflow completes', () => {
    const executor = readFileSync(resolve(process.cwd(), 'services/WorkflowExecutorService.ts'), 'utf8');
    const incrementalSave = executor.slice(executor.indexOf('private static async persistReviewedLeadRecords'), executor.indexOf('private static async saveLeadsImmediately'));
    expect(incrementalSave).toContain("status: 'running'");
    expect(incrementalSave).not.toContain("progress: '100.00'");
  });

  it('rejects actor error receipts instead of treating them as leads', () => {
    const errorRow = {
      url: 'https://www.facebook.com/missing-page',
      error: 'not_available',
      errorDescription: 'This content is not available.',
    };

    expect(isProviderDatasetErrorResult(errorRow)).toBe(true);
    expect(partitionProviderDatasetResults([errorRow])).toEqual({
      validResults: [],
      rejectedResults: [errorRow],
      emptyResults: [],
    });
  });

  it('keeps valid leads while separating mixed provider failures', () => {
    const lead = { name: 'Dental Clinic', url: 'https://www.facebook.com/dental-clinic' };
    const errorRow = { requestErrorMessages: ['Request failed'] };

    expect(partitionProviderDatasetResults([lead, errorRow])).toEqual({
      validResults: [lead],
      rejectedResults: [errorRow],
      emptyResults: [],
    });
  });

  it('reconciles successful no-items sentinels as an empty dataset', () => {
    const emptyRow = {
      inputUrl: 'https://www.instagram.com/explore/tags/boutiquehotelsbengaluru',
      error: 'no_items',
      errorDescription: 'Empty or private data for provided input',
      requestErrorMessages: ['HTTP 200 undefined'],
    };

    expect(isProviderDatasetEmptyResult(emptyRow)).toBe(true);
    expect(partitionProviderDatasetResults([emptyRow])).toEqual({
      validResults: [],
      rejectedResults: [],
      emptyResults: [emptyRow],
    });
  });

  it('preserves valid rows while ignoring no-items sentinels', () => {
    const lead = { name: 'Boutique Hotel', city: 'Bengaluru' };
    const emptyRow = { error: 'NO_ITEMS' };

    expect(partitionProviderDatasetResults([lead, emptyRow])).toEqual({
      validResults: [lead],
      rejectedResults: [],
      emptyResults: [emptyRow],
    });
  });

  it('does not reject ordinary false or empty error-shaped fields', () => {
    const lead = { name: 'Valid Lead', error: false, requestErrorMessages: [] };
    expect(isProviderDatasetErrorResult(lead)).toBe(false);
  });

  it.each([
    [1, 0, 'succeeded'],
    [0, 0, 'succeeded_empty'],
    [1, 1, 'partial_success'],
    [0, 1, 'failed'],
  ] as const)('classifies %i usable and %i rejected rows as %s', (valid, rejected, status) => {
    expect(classifyProviderDatasetOutcome(valid, rejected)).toBe(status);
  });

  it.each(['succeeded', 'succeeded_empty', 'partial_success', 'failed', 'cancelled'])(
    'treats %s receipts as immutable terminal outcomes',
    (status) => {
      expect(isTerminalProviderReceiptStatus(status)).toBe(true);
    },
  );

  it.each(['pending', 'syncing'])('allows %s receipts to continue reconciliation', (status) => {
    expect(isTerminalProviderReceiptStatus(status)).toBe(false);
  });

  it('keeps the full provider candidate pool until reviewed relevance is evaluated', () => {
    const executor = readFileSync(
      resolve(process.cwd(), 'services/WorkflowExecutorService.ts'),
      'utf8',
    );

    expect(executor).toContain('const results = validResults;');
    expect(executor).not.toContain('validResults.slice(0, reviewedLimit)');
  });

  it('records provider usage only after the dataset count is known', () => {
    const executor = readFileSync(
      resolve(process.cwd(), 'services/WorkflowExecutorService.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(executor).toContain('const fetchedCount = Array.isArray(result) ? result.length : 0;');
    expect(executor).toContain("context,\n          fetchedCount,\n        ).catch");
    expect(executor).toContain('itemsScraped,');
    expect(executor).not.toContain('itemsScraped: 0, // Actual count not known at this level');
  });

  it('keeps failed provider identities and artifacts available for reconciliation', () => {
    const executor = readFileSync(
      resolve(process.cwd(), 'services/WorkflowExecutorService.ts'),
      'utf8',
    );

    expect(executor).toContain('let attemptedRun: any = null;');
    expect(executor).toContain('this.trackActorRunUsage(userId, actorId, attemptedRun');
    expect(executor).not.toContain('this.trackActorRunUsage(userId, actorId, null, actorInput');
    expect(executor.indexOf('this.saveActorRunArtifacts(userId, actorId, run, actorInput, client, context)'))
      .toBeLessThan(executor.indexOf("if (run.status !== 'SUCCEEDED')"));
  });
});
