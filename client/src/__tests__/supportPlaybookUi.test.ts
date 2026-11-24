import { describe, expect, it } from 'vitest';
import { groupSupportPlaybooks, preferredPlaybookId, sortSupportPlaybooks, orderedPlaybookNodes } from '@/lib/support-playbook-ui';

describe('support playbook dashboard ordering', () => {
  it('shows all reachable branches, cycles once, and disconnected nodes explicitly', () => {
    const graph = { entryNodeId: 'start', nodes: ['end', 'orphan', 'left', 'start', 'right'].map(id => ({ id })), edges: [{ source: 'start', target: 'left' }, { source: 'start', target: 'right' }, { source: 'left', target: 'end' }, { source: 'right', target: 'start' }] };
    expect(orderedPlaybookNodes(graph).map(({ node, reachable }) => [node.id, reachable])).toEqual([['start', true], ['left', true], ['right', true], ['end', true], ['orphan', false]]);
  });
  const items = [
    { id: 1, status: 'archived', enabled: true, activeVersion: 2 },
    { id: 2, status: 'draft', enabled: true, activeVersion: null },
    { id: 3, status: 'published', enabled: true, activeVersion: 10 },
    { id: 4, status: 'published', enabled: false, activeVersion: 9 },
  ];

  it('opens the enabled published journey instead of an archived legacy playbook', () => {
    expect(preferredPlaybookId(items)).toBe(3);
  });

  it('keeps live journeys first and archived journeys last', () => {
    expect(sortSupportPlaybooks(items).map((item) => item.id)).toEqual([3, 4, 2, 1]);
  });

  it('keeps archived journeys out of the current workspace', () => {
    const groups = groupSupportPlaybooks(items);

    expect(groups.current.map((item) => item.id)).toEqual([3, 4, 2]);
    expect(groups.archived.map((item) => item.id)).toEqual([1]);
  });

  it('does not open an archived journey when no current journey exists', () => {
    expect(preferredPlaybookId([items[0]])).toBeNull();
  });
});
