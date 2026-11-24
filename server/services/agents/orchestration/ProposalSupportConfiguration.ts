import type { PlaybookGraph } from '../../../models/supportOrchestration/schema.js';
import type { DefaultSupportPlaybook, SupportAgentType } from './DefaultSupportConfiguration.js';

export const PROPOSAL_SUPPORT_TOOLS = [
  'get_conversation_proposals',
  'create_conversation_proposal_draft',
  'request_proposal_revision',
] as const;

export const PROPOSAL_SUPPORT_PROMPT = '\n\nFor a customer requesting a written proposal, capture their stated objective and requirements and use the enabled proposal tool. Account Proposal Settings decide whether eligible offers are automatically sent or require review. Explicit draft-only requests must remain unsent. Explain the actual tool result, not a presumed review requirement: only delivered=true confirms sending. For an existing proposal, use only the current conversation’s records. Revisions remain separate drafts until their changed commercial terms are verified. Never claim a proposal was accepted, booked or signed, and never invent a proposal link. Do not disclose internal drafts, approval notes, AI assumptions, or other customers’ proposals. These tools are for private customer conversations, not public social comments.';

const controls = {
  privacy: 'enforced', piiRedaction: 'enforced', safety: 'enforced',
  humanHandoff: 'enabled', toolApproval: 'required',
} as const;

const labels: Record<SupportAgentType, string> = {
  hotel_sales: 'Hotel sales', tech_support: 'Technical support', lead_qualifier: 'Lead qualification',
  customer_success: 'Customer success', general_service: 'General service',
};

/** Upgrade only the exact shipped v1 copy at read time; published snapshots and
 * custom owner instructions remain unchanged. This is not intent matching. */
export function currentProposalInstruction(instruction: string): string {
  return new Map([
    ['Record the customer’s stated proposal request through the authorized draft tool once. Explain only the confirmed result and that a seller must complete and review the offer before sending.', 'Prepare the customer’s proposal through the authorized tool once. Account settings determine optional review. If confirmedSideEffect=false, no proposal was recorded: explain the missing information without claiming a draft exists. Mention review only if seller_review_required=true. Claim sending only when delivered=true.'],
    ['Record the requested changes through the authorized tool once. Explain whether the request and separate draft were actually saved. The existing offer remains unchanged until the seller reviews and sends a replacement.', 'Prepare the requested change through the authorized tool once. Follow the returned result and optional account review setting. The existing offer remains unchanged until replacement delivery is confirmed. Mention review only if seller_review_required=true; claim sending only if delivered=true.'],
  ]).get(instruction) || instruction;
}

/** Each selectable specialist owns an equivalent scoped journey. Selecting a
 * technical/support mode must not strand a customer's proposal request. */
export function createProposalSupportPlaybooks(agentTypes: readonly SupportAgentType[]): DefaultSupportPlaybook[] {
  return agentTypes.flatMap(agentType => {
    const make = (kind: 'request' | 'status' | 'revision', name: string, description: string,
      fields: NonNullable<PlaybookGraph['fields']>, nodes: PlaybookGraph['nodes']): DefaultSupportPlaybook => {
      const key = `proposal-${kind}-${agentType}-v1`;
      const ordered = [{ id: 'start', type: 'trigger' as const, data: {} }, ...nodes,
        { id: 'complete', type: 'complete' as const, data: {} }];
      return {
        key, name: `Default · ${name} · ${labels[agentType]}`, description, agentType,
        assignments: [{ channel: null, intent: `proposal_${kind}`, agentType, priority: 90, trafficPercent: 100 }],
        graph: {
          schemaVersion: 2, entryNodeId: 'start', fields, nodes: ordered,
          edges: ordered.slice(0, -1).map((node, index) => ({
            id: `${node.id}-${ordered[index + 1].id}`, source: node.id, target: ordered[index + 1].id,
            condition: { operator: node.type === 'collect' ? 'all_required_fields_present' : 'always' },
          })),
          metadata: { templateKey: key, templateVersion: 1, systemDefault: true, agentType, controls },
        },
      };
    };
    return [
      make('request', 'Proposal request', 'Prepares the customer’s requested offer using the account’s optional review step.', [
        { key: 'proposal.title', type: 'text', required: true, pii: 'none',
          prompt: 'What service or outcome should the proposal cover?',
          validation: { minLength: 2, maxLength: 500, entityKeys: ['proposalTitle'] } },
        { key: 'proposal.context', type: 'text', required: true, pii: 'none',
          prompt: 'What deliverables, timeline, or other requirements should the seller consider?',
          validation: { minLength: 2, maxLength: 8000, entityKeys: ['proposalContext'] } },
      ], [
        { id: 'collect-request', type: 'collect', data: { fieldKeys: ['proposal.title', 'proposal.context'],
          instruction: 'Ask only for missing proposal requirements. Do not request contact details already linked to this conversation or promise a price.' } },
        { id: 'record-request', type: 'capability', data: {
          capabilityName: 'proposal.request',
          args: { title: { source: 'field', key: 'proposal.title' }, context: { source: 'field', key: 'proposal.context' } },
          instruction: 'Prepare the customer’s stated proposal through the authorized tool once. Follow the returned result: eligible offers may be automatically sent according to Proposal Settings; explicit draft-only requests remain drafts. Do not assume seller review is required. Claim sending only when delivered=true.',
        } },
      ]),
      make('status', 'Proposal status', 'Looks up customer-safe proposal status and sent pricing in the current conversation.', [], [
        { id: 'read-proposals', type: 'capability', data: {
          capabilityName: 'proposal.list', args: {},
          instruction: 'Look up this conversation’s proposals. Answer the customer’s question using only returned customer-safe status and sent pricing. If there are several, identify each by proposal number. Do not expose draft content or invent a public link.',
        } },
      ]),
      make('revision', 'Proposal change request', 'Records requested changes, pauses customer follow-ups, and prepares a separate draft for seller review.', [
        { key: 'proposal.number', type: 'text', required: true, pii: 'none',
          prompt: 'Which proposal would you like to change? Please use the proposal number shown on the offer.',
          validation: { minLength: 1, maxLength: 50, entityKeys: ['proposalNumber', 'proposal_number'], pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$' } },
        { key: 'proposal.changes', type: 'text', required: true, pii: 'none',
          prompt: 'What would you like the seller to change in that proposal?',
          validation: { minLength: 1, maxLength: 8000, entityKeys: ['requestedChanges', 'requested_changes'] } },
      ], [
        { id: 'collect-changes', type: 'collect', data: { fieldKeys: ['proposal.number', 'proposal.changes'],
          instruction: 'Ask only for the missing proposal reference or requested changes. Record the customer’s preference without promising new prices or terms.' } },
        { id: 'record-changes', type: 'capability', data: {
          capabilityName: 'proposal.revision_request',
          args: { proposal_number: { source: 'field', key: 'proposal.number' }, requested_changes: { source: 'field', key: 'proposal.changes' } },
          instruction: 'Record requested changes through the authorized tool once. Follow the returned result and the optional review setting. The existing offer remains unchanged until replacement delivery is confirmed. Explicit draft-only requests stay unsent. Never claim sending unless delivered=true.',
        } },
      ]),
    ];
  });
}
