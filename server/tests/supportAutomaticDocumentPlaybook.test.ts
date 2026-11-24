import { describe, expect, it } from '@jest/globals';
import { automaticHospitalityDocuments } from '../services/agents/orchestration/AutomaticDocumentPlaybook.js';
import { INDUSTRY_SUPPORT_PLAYBOOKS } from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import { validatePlaybookGraph } from '../services/agents/orchestration/PlaybookEngine.js';

describe('scoped automatic document playbook upgrade', () => {
  it('upgrades only brochure steps, preserving the information, collection and consent flows', () => {
    const source = structuredClone(INDUSTRY_SUPPORT_PLAYBOOKS.find(item => item.key === 'hospitality-sales-enquiries-v2')!.graph);
    for (const id of ['answer-resort-details','answer-day-outing']) {
      const node = source.nodes.find(item => item.id === id)!;
      node.data = { ...node.data,capabilityName:'knowledge.answer',args:{query:{source:'constant',value:'Prior published brochure query'}} };
    }
    const before = structuredClone(source);
    const result = automaticHospitalityDocuments(source);
    expect(source).toEqual(before);
    expect(validatePlaybookGraph(result)).toEqual([]);
    expect(result.fields).toEqual(source.fields); expect(result.edges).toEqual(source.edges);
    for (const node of result.nodes) {
      if (!['answer-resort-details','answer-day-outing'].includes(node.id)) {
        expect(node).toEqual(source.nodes.find(item => item.id === node.id));
      } else {
        expect(node.data?.capabilityName).toBe('asset.deliver');
        expect(node.data?.args).not.toHaveProperty('documentId');
      }
    }
  });
  it('rejects an unexpected replacement of the owner’s document node', () => {
    const source = structuredClone(INDUSTRY_SUPPORT_PLAYBOOKS.find(item => item.key === 'hospitality-sales-enquiries-v2')!.graph);
    source.nodes = source.nodes.filter(item => item.id !== 'answer-day-outing');
    expect(() => automaticHospitalityDocuments(source)).toThrow('Unexpected document node');
  });
});
