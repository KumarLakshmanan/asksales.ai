import type { PendingApproval } from './state.js';
import { executeLeadWorkflowTool } from './tools/leadTools.js';
import {
  publishGoogleAdsTool,
  publishMetaAdsTool,
} from './tools/adsTools.js';
import { publishSocialPostTool } from './tools/contentTools.js';
import { sendOutreachMessagesTool } from './tools/outreachTools.js';
import { sendProposalTool } from './tools/proposalTools.js';
import type { PlatformModuleKey } from '../utils/platformModules.js';

// Mastra exposes these as StandardSchemaWithJSON even when the source schema is
// Zod. Keep the runtime surface narrow while allowing the underlying Zod parse
// method to reject invalid or shallow override payloads.
const approvalTools: Record<string, unknown> = {
  execute_lead_workflow: executeLeadWorkflowTool,
  publish_meta_ads: publishMetaAdsTool,
  publish_google_ads: publishGoogleAdsTool,
  publish_social_post: publishSocialPostTool,
  send_outreach_messages: sendOutreachMessagesTool,
  send_proposal: sendProposalTool,
};

export function pendingApprovalMatchesRequest(
  pendingApproval: PendingApproval | null | undefined,
  requestId: string,
  toolName: string,
): boolean {
  if (!pendingApproval) return false;
  const pendingRequestId = pendingApproval.executionId || pendingApproval.toolCallId;
  return pendingRequestId === requestId && pendingApproval.toolName === toolName;
}

/** Proposal delivery reviews are immutable; every field must come from the durable pending action. */
export function mergePendingApprovalArguments(
  toolName: string,
  pendingArgs: Record<string, unknown>,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === 'send_proposal' && overrides && Object.keys(overrides).length > 0) {
    throw new Error('A proposal delivery approval cannot be modified. Prepare a new review instead.');
  }
  return { ...pendingArgs, ...(overrides || {}) };
}

export function validatePendingApprovalArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const tool = approvalTools[toolName];
  if (!tool) throw new Error(`Unsupported approval tool "${toolName}"`);
  const typedTool = tool as {
    inputSchema?: { parse?: (value: unknown) => unknown };
    schema?: { parse?: (value: unknown) => unknown };
  };
  const schema = typedTool.inputSchema || typedTool.schema;
  if (!schema?.parse) {
    throw new Error(`Approval tool "${toolName}" does not expose a validating schema`);
  }
  return schema.parse(args) as Record<string, unknown>;
}

export function requiredModuleForApprovalTool(toolName: string): PlatformModuleKey {
  if (toolName === 'execute_lead_workflow') return 'lead_generation';
  if (toolName === 'send_outreach_messages') return 'outreach';
  if (toolName === 'send_proposal') return 'proposals';
  if (toolName === 'publish_meta_ads' || toolName === 'publish_google_ads') {
    return 'performance_marketing';
  }
  if (toolName === 'publish_social_post') return 'content';
  throw new Error(`Unsupported approval tool "${toolName}"`);
}
