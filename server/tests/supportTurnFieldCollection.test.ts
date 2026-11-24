import { describe, expect, it } from '@jest/globals';
import type { PlaybookGraph, PlaybookRunStateV2 } from '../models/supportOrchestration/schema.js';
import { collectJourneyFields } from '../services/agents/orchestration/SupportJourneyRuntime.js';
const graph: PlaybookGraph = { schemaVersion: 2, entryNodeId: 'rooms', fields: [
  { key: 'stay.rooms', type: 'integer', required: true, pii: 'none', prompt: 'How many rooms?', validation: { min: 1, max: 20 } },
  { key: 'stay.preference', type: 'single_select', required: true, pii: 'none', prompt: 'Room preference?', options: [{ value: 'any', label: 'No preference' }] },
], nodes: [
  { id: 'rooms', type: 'collect', data: { fieldKeys: ['stay.rooms'] } },
  { id: 'preference', type: 'collect', data: { fieldKeys: ['stay.preference'] } },
], edges: [] };
const state = (): PlaybookRunStateV2 => ({ graphVersion: 2, fields: {
  'stay.checkIn': { value: '2026-09-26', status: 'collected', source: 'customer' },
  'stay.adults': { value: 2, status: 'collected', source: 'customer' },
  'stay.children': { value: 2, status: 'collected', source: 'customer' },
} });
describe('multi-message facts remain bound to the delivered prompt', () => {
  it('collects 1 room and a separate named preference without losing earlier dates or occupancy', () => {
    const input = { inboundText: '1\nNo preference', fragments: ['1', 'No preference'] };
    const rooms = collectJourneyFields(graph, graph.nodes[0], state(), input);
    expect(rooms.fields['stay.rooms'].value).toBe(1);
    const preferences = collectJourneyFields(graph, graph.nodes[1], rooms, { ...input, allowPromptAnswer: false });
    expect(preferences.fields['stay.preference'].value).toBe('any');
    expect(preferences.fields['stay.checkIn'].value).toBe('2026-09-26');
    expect(preferences.fields['stay.adults'].value).toBe(2);
    expect(preferences.fields['stay.children'].value).toBe(2);
  });
  it('does not guess between two conflicting bare numeric fragments', () => {
    const result = collectJourneyFields(graph, graph.nodes[0], state(), { inboundText: '1\n2', fragments: ['1', '2'] });
    expect(result.fields['stay.rooms']?.value).toBeUndefined();
  });
  it('does not reuse a numeric response for an unasked downstream field', () => {
    const result = collectJourneyFields(graph, graph.nodes[0], state(), { inboundText: '1\nThanks', fragments: ['1', 'Thanks'], allowPromptAnswer: false });
    expect(result.fields['stay.rooms']?.value).toBeUndefined();
  });
  it('keeps contact tokens tied to the vault of their original message', () => {
    const contactGraph: PlaybookGraph = { schemaVersion: 2, entryNodeId: 'contact', fields: [
      { key: 'contact.email', type: 'email', required: true, pii: 'contact', prompt: 'Email?' },
    ], nodes: [{ id: 'contact', type: 'collect', data: { fieldKeys: ['contact.email'] } }], edges: [] };
    const result = collectJourneyFields(contactGraph, contactGraph.nodes[0], state(), {
      inboundText: '[EMAIL_123456]\nMore details', fragments: ['[EMAIL_123456]', 'More details'],
      fragmentVaultIds: [41, 42], vaultId: 42, entities: { 'contact.email': '[EMAIL_123456]' },
    });
    expect(result.fields['contact.email'].vaultRef).toBe(41);
  });
});
