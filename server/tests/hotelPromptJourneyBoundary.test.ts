import { describe, expect, it } from '@jest/globals';
import type { NLUResult } from '../services/agents/NLUService.js';
import {
  HotelSalesAgent,
  isAvailabilitySelectionBoundary,
  normalizeOwnerAvailabilityReadArgs,
  shouldRequireOwnerAvailabilityRead,
} from '../services/agents/HotelSalesAgent.js';

// Exercise the actual prompt assembly without invoking a model, tools, or DB.
function prompt(nodeType?: string, intent?: string): string {
  const agent = new HotelSalesAgent();
  const input = {
    ...(nodeType ? { playbookDirective: { nodeType, nodeId: 'configured-node' } } : {}),
  };
  return Reflect.apply(Reflect.get(agent, 'systemPrompt'), agent, [
    input, {}, null, '', 'whatsapp', true, true,
    intent ? { intent, secondaryIntents: [], sentiment: { label: 'neutral' }, entities: {} } : undefined,
  ]) as string;
}

describe('hotel prompt respects governed journey collection', () => {
  const datedNlu = (entities: Record<string, unknown>) => ({ intent: 'availability_inquiry', classificationConfidence: 0.99, entities } as NLUResult);
  it('requires the public availability read only for explicit dated owner-simulator requests', () => {
    expect(shouldRequireOwnerAvailabilityRead({
      executionMode: 'advisory',
      isSupportChat: true,
      inboundText: 'Show live room availability from 2026-10-05 to 2026-10-07.',
      nlu: datedNlu({ checkIn: '2026-10-05', checkOut: '2026-10-07' }),
    })).toBe(true);
    expect(shouldRequireOwnerAvailabilityRead({
      executionMode: 'advisory',
      isSupportChat: true,
      inboundText: 'Show a live day-use stay on 2026-10-05.',
      nlu: datedNlu({ checkIn: '2026-10-05', stayType: 'dayuse' }),
    })).toBe(true);
    expect(shouldRequireOwnerAvailabilityRead({
      executionMode: 'advisory',
      isSupportChat: true,
      inboundText: 'What rooms do you have?',
    })).toBe(false);
    expect(shouldRequireOwnerAvailabilityRead({
      executionMode: 'customer',
      isSupportChat: false,
      inboundText: 'Show availability from 2026-10-05 to 2026-10-07.',
    })).toBe(false);
  });

  it('normalizes explicit day-use search fields for the owner simulator', () => {
    expect(normalizeOwnerAvailabilityReadArgs(
      { checkIn: '2030-12-10', stayType: 'dayuse', adults: 2, children: 0, rooms: 1, promoCode: 'INSTAGRAM30', currency: 'INR' },
      { check_in: 'wrong', guests: 9 },
    )).toMatchObject({
      check_in: '2030-12-10',
      check_out: '2030-12-10',
      stay_type: 'dayuse',
      adults: 2,
      children: 0,
      guests: 2,
      rooms: 1,
      promo_code: 'INSTAGRAM30',
      currency: 'INR',
    });
  });

  it('normalizes a total guest count when adult breakdown is not supplied', () => {
    expect(normalizeOwnerAvailabilityReadArgs(
      { checkIn: '2030-12-10', checkOut: '2030-12-12', guests: 3, rooms: 2 },
      {},
    )).toMatchObject({
      check_in: '2030-12-10',
      check_out: '2030-12-12',
      stay_type: 'overnight',
      guests: 3,
      rooms: 2,
    });
  });

  it('accepts canonical query-style promo and currency fields', () => {
    expect(normalizeOwnerAvailabilityReadArgs(
      { promoCode: 'QA26', currency: 'INR' }, {},
    )).toMatchObject({ promo_code: 'QA26', currency: 'INR' });
  });

  it('preserves a singular child in an overnight search', () => {
    expect(normalizeOwnerAvailabilityReadArgs(
      { checkIn: '2032-02-05', checkOut: '2032-02-07', adults: 2, children: 1, rooms: 1 },
      {},
    )).toMatchObject({ adults: 2, children: 1, guests: 3, rooms: 1 });
  });

  it('renders verified options at both governed and owner-simulator selection boundaries', () => {
    expect(isAvailabilitySelectionBoundary(undefined, true)).toBe(true);
    expect(isAvailabilitySelectionBoundary('check-availability', false)).toBe(true);
    expect(isAvailabilitySelectionBoundary('collect-stay', false)).toBe(false);
  });

  it.each(['knowledge', undefined])('does not gate a FAQ on identity (%s node)', (nodeType) => {
    const text = prompt(nodeType, 'faq');
    expect(text).toContain('Answer only the current factual question');
    expect(text).toContain('without requesting identity');
    expect(text).not.toContain('Focus ONLY on obtaining');
    expect(text).not.toContain('Always end with a helpful next step');
    expect(text).not.toContain('immediately ask for their name');
  });

  it('gives configured collect nodes authority over the next missing field', () => {
    const text = prompt('collect', 'booking_request');
    expect(text).toContain('It alone selects which missing field to request');
    expect(text).toContain('Never override its current question');
  });

  it.each(['knowledge', 'collect', undefined])('retains booking identity and confirmation gates (%s node)', (nodeType) => {
    const text = prompt(nodeType, 'booking_request');
    expect(text).toContain('Do NOT call check_room_availability, create_booking, or continue_external_booking');
    expect(text).toContain('CONFIRM BEFORE BOOKING');
    expect(text).toContain('SIDE-EFFECT TRUTHFULNESS');
  });
});
