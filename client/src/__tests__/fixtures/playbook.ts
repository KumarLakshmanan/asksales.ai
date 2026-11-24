import type { PlaybookGraph } from '@/components/support/PlaybookGraphEditor';

/** Synthetic proposal journey with the shipped revision capability and field bindings. */
export function proposalGraphFixture(capabilityName = 'proposal.revision_request'): PlaybookGraph {
  return {
    schemaVersion: 2,
    entryNodeId: 'start',
    metadata: { agentType: 'hotel_sales' },
    fields: [
      { key: 'proposal.number', type: 'text', required: true, pii: 'none', prompt: 'Which proposal would you like to change?' },
      { key: 'proposal.changes', type: 'text', required: true, pii: 'none', prompt: 'What would you like to change?' },
    ],
    nodes: [
      { id: 'start', type: 'trigger', data: {} },
      { id: 'collect-changes', type: 'collect', data: { fieldKeys: ['proposal.number', 'proposal.changes'] } },
      { id: 'record-changes', type: 'capability', data: { label: 'Record changes', capabilityName,
        args: { proposal_number: { source: 'field', key: 'proposal.number' }, requested_changes: { source: 'field', key: 'proposal.changes' } } } },
      { id: 'complete', type: 'complete', data: {} },
    ],
    edges: [
      { source: 'start', target: 'collect-changes', condition: { operator: 'always' } },
      { source: 'collect-changes', target: 'record-changes', condition: { operator: 'all_required_fields_present' } },
      { source: 'record-changes', target: 'complete', condition: { operator: 'always' } },
    ],
  };
}
