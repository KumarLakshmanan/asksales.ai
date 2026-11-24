import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('durable conversation workflow contracts', () => {
  it('requires exact ICP revision approval before the orchestrator unlocks specialists', () => {
    const orchestrator = read('mastra/orchestrator.ts');
    const controller = read('mastra/chatController.ts');
    expect(orchestrator).toContain('state.icpProfile.approved === true');
    expect(orchestrator).toContain('state.icpProfile.approvedRevision === state.icpProfile.revision');
    expect(controller).toContain("targetAgent !== 'icp_generation' && !isCurrentIcpRevisionApproved(existingState.icpProfile)");
    expect(controller).toContain('Approve the current ICP revision before switching to a specialist agent.');
  });

  it('invalidates ICP approval whenever generated or edited data changes', () => {
    const generation = read('services/ICPGenerationService.ts');
    const controller = read('controllers/icpController.ts');
    expect(generation).toContain('approved = FALSE');
    expect(generation).toContain('revision = revision + 1');
    expect(controller).toContain('approvedRevision: null');
    expect(controller).toContain('revision: existingIcp.revision + 1');
  });

  it('does not generate lead inputs or execute lead providers merely by opening the tab', () => {
    const inputsTab = read('../client/src/components/tabs/LeadsInputsTab.tsx');
    expect(inputsTab).not.toContain("'/api/workflows/generate-inputs'");
    expect(inputsTab).not.toContain("'/api/lead-workflow/execute'");
    expect(inputsTab).toContain('await onApproval(true)');
  });

  it('keeps platform IDs, workflow IDs, input IDs, and selected lead IDs as distinct durable fields', () => {
    const migration = read('migrations/243_create_conversation_workflow_state_machine.js');
    expect(migration).toContain('platforms JSONB');
    expect(migration).toContain('workflow_ids JSONB');
    expect(migration).toContain('input_ids JSONB');
    expect(migration).toContain('lead_ids JSONB');
  });

  it('does not offer lead execution until durable input IDs exist', () => {
    const widgetRoutes = read('routes/widget.routes.ts');
    expect(widgetRoutes).toContain('Lead inputs were generated but no durable input records were saved.');
    expect(widgetRoutes).toContain("terminalStatus = 'failed'");
    expect(widgetRoutes).toContain('await getLatestLeadStrategySelection({');
    expect(widgetRoutes).toContain("action: 'approve_tool'");
  });

  it('commits generated inputs, their review, and the awaiting-approval transition atomically', () => {
    const functions = read('models/conversationWorkflow/functions.ts');
    const atomicReview = functions.slice(
      functions.indexOf('export async function createReviewedLeadInputSet'),
      functions.indexOf('export async function approveLeadInputSet'),
    );

    expect(atomicReview).toContain('return db.transaction');
    expect(atomicReview).toContain('tx.insert(leadInputsTable)');
    expect(atomicReview).toContain('tx.insert(leadInputSetsTable)');
    expect(atomicReview).toContain("status: 'superseded'");
    expect(atomicReview).toContain("eq(leadInputSetsTable.status, 'awaiting_approval')");
    expect(atomicReview).toContain("stage: 'lead_inputs_awaiting_approval'");
    expect(atomicReview).toContain('eq(conversationWorkflowRunsTable.version, currentRun.version)');
  });

  it('serializes resource revisions and enforces tenant-owned inputs and leads', () => {
    const hardeningMigration = read('migrations/244_harden_conversation_workflow_revisions.js');
    const functions = read('models/conversationWorkflow/functions.ts');
    expect(hardeningMigration).toContain('lead_strategy_selections_run_revision_uq');
    expect(hardeningMigration).toContain('lead_input_sets_run_revision_uq');
    expect(hardeningMigration).toContain('lead_selection_snapshots_run_revision_uq');
    expect(functions).toContain(".for('update')");
    expect(functions).toContain('One or more lead inputs are missing or belong to another conversation');
    expect(functions).toContain('One or more selected leads are missing or belong to another account');
  });

  it('finalizes a claimed approval run when guarded execution fails', () => {
    const controller = read('mastra/chatController.ts');
    const approvalHandler = controller.slice(
      controller.indexOf('export async function langGraphApproveHandler'),
      controller.indexOf('export async function langGraphSwitchAgentHandler'),
    );

    expect(approvalHandler).toContain('fullState.requiresApproval = false');
    expect(approvalHandler).toContain('fullState.pendingApproval = null');
    expect(approvalHandler).toContain("await persistWorkflowRunState(threadId, fullState, 'failed')");
  });
});
