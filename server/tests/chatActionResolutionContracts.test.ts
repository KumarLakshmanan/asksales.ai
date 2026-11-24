import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';

const readServerSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('durable conversation action resolution contracts', () => {
  it('validates durable source identifiers on structured actions', () => {
    const schemas = readServerSource('middleware/schemas.ts');

    expect(schemas).toContain('sourceMessageId: z.union');
    expect(schemas).toContain('buttonId: z.string().min(1).max(255).optional()');
  });

  it('claims action choices under a row lock and rejects conflicting buttons', () => {
    const messages = readServerSource('models/chatMessages/functions.ts');

    expect(messages).toContain('export async function claimChatMessageAction');
    expect(messages).toContain(".for('update')");
    expect(messages).toContain("if (!sameChoice) return { state: 'conflict' }");
    expect(messages).toContain("status: 'processing'");
    expect(messages).toContain("status: params.succeeded ? 'selected' : 'failed_retryable'");
  });

  it('verifies the source message before dispatch and uses a stable lead execution identity', () => {
    const controller = readServerSource('mastra/chatController.ts');

    expect(controller).toContain('await claimChatMessageAction({');
    expect(controller).toContain("if (claim.state === 'selected')");
    expect(controller).toContain("if (claim.state === 'processing')");
    expect(controller).toContain('void finalizeChatMessageAction({');
    expect(controller).toContain('actionFailureMessage = toUserFacingError((body as { error?: unknown }).error)');
    expect(controller).toContain('failure: succeeded ? undefined : actionFailureMessage');
    expect(controller).toContain('`lead-action-${threadId}-${sourceMessageId}-${buttonId}`');
  });

  it('routes lead-generation retries to Marcus with the saved workflow and original request', () => {
    const controller = readServerSource('mastra/chatController.ts');
    const retryAction = controller.slice(
      controller.indexOf("case 'LEAD_AGENT_RETRY':"),
      controller.indexOf("case 'LEAD_AGENT_START':"),
    );

    expect(retryAction).toContain('buildLeadRetryActionMessage');
    expect(retryAction).toContain('selectedWorkflows: retryState.selectedWorkflows || []');
    expect(retryAction).toContain('resolveOriginalLeadInputRequest(undefined, retryState.messages || [])');
    expect(retryAction).toContain("}), 'lead_generation')");
  });

  it('preserves the clicked review identity instead of substituting the latest approval', () => {
    const controller = readServerSource('mastra/chatController.ts');

    expect(controller).toContain("case 'approve_tool':\n      case 'reject_tool': {");
    const actionHandler = controller.slice(controller.indexOf("case 'approve_tool':"), controller.indexOf("case 'HIRE_ICP_AGENT':"));
    expect(actionHandler).toContain('req.body.requestId = approvalReference.requestId;');
    expect(actionHandler).toContain('req.body.toolName = approvalReference.toolName;');
    expect(actionHandler).not.toContain('loadThreadState');
    expect(controller).toContain("req.body.approved = action === 'approve_tool';");
  });

  it('persists successful lead results independently of the live browser event', () => {
    const controller = readServerSource('mastra/chatController.ts');

    expect(controller).toContain('async function persistLeadResultsTab(');
    expect(controller).toContain('const existingTabs = await getChatTabConfigs(threadId);');
    expect(controller).toContain("const tabId = existingLeadsTab?.tabId || `leads-${threadId}`;");
    expect(controller).toContain('await saveChatTabConfig(');
    expect(controller).toContain('await persistLeadResultsTab(Number(threadId), selectedLeadIds, workflowStatus);');
  });

  it('reconciles a terminal widget with its linked workflow action after interruption', () => {
    const widgets = readServerSource('models/widgetStates/functions.ts');
    const expiry = readServerSource('mastra/approvalExpiry.ts');

    expect(widgets).toContain('async reconcileTerminalWorkflowActions()');
    expect(widgets).toContain("widget.status IN ('succeeded', 'failed')");
    expect(widgets).toContain("action.status IN ('running', 'queued')");
    expect(widgets).toContain('widget.action_id = action.id');
    expect(widgets).toContain("thread.metadata->'workflowRun'->>'actionId' = action.id");
    expect(widgets).toContain("'{workflowRun,status}'");
    expect(expiry).toContain('await WidgetStateModel.reconcileTerminalWorkflowActions()');
  });
});
