import { readFileSync } from 'node:fs';

describe('lead provider recovery lease', () => {
  it('does not compare a PostgreSQL heartbeat to a millisecond Date for exact equality', () => {
    const source = readFileSync(
      new URL('../models/leadGenerationProviderRuns/functions.ts', import.meta.url),
      'utf8',
    );
    const claimBody = source.slice(
      source.indexOf('export async function claimRecoverableLeadGenerationProviderRunsForThread'),
      source.indexOf('export async function getLeadGenerationProviderRunForUser'),
    );

    expect(claimBody).toContain('lt(leadGenerationProviderRunsTable.heartbeatAt, staleBefore)');
    expect(claimBody).toContain(
      'eq(leadGenerationProviderRunsTable.executionId, latestRun.executionId)',
    );
    expect(claimBody).toContain(
      'eq(leadGenerationProviderRunsTable.id, latestRun.id)',
    );
    expect(claimBody).toContain("${leadInputSetsTable.status} = 'approved'");
    expect(claimBody).toContain('jsonb_build_array(${leadGenerationProviderRunsTable.leadInputId})');
    expect(claimBody).not.toContain(
      'eq(leadGenerationProviderRunsTable.heartbeatAt, candidate.heartbeatAt)',
    );
  });

  it('resumes only through the approved input-set identity and never through latest inputs', () => {
    const controller = readFileSync(
      new URL('../controllers/chatController.ts', import.meta.url),
      'utf8',
    );
    const recoveryBody = controller.slice(
      controller.indexOf('export async function getLatestScrapingDetailsHandler'),
      controller.indexOf('export async function updateLeadInputsHandler'),
    );

    expect(recoveryBody).toContain('getApprovedLeadInputSetForLeadInput');
    expect(recoveryBody).toContain('workflowRunId: approvedInputSet.runId');
    expect(recoveryBody).toContain('leadInputSetId: approvedInputSet.id');
    expect(recoveryBody).toContain('leadInputSetRevision: approvedInputSet.revision');
    expect(recoveryBody).not.toContain('{ thread_id: threadId },');
  });

  it('requires every provider execution to carry an exact approved review binding', () => {
    const executor = readFileSync(
      new URL('../mastra/tools/executors/leadExecutor.ts', import.meta.url),
      'utf8',
    );
    const executionBody = executor.slice(
      executor.indexOf('async function executeLeadWorkflowOnce'),
      executor.indexOf('const activeLeadWorkflowExecutions'),
    );

    expect(executionBody).toContain('Approve the exact lead input revision before running a search.');
    expect(executionBody).not.toContain('getLatestLeadInputsByThreadId(targetThreadId)');
  });

  it('does not short-circuit a completed workflow while a provider receipt is recoverable', () => {
    const source = readFileSync(
      new URL('../services/WorkflowExecutorService.ts', import.meta.url),
      'utf8',
    );
    const idempotencyBlock = source.slice(
      source.indexOf('const previousExecution ='),
      source.indexOf('// Resolve business category'),
    );

    expect(idempotencyBlock).toContain('const hasRecoverableProviderRun');
    expect(idempotencyBlock).toContain('run.id === latestProviderRun?.id');
    expect(idempotencyBlock).toContain("['pending', 'syncing'].includes(run.status)");
    expect(idempotencyBlock).toContain('&& !hasRecoverableProviderRun');
  });
});
