import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { parseJourneyDate } from '../services/agents/orchestration/JourneyDateParser.js';
import { INDUSTRY_SUPPORT_PLAYBOOKS } from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import { collectInstruction, collectJourneyFields, initializeJourneyState, missingFieldsForNode } from '../services/agents/orchestration/SupportJourneyRuntime.js';
import { collectContextPreface } from '../services/agents/orchestration/SupportCollectContext.js';
import { asJourneyState } from '../services/agents/orchestration/PlaybookEngine.js';

const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find(item => item.key === 'hospitality-sales-enquiries-v2')!.graph;
const stay = graph.nodes.find(node => node.id === 'collect-stay')!;
const contact = graph.nodes.find(node => node.id === 'collect-booking-contact')!;
const now = new Date('2026-09-19T05:00:00Z');
afterEach(() => { jest.useRealTimers(); });

describe('customer-reported date loops', () => {
  it.each(['27th sept check in', 'I have already mentioned 27th sept check in', 'check-in date is 27 September'])('parses %s without NLU', text => {
    expect(parseJourneyDate(text, 'stay.checkIn', true, now)).toBe('2026-09-27');
  });
  it('collects both labelled dates despite frustration and spelling, without reasking either', () => {
    jest.useFakeTimers().setSystemTime(now);
    const state = collectJourneyFields(graph, stay, initializeJourneyState(graph), {
      inboundText: "Aren't u able to understand check in date is 27th sept\nCheck out will b 28th sept",
    });
    expect(state.fields['stay.checkIn'].value).toBe('2026-09-27');
    expect(state.fields['stay.checkOut'].value).toBe('2026-09-28');
    expect(missingFieldsForNode(graph, stay, state)[0].key).toBe('stay.adults');
  });
  it('retains checkout supplied first without assigning it to check-in', () => {
    jest.useFakeTimers().setSystemTime(now);
    const state = collectJourneyFields(graph, stay, initializeJourneyState(graph), {
      inboundText: 'Check out 28th sept', entities: { checkIn: '2026-09-28', checkOut: '2026-09-28' },
    });
    expect(state.fields['stay.checkIn'].status).toBe('missing');
    expect(state.fields['stay.checkOut'].value).toBe('2026-09-28');
  });
  it.each(['This date', 'Within 7 days', '31st September', '09/10'])('does not guess ambiguous/invalid date %s', text => {
    expect(parseJourneyDate(text, 'stay.checkIn', true, now)).toBeUndefined();
  });
  it('handles relative dates and year rollover', () => {
    expect(parseJourneyDate('Tomorrow', 'stay.checkIn', true, now)).toBe('2026-09-20');
    expect(parseJourneyDate('Day after tomorrow', 'stay.checkOut', true, now)).toBe('2026-09-21');
    expect(parseJourneyDate('2nd Jan', 'stay.checkIn', true, now)).toBe('2027-01-02');
  });
});

describe('booking name consent', () => {
  const known = () => initializeJourneyState(graph, { contactId: 4, leadId: 5,
    fields: { fullName: { value: '[NAME_123]', vaultRef: 7, trust: 'provider' } } });
  it('asks before using a provider name, then accepts a fresh Yes without checkout consent', () => {
    const state = known();
    expect(missingFieldsForNode(graph, contact, state)[0].key).toBe('contact.fullName');
    expect(collectInstruction(graph, contact, state)).toContain('Reply Yes, or send Name:');
    const confirmed = collectJourneyFields(graph, contact, state, { inboundText: 'Yes' });
    expect(confirmed.fields['contact.fullName']).toMatchObject({ value: '[NAME_123]', source: 'crm', bookingNameConfirmed: true });
    expect(missingFieldsForNode(graph, contact, confirmed)).toHaveLength(0);
    expect(confirmed.fields['stay.confirmed'].status).toBe('missing');
  });
  it('does not consume a Yes from an earlier, automatically traversed step', () => {
    expect(collectJourneyFields(graph, contact, known(), { inboundText: 'Yes', allowPromptAnswer: false }).fields['contact.fullName'].bookingNameConfirmed).toBeUndefined();
  });
  it('uses a vault-bound replacement for this booking, not the provider identity', () => {
    const state = collectJourneyFields(graph, contact, known(), { inboundText: 'Name: [NAME_456]', vaultId: 8 });
    expect(state.fields['contact.fullName']).toMatchObject({ value: '[NAME_456]', source: 'customer', vaultRef: 8, bookingNameConfirmed: true });
  });
  it('does not rehydrate a profile name after the customer declines it', () => {
    const declined = collectJourneyFields(graph, contact, known(), { inboundText: 'No' });
    const hydrated = asJourneyState(graph, declined, { contactId: 4, leadId: 5,
      fields: { fullName: { value: '[NAME_123]', vaultRef: 7, trust: 'provider' } } });
    expect(hydrated.fields['contact.fullName']).toMatchObject({ status: 'missing', bookingNameDeclined: true });
    expect(collectInstruction(graph, contact, hydrated)).toContain('What name should I use');
  });
  it.each(['No', 'Yes but use another name', 'Maybe'])('does not treat %s as consent', inboundText => {
    expect(collectJourneyFields(graph, contact, known(), { inboundText }).fields['contact.fullName'].bookingNameConfirmed).toBeUndefined();
  });
});

describe('contextual collection', () => {
  it('acknowledges pricing instead of silently repeating a date question', () => {
    expect(collectContextPreface({ journey: { schemaVersion: 2, missingFields: ['stay.checkIn'], fields: {} } } as never, 'pricing_question')).toContain('check the price');
  });
  it('reflects different collected trip dates without adding names or invented facts', () => {
    const directive = (date: string) => ({ journey: { schemaVersion: 2, missingFields: ['stay.checkOut'], fields: {
      'stay.checkIn': { value: date, status: 'collected', source: 'customer' },
    } } }) as never;
    expect(collectContextPreface(directive('2026-09-27'))).toContain('2026-09-27');
    expect(collectContextPreface(directive('2026-10-05'))).toContain('2026-10-05');
    expect(collectContextPreface(directive('[NAME_123]'))).toBe('');
  });
});
