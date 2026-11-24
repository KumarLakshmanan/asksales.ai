import { describe, expect, it } from '@jest/globals';
import {
  renderVerifiedHotelAvailabilityOptions,
  renderVerifiedHotelBookingSummary,
  renderVerifiedHotelPaymentMethods,
} from '../services/booking/HotelBookingSummary.js';
import { buildAtomicClaimEvidence, verifyKnowledgeClaims } from '../services/knowledge/KnowledgeClaimVerifier.js';
import type { ToolOutcome } from '../services/agents/BaseOutreachAgent.js';
import type { KnowledgeRetrievalResult } from '../services/knowledge/types.js';

describe('verified hotel booking summary', () => {
  const canonicalInput = { roomName: 'Premium Club Rooms', roomCount: 1, guests: 2,
    checkIn: '2026-09-15', checkOut: '2026-09-16', pricePerNight: 16992, currency: 'INR' };
  const availability = (): ToolOutcome => ({ name: 'check_room_availability',
    args: { check_in: canonicalInput.checkIn, check_out: canonicalInput.checkOut, guests: 2, rooms: 1 },
    result: { success: true, options: [{ name: canonicalInput.roomName, price_per_night: 16992, total_price: 16992, currency: 'INR' }] },
    status: 'success', success: true, confirmedSideEffect: false, reconciliationStatus: 'not_required' });
  const verify = (replyText: string, toolOutcomes: ToolOutcome[] = [availability()], retrieval?: KnowledgeRetrievalResult) =>
    verifyKnowledgeClaims({ claims: buildAtomicClaimEvidence({ replyText, toolOutcomes, retrieval }),
      toolOutcomes, retrieval, audience: 'customer', risk: 'transactional' });

  it('renders the canonical external-checkout confirmation boundary', () => {
    const summary = renderVerifiedHotelBookingSummary({
      roomName: 'Premium Club Rooms',
      roomCount: 1,
      guests: 2,
      checkIn: '2026-09-15',
      checkOut: '2026-09-16',
      pricePerNight: 16992,
      currency: 'INR',
    });
    expect(summary).toContain('- Room: 1 room — Premium Club Rooms');
    expect(summary).toContain('- Dates: 2026-09-15 to 2026-09-16');
    expect(summary).toContain('- Verified nightly rate: ₹16,992');
    expect(summary).toContain('Are you sure you want to book 1 room of this Premium Club Rooms');
    expect(summary).not.toMatch(/confirmed booking|payment received|inventory hold/i);

    const toolOutcome = {
      name: 'check_room_availability',
      args: { check_in: '2026-09-15', check_out: '2026-09-16', guests: 2, rooms: 1 },
      result: {
        success: true,
        options: [{ room_type_id: 5, name: 'Premium Club Rooms', price_per_night: 16992, total_price: 16992 }],
      },
      status: 'success' as const,
      success: true,
      confirmedSideEffect: false,
      reconciliationStatus: 'not_required' as const,
    };
    const claims = buildAtomicClaimEvidence({ replyText: summary, toolOutcomes: [toolOutcome] });
    expect(verifyKnowledgeClaims({ claims, toolOutcomes: [toolOutcome], audience: 'customer', risk: 'transactional' }))
      .toMatchObject({ mayDeliver: true, answerGrounding: 'grounded' });
  });

  it('renders every verified option as a WhatsApp-compatible numbered list', () => {
    const replyText = renderVerifiedHotelAvailabilityOptions({
      checkIn: '2026-09-15', checkOut: '2026-09-17', guests: 3,
      options: [
        { roomName: 'Premium Club Rooms', pricePerNight: 16992, currency: 'INR' },
        { roomName: 'Garden Villa Rooms', pricePerNight: 31270, currency: 'INR' },
      ],
    });
    expect(replyText).toContain('1. Premium Club Rooms — ₹16,992 per night');
    expect(replyText).toContain('2. Garden Villa Rooms — ₹31,270 per night');
    expect(replyText).not.toContain('•');
    const toolOutcome: ToolOutcome = { name: 'check_room_availability',
      args: { check_in: '2026-09-15', check_out: '2026-09-17', guests: 3 },
      result: { success: true, options: [
        { name: 'Premium Club Rooms', price_per_night: 16992, currency: 'INR' },
        { name: 'Garden Villa Rooms', price_per_night: 31270, currency: 'INR' },
      ] }, status: 'success', success: true, confirmedSideEffect: false, reconciliationStatus: 'not_required' };
    expect(verifyKnowledgeClaims({ claims: buildAtomicClaimEvidence({ replyText, toolOutcomes: [toolOutcome] }),
      toolOutcomes: [toolOutcome], audience: 'customer', risk: 'transactional' })).toMatchObject({ mayDeliver: true, answerGrounding: 'grounded' });
  });

  it.each([
    { success: true, payment_methods: ['Manual Payment at Hotel: Pay at reception.'] },
    { success: true, payment_methods: [], message: 'No payment methods are configured.' },
    { success: true, payment_methods: [], message: 'Payment methods are unavailable in this booking mode. Please use the hotel booking page for checkout.' },
  ])('grounds copied payment-method lookup text without inventing a payment receipt: %j', result => {
    const replyText = renderVerifiedHotelPaymentMethods(result)!;
    expect(replyText).toBeTruthy();
    const toolOutcome: ToolOutcome = { name: 'get_payment_methods', args: {}, result,
      status: 'success', success: true, confirmedSideEffect: false, reconciliationStatus: 'not_required' };
    expect(verifyKnowledgeClaims({ claims: buildAtomicClaimEvidence({ replyText, toolOutcomes: [toolOutcome] }),
      toolOutcomes: [toolOutcome], audience: 'customer', risk: 'transactional' })).toMatchObject({ mayDeliver: true, answerGrounding: 'grounded' });
  });
  it.each([{ success: false, payment_methods: ['Invented'] }, { success: true, payment_methods: [null] },
    { success: true, payment_methods: [] }])('does not render a failed or incomplete payment lookup: %j', result => {
    expect(renderVerifiedHotelPaymentMethods(result)).toBeNull();
  });

  it('grounds the server-defined external checkout handoff in its successful tool outcome', () => {
    const replyText = 'Your room selection is ready to continue. The hotel booking page will be included with this message. Availability, final price, payment, and confirmation are completed on that page.';
    const toolOutcome = {
      name: 'continue_external_booking',
      args: { room_type_id: 5, agreed_price_per_night: 16992 },
      result: { success: true, status: 'external_booking_ready', confirmedSideEffect: false },
      status: 'success' as const,
      success: true,
      confirmedSideEffect: false,
      reconciliationStatus: 'not_required' as const,
    };
    const claims = buildAtomicClaimEvidence({ replyText, toolOutcomes: [toolOutcome] });
    expect(verifyKnowledgeClaims({ claims, toolOutcomes: [toolOutcome], audience: 'customer', risk: 'transactional' }))
      .toMatchObject({ mayDeliver: true, answerGrounding: 'grounded' });
  });

  it('grounds a unique selected-room rate from a multi-option live result', () => {
    const summary = renderVerifiedHotelBookingSummary({
      roomName: 'Premium Club Rooms', roomCount: 1, guests: 3,
      checkIn: '2026-09-15', checkOut: '2026-09-17', pricePerNight: 16992, currency: 'INR',
    });
    const toolOutcome = {
      name: 'check_room_availability',
      args: { check_in: '2026-09-15', check_out: '2026-09-17', guests: 3, rooms: 1 },
      result: {
        success: true,
        options: [
          { room_type_id: 5, name: 'Premium Club Rooms', price_per_night: 16992, total_price: 33984 },
          { room_type_id: 8, name: 'Garden Villa Rooms', price_per_night: 31270, total_price: 62540 },
        ],
      },
      status: 'success' as const, success: true, confirmedSideEffect: false,
      reconciliationStatus: 'not_required' as const,
    };
    const claims = buildAtomicClaimEvidence({ replyText: summary, toolOutcomes: [toolOutcome] });
    expect(verifyKnowledgeClaims({ claims, toolOutcomes: [toolOutcome], audience: 'customer', risk: 'transactional' }))
      .toMatchObject({ mayDeliver: true, answerGrounding: 'grounded' });
  });

  it('grounds an Indian lakh-formatted nightly rate from the exact live quote', () => {
    const summary = renderVerifiedHotelBookingSummary({
      roomName: 'Sanctuary Villa Rooms', roomCount: 1, guests: 2,
      checkIn: '2026-09-12', checkOut: '2026-09-14', pricePerNight: 113870, currency: 'INR',
    });
    expect(summary).toContain('- Verified nightly rate: ₹1,13,870');
    const toolOutcome = {
      name: 'check_room_availability',
      args: {
        check_in: '2026-09-12', check_out: '2026-09-14', guests: 2, rooms: 1,
        room_type: 'Sanctuary Villa Rooms',
      },
      result: {
        success: true,
        options: [{
          room_type_id: 7, name: 'Sanctuary Villa Rooms',
          price_per_night: 113870, total_price: 227740,
        }],
      },
      status: 'success' as const, success: true, confirmedSideEffect: false,
      reconciliationStatus: 'not_required' as const,
    };
    const claims = buildAtomicClaimEvidence({ replyText: summary, toolOutcomes: [toolOutcome] });
    expect(claims).toContainEqual(expect.objectContaining({
      claim: 'Verified nightly rate: ₹1,13,870',
      origin: 'tool',
    }));
    expect(verifyKnowledgeClaims({ claims, toolOutcomes: [toolOutcome], audience: 'customer', risk: 'transactional' }))
      .toMatchObject({ mayDeliver: true, answerGrounding: 'grounded' });
  });

  it('grounds a verified no-availability result while treating alternative-date guidance as general', () => {
    const replyText = [
      'I have re-checked availability for 2026-09-17 to 2026-09-18 for 3 guests in 1 room.',
      'Unfortunately, we are fully booked for those specific dates.',
      'Would you be open to considering alternative dates? I would be happy to check other dates for you!',
    ].join(' ');
    const toolOutcome = {
      name: 'check_room_availability',
      args: { check_in: '2026-09-17', check_out: '2026-09-18', guests: 3, rooms: 1 },
      result: { success: true, count: 0, options: [], note: 'No rooms match those dates/occupancy.' },
      status: 'success' as const, success: true, confirmedSideEffect: false,
      reconciliationStatus: 'not_required' as const,
    };
    const claims = buildAtomicClaimEvidence({ replyText, toolOutcomes: [toolOutcome] });
    expect(verifyKnowledgeClaims({ claims, toolOutcomes: [toolOutcome], audience: 'customer', risk: 'transactional' }))
      .toMatchObject({ mayDeliver: true, answerGrounding: 'grounded' });
  });

  it('blocks invented alternative-date availability that the live lookup did not return', () => {
    const replyText = 'However, we have great availability on September 16th or September 18th.';
    const toolOutcome = {
      name: 'check_room_availability',
      args: { check_in: '2026-09-15', check_out: '2026-09-17', guests: 3, rooms: 1 },
      result: { success: true, count: 0, options: [], note: 'No rooms match those dates/occupancy.' },
      status: 'success' as const, success: true, confirmedSideEffect: false,
      reconciliationStatus: 'not_required' as const,
    };
    const claims = buildAtomicClaimEvidence({ replyText, toolOutcomes: [toolOutcome] });
    expect(verifyKnowledgeClaims({ claims, toolOutcomes: [toolOutcome], audience: 'customer', risk: 'transactional' }))
      .toMatchObject({ mayDeliver: false, answerGrounding: 'blocked' });
  });

  it('treats only the exact nonassertive canonical heading as general', () => {
    expect(buildAtomicClaimEvidence({ replyText: 'Here is your booking summary:' })[0].origin).toBe('general');
    expect(buildAtomicClaimEvidence({ replyText: 'Here is your confirmed booking summary:' })[0].origin).not.toBe('general');
  });

  it.each([
    { roomName: 'Unreturned Villa' }, { pricePerNight: 999 }, { checkIn: '2026-09-14' },
    { checkOut: '2026-09-17' }, { roomCount: 2 }, { guests: 3 }, { currency: 'USD' },
  ])('blocks a canonical-looking confirmation with a mutated tuple field %j', mutation => {
    const summary = renderVerifiedHotelBookingSummary({ ...canonicalInput, ...mutation });
    expect(verify(summary)).toMatchObject({ mayDeliver: false, answerGrounding: 'blocked' });
    expect(verify(summary).unsupportedClaims).toContain(summary.split('\n').at(-1));
  });

  it.each(['failed_status', 'failed_wrapper', 'failed_result', 'no_options'])('requires a successful live result: %s', failure => {
    const tool = availability();
    if (failure === 'failed_status') tool.status = 'failed';
    if (failure === 'failed_wrapper') tool.success = false;
    if (failure === 'failed_result') tool.result = { success: false, options: [{ name: canonicalInput.roomName, price_per_night: 16992 }] };
    if (failure === 'no_options') tool.result = { success: true, options: [], count: 0 };
    expect(verify(renderVerifiedHotelBookingSummary(canonicalInput), [tool]).mayDeliver).toBe(false);
  });

  it('does not ground the confirmation in an identical KB excerpt or unrelated tool output', () => {
    const summary = renderVerifiedHotelBookingSummary(canonicalInput);
    const retrieval: KnowledgeRetrievalResult = { status: 'sufficient', indexVersion: 'test',
      diagnostics: { queryFingerprint: 'fixture', candidateCount: 1, reranked: false, latencyMs: 0 },
      evidence: [{ evidenceId: 'KB-fixture', documentId: 1, versionId: 1, chunkId: '1', title: 'Copied summary',
        excerpt: summary, authority: 'tenant_policy', scores: { fused: 1 } }] };
    expect(verify(summary, [], retrieval).mayDeliver).toBe(false);
    expect(verify(summary, [{ ...availability(), name: 'get_ticket_status', result: summary }], retrieval).mayDeliver).toBe(false);
  });

  it('cannot combine a room from one option with another option’s rate or another lookup’s dates', () => {
    const tool = availability();
    tool.result = { success: true, options: [
      { name: canonicalInput.roomName, price_per_night: 16992, currency: 'INR' },
      { name: 'Garden Villa', price_per_night: 31270, currency: 'INR' },
    ] };
    expect(verify(renderVerifiedHotelBookingSummary({ ...canonicalInput, pricePerNight: 31270 }), [tool]).mayDeliver).toBe(false);
    const second = { ...availability(), args: { check_in: '2026-09-17', check_out: '2026-09-18', guests: 2, rooms: 1 },
      result: { success: true, options: [{ name: 'Garden Villa', price_per_night: 16992, currency: 'INR' }] } };
    expect(verify(renderVerifiedHotelBookingSummary({ ...canonicalInput, checkIn: '2026-09-17', checkOut: '2026-09-18' }),
      [availability(), second]).mayDeliver).toBe(false);
  });

  it('uses explicit option currency and never silently converts a returned USD quote to INR', () => {
    const tool = { ...availability(), result: { success: true, options: [{ name: canonicalInput.roomName,
      price_per_night: 16992, total_price: 16992, currency: 'USD' }] } };
    expect(verify(renderVerifiedHotelBookingSummary({ ...canonicalInput, currency: 'USD' }), [tool]).mayDeliver).toBe(true);
    expect(verify(renderVerifiedHotelBookingSummary(canonicalInput), [tool]).mayDeliver).toBe(false);
    expect(verify('Premium Club Rooms costs INR 16,992 per night.', [tool]).mayDeliver).toBe(false);
    expect(verify('Premium Club Rooms costs USD 16,992 per night.').mayDeliver).toBe(false);
  });

  it.each([
    'Guests: 2 guests and 9 rooms',
    'Check-in: 2026-09-15 for 9 guests',
    'I checked availability for 2026-09-15 to 2026-09-16 for 9 guests.',
    'I checked availability for 2026-10-15 to 2026-10-16 for 2 guests.',
    'I checked availability for September 16th to September 15th, 2026 for 2 guests.',
    'Dates: 2026-09-16 to 2026-09-15',
    'Dates: 2026-09-15 to 2026-09-16 (9 nights)',
    'Your booking is confirmed for 2 guests.',
  ])('does not let a typed availability shortcut conceal contradictory facts: %s', replyText => {
    expect(verify(replyText).mayDeliver).toBe(false);
  });

  it('still requires a committed booking action for a booking-completed assertion', () => {
    expect(verify(`${renderVerifiedHotelBookingSummary(canonicalInput)}\nYour booking is confirmed.`).mayDeliver).toBe(false);
  });
});
