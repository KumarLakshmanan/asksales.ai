import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('lead generation review contract', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/widgets/LeadGenConfigWidget.tsx'),
    'utf8',
  );
  const inputsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/tabs/LeadsInputsTab.tsx'),
    'utf8',
  );
  const toolExecutionSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/hooks/useToolExecution.ts'),
    'utf8',
  );
  const leadsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/tabs/LeadsTab.tsx'),
    'utf8',
  );

  it('preserves exact selected workflow IDs in the approval payload', () => {
    expect(source).toContain('selected_workflows: (widget.formValues.selected_workflows as string[]) || []');
    expect(source).toContain('selected_workflows: f.platforms.includes(platform)');
  });
  it('opens the existing lead editor for the selected campaign lead', () => {
    expect(leadsSource).toContain('onEdit={(lead) => router.push(`/dashboard/leads/edit/${lead.id}`)}');
    expect(leadsSource).not.toContain('Edit functionality coming soon');
    expect(fs.existsSync(path.resolve(process.cwd(), 'src/app/dashboard/(main)/leads/edit/[id]/page.tsx'))).toBe(true);
  });

  it('exposes selected providers accessibly and warns on an empty selection', () => {
    expect(source).toContain('aria-pressed={form.platforms.includes(platform.value)}');
    expect(source).toContain('Select at least one target platform before confirming.');
  });

  it('regenerates provider-specific inputs instead of relabeling stale inputs', () => {
    expect(inputsSource).toContain('sw.id === platformInput.platform');
    expect(inputsSource).toContain('Regenerate the reviewed lead inputs using only ${selectedWorkflow}');
    expect(inputsSource).not.toContain("recommendedSubWorkflows: selected");
  });

  it('regenerates all reviewed inputs through the conversation without clearing them or losing the cap', () => {
    expect(inputsSource).toContain('onClick={handleRegenerateInputs}');
    expect(inputsSource).toContain('platformInputs.map((input) => input.platform)');
    expect(inputsSource).toContain('enforce a global cap of exactly ${exactLimit} leads across all selected providers');
    expect(inputsSource).toContain('The existing parameters remain available until replacements are reviewed.');
    expect(inputsSource).not.toContain('onClick={() => generateInputs(true)}');
  });

  it('shows the global save cap alongside provider fetch parameters', () => {
    expect(inputsSource).toContain('Saved lead cap: {platformInput.requestedLeadTotal} lead');
    expect(inputsSource).toContain('provider usage may be higher');
  });

  it('closes terminal provider failures instead of leaving a stale approval dialog', () => {
    expect(toolExecutionSource).toContain('error instanceof ApiError && error.status === 422');
    expect(toolExecutionSource).toContain('setShowApprovalModal(false)');
    expect(toolExecutionSource).toContain('setApprovalData(null)');
  });

  it('regenerates the exact failed workflow with a persisted numeric cap before retrying', () => {
    expect(leadsSource).toContain('handleRetry(platformData.platform)');
    expect(leadsSource).toContain('/api/workflows/existing-inputs/${threadId}');
    expect(leadsSource).toContain('Regenerate the reviewed lead inputs using only ${workflowId}');
    expect(leadsSource).toContain('global cap of exactly ${reviewedTotal} lead');
    expect(leadsSource).toContain('Retry requires a reviewed cap');
    expect(leadsSource).toContain("action: 'LEAD_AGENT_USE_WORKFLOW'");
    expect(leadsSource).toContain('workflowId: reviewedInput?.workflowId || workflowId');
    expect(leadsSource).toContain('Could not prepare retry');
    expect(leadsSource).not.toContain("onSendMessage('/retry')");
  });
});
