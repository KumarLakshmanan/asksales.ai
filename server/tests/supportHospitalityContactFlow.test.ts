import { describe, expect, it } from '@jest/globals';
import { INDUSTRY_SUPPORT_PLAYBOOKS } from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import { collectJourneyFields, initializeJourneyState } from '../services/agents/orchestration/SupportJourneyRuntime.js';
import { supportContactReferences } from '../services/agents/orchestration/SupportContactReferences.js';
import { sanitizeStructuredForModel } from '../services/agents/orchestration/PrivacyVaultService.js';
import { resolveCapabilityBindings, validateResolvedCapability } from '../services/agents/orchestration/SupportCapabilityRegistry.js';

const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find(item => item.key === 'hospitality-sales-enquiries-v2')!.graph;
const node = (id: string) => graph.nodes.find(item => item.id === id)!;
describe('document-aligned hospitality contact collection', () => {
  it.each([
    ['dining', 'collect-service-request', ['service.dateTime', 'service.adults', 'service.children', 'contact.fullName', 'callback.preferredPhone', 'callback.consent']],
    ['spa', 'collect-spa-request', ['service.dateTime', 'contact.fullName', 'callback.preferredPhone', 'callback.consent']],
    ['outing', 'collect-service-request', ['service.dateTime', 'service.adults', 'service.children', 'contact.fullName', 'callback.preferredPhone', 'callback.consent']],
  ])('keeps %s booking intake separate from a callback request', (service, bookingDestination, fields) => {
    const book = graph.edges.find(item => item.source === `collect-${service}-next` && item.condition?.value === 'book');
    const callback = graph.edges.find(item => item.source === `collect-${service}-next` && item.condition?.value === 'callback');
    expect(book?.target).toBe(bookingDestination);
    expect(callback?.target).toBe('collect-information-callback');
    expect(node(bookingDestination as string).data!.fieldKeys).toEqual(fields);
    expect(node('collect-information-callback').data!.fieldKeys).toEqual([
      'contact.fullName', 'callback.preferredPhone', 'callback.preferredTime', 'callback.consent',
    ]);
  });
  it.each(['collect-callback', 'collect-corporate-contact', 'collect-celebration-contact', 'collect-information-callback', 'collect-other'])(
    'asks for a preferred number in %s without assuming the sender number', id => {
      expect(node(id).data!.fieldKeys).toContain('callback.preferredPhone');
      expect(graph.fields!.find(field => field.key === 'callback.preferredPhone')!.profileBinding).toBeUndefined();
    });
  it.each(['collect-resort-next', 'collect-activities-next', 'collect-location-next'])(
    'keeps %s information questions out of contact collection', id => {
      expect(graph.edges.find(edge => edge.source === id && edge.condition?.value === 'more_info')?.target).toBe('collect-information-question');
      expect(node('collect-information-question').data!.fieldKeys).toEqual(['information.question']);
    });
  it('does not require a callback time for a consented dining/spa enquiry', () => {
    const state = initializeJourneyState(graph);
    state.fields['callback.consent'] = { value: true, status: 'collected', source: 'customer' };
    state.fields['service.dateTime'] = { value: '23 September 2026 at 4 PM', status: 'collected', source: 'customer' };
    const args = resolveCapabilityBindings(node('create-service-inquiry').data!.args, state.fields,
      { channel: 'whatsapp', conversationId: 1, contactAvailable: true }) as Record<string, unknown>;
    expect(args.consent).toBe(true);
    expect(args.callback).toBeUndefined();
    expect(validateResolvedCapability('inquiry.create', args, { agentType: 'hotel_sales', contactAvailable: true })).toEqual([]);
  });
  it('stores an explicitly supplied preferred number with its original vault/token pair', () => {
    const state = initializeJourneyState(graph);
    state.fields['contact.fullName'] = { value: '[NAME_1]', status: 'collected', source: 'customer', vaultRef: 88 };
    const collected = collectJourneyFields(graph, node('collect-callback'), state, {
      inboundText: 'Please call [PHONE_2]', vaultId: 99,
      entities: { preferredCallbackNumber: '[PHONE_2]' },
    });
    expect(collected.fields['callback.preferredPhone']).toEqual({ value: '[PHONE_2]', status: 'collected', source: 'customer', vaultRef: 99 });
    const references = supportContactReferences(collected.fields);
    expect(references).toEqual([
      { fieldKey: 'contact.fullName', placeholder: '[NAME_1]', vaultRef: 88 },
      { fieldKey: 'callback.preferredPhone', placeholder: '[PHONE_2]', vaultRef: 99 },
    ]);
    expect(sanitizeStructuredForModel({ contactReferences: references }).value).toEqual({ contactReferences: references });
  });
  it.each([
    { inboundText: 'Use the other number', vaultId: 99, entities: { preferredCallbackNumber: '[PHONE_2]' } },
    { inboundText: 'Please call [PHONE_2]', entities: { preferredCallbackNumber: '[PHONE_2]' } },
    { inboundText: 'Please call 5550100123', vaultId: 99, entities: { preferredCallbackNumber: '5550100123' } },
  ])('rejects contact data without current-turn token provenance or a vault', input => {
    const state = initializeJourneyState(graph);
    state.fields['contact.fullName'] = { value: '[NAME_1]', status: 'collected', source: 'customer', vaultRef: 88 };
    const result = collectJourneyFields(graph, node('collect-callback'), state, input);
    expect(result.fields['callback.preferredPhone'].status).toBe('missing');
    expect(supportContactReferences(result.fields)).toHaveLength(1);
  });
  it('excludes raw, invalid and unvaulted references', () => {
    expect(supportContactReferences({
      'contact.fullName': { value: 'Private Name', status: 'collected', source: 'customer', vaultRef: 88 },
      'callback.preferredPhone': { value: '[PHONE_1]', status: 'invalid', source: 'customer', vaultRef: 99 },
    })).toEqual([]);
  });
});
