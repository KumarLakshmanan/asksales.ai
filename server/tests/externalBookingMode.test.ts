import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { safeExternalBookingUrl } from '../services/booking/ExternalBookingUrl.js';
import { plainTextEmailFallback, renderExternalBookingMessage } from '../services/booking/ExternalBookingDelivery.js';
import { validateSupportToolArgs } from '../services/agents/orchestration/SupportToolSchemas.js';
import { DEFAULT_SUPPORT_AGENT_PROFILES } from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import { buildExternalBookingSearchUrl } from '../services/booking/ExternalBookingSearchUrl.js';
import { capabilityOutcomeStatus } from '../services/agents/pipeline/stages/PostProcessingStage.js';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { up as addExternalBookingTool } from '../migrations/216_add_external_booking_tool.js';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { updateHotelBookingFallbackGraph } from '../migrations/277_redirect_missing_hotel_inventory_to_live_booking.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transaction = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbExecute = jest.fn<any>().mockResolvedValue({ rows: [] });
const searchAvailability = jest.fn<() => Promise<any[]>>().mockResolvedValue([]);
jest.unstable_mockModule('../services/booking/AvailabilityProvider.js', () => ({
  getAvailabilityProvider: () => ({ searchAvailability }),
}));
jest.unstable_mockModule('../models/db.js', () => ({
  db: { transaction, execute: dbExecute },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../services/booking/PaymentProvider.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getHotelPaymentConfiguration: jest.fn<any>().mockResolvedValue({
    configured: true,
    paymentMethodsEnabled: false,
    externalBooking: { url: 'https://booking.example/property?propertyId=10955&ref=owner', linkTitle: 'Continue your booking' },
    provider: 'razorpay',
    keyId: null,
    keySecret: null,
    webhookSecret: null,
    methods: { online: { enabled: true } },
  }),
  getPaymentProviderForUser: jest.fn(),
  validateExternalBookingUrlDestination: jest.fn(async (value: unknown) => safeExternalBookingUrl(value)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isMockPaymentAllowed: jest.fn<any>().mockReturnValue(false),
}));

const { BookingService } = await import('../services/booking/BookingService.js');
const { BookingSubAgent, hasExternalBookingContactMethod, requestsExternalBookingSearch } = await import('../services/agents/subagents/BookingSubAgent.js');
const { semanticIntent } = await import('./helpers/supportSemanticFixture.js');

const handoff = {
  mode: 'external_booking' as const,
  propertyId: 1,
  roomTypeId: 2,
  checkIn: '2026-09-01',
  checkOut: '2026-09-02',
  guests: 2,
  rooms: 1,
  url: 'https://booking.example/property?room=club&offer=a%2Bb',
  title: 'Continue & confirm',
  customerConfirmed: true as const,
};

describe('external booking mode', () => {
  beforeEach(() => {
    transaction.mockClear();
    dbExecute.mockReset().mockResolvedValue({ rows: [] });
    searchAvailability.mockReset().mockResolvedValue([]);
  });

  it('accepts only public credential-free HTTPS URLs and preserves the configured string', () => {
    expect(safeExternalBookingUrl(handoff.url)).toBe(handoff.url);
    expect(safeExternalBookingUrl('http://booking.example/property')).toBeNull();
    expect(safeExternalBookingUrl('https://user:secret@booking.example/property')).toBeNull();
    expect(safeExternalBookingUrl('https://localhost/booking')).toBeNull();
    expect(safeExternalBookingUrl('https://127.0.0.1/booking')).toBeNull();
    expect(safeExternalBookingUrl('https://192.168.1.20/booking')).toBeNull();
    expect(safeExternalBookingUrl('https://[::1]/booking')).toBeNull();
    expect(safeExternalBookingUrl('https://[::ffff:c0a8:101]/booking')).toBeNull();
  });

  it('blocks booking creation before a transaction or inventory hold starts', async () => {
    const result = await new BookingService().createBooking({
      userId: 7,
      conversationId: 9,
      roomTypeId: 2,
      guestName: 'Test Guest',
      guestEmail: 'guest@example.com',
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      guests: 2,
      rooms: 1,
      agreedPricePerNight: 5000,
    });
    expect(result).toMatchObject({ code: 'external_booking_required' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('keeps a pre-existing valid internal booking available after the mode switch', async () => {
    dbExecute.mockResolvedValueOnce({
      rows: [{
        id: 44,
        status: 'pending_payment',
        payment_status: 'pending',
        total_price: 5000,
        currency: 'INR',
        check_in_date: '2026-09-01',
        check_out_date: '2026-09-02',
        nights: 1,
        number_of_rooms: 1,
        room_type_id: 2,
        hotel_property_id: 1,
        payment_link: 'https://payments.example/existing',
        payment_provider: 'custom',
        hold_expires_at: '2026-09-01T12:00:00.000Z',
        inventory_reserved_at: '2026-08-19T12:00:00.000Z',
        inventory_released_at: null,
      }],
    });
    const result = await new BookingService().createBooking({
      userId: 7,
      conversationId: 9,
      roomTypeId: 2,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      guests: 2,
      rooms: 1,
      agreedPricePerNight: 5000,
    });
    expect(result).toMatchObject({
      booking: { id: 44, status: 'pending_payment' },
      paymentUrl: 'https://payments.example/existing',
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('renders exact URLs for chat and escaped links plus a plain fallback for email', () => {
    const chat = renderExternalBookingMessage(handoff, 'whatsapp');
    expect(chat).toContain(handoff.url);
    expect(chat).toContain('final price, payment, and confirmation are completed on that page');

    const email = renderExternalBookingMessage(handoff, 'email');
    expect(email).toContain('<a href="https://booking.example/property?room=club&amp;offer=a%2Bb">Continue &amp; confirm</a>');
    expect(email).toContain('Booking page: https://booking.example/property?room=club&amp;offer=a%2Bb');
    expect(plainTextEmailFallback(email)).toContain(handoff.url);
    expect(renderExternalBookingMessage(handoff, 'instagram_comment', false)).not.toContain(handoff.url);
  });

  it('builds an Oro search URL with canonical and multi-room parameters but no guest identity', () => {
    const url = buildExternalBookingSearchUrl({
      baseUrl: 'https://bookings.orocircle.com/?propertyId=10955&email=remove%40example.com',
      checkIn: '2026-10-05',
      checkOut: '2026-10-07',
      stayType: 'overnight',
      adults: 3,
      children: 1,
      rooms: 2,
      promoCode: 'OFFER26',
      currency: 'inr',
      roomOccupancies: [
        { adults: 2, children: 1, childAges: [5] },
        { adults: 1, children: 0 },
      ],
    });
    const parsed = new URL(url!);
    expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
      propertyId: '10955', checkIn: '2026-10-05', checkOut: '2026-10-07',
      stayType: 'overnight', adults: '3', children: '1', rooms: '2',
      promoCode: 'OFFER26', currency: 'INR', adults_1: '2', children_1: '1',
      childAges_1: '5', adults_2: '1', children_2: '0',
    });
    expect(parsed.searchParams.has('email')).toBe(false);
    expect(parsed.searchParams.has('phone')).toBe(false);
  });

  it('uses configured aliases and supports same-day day-use searches', () => {
    const url = buildExternalBookingSearchUrl({
      baseUrl: 'https://bookings.orocircle.com/?propertyId=10955&type=overnight&promo=OLD',
      checkIn: '2026-10-05', checkOut: '2026-10-05', stayType: 'dayuse',
      adults: 2, children: 0, rooms: 1, promoCode: 'DAY26',
    });
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('type')).toBe('dayuse');
    expect(parsed.searchParams.get('stayType')).toBeNull();
    expect(parsed.searchParams.get('promo')).toBe('DAY26');
    expect(parsed.searchParams.get('promoCode')).toBeNull();
  });

  it('redirects an empty local inventory result to the parameterized live booking search', async () => {
    const result = await new BookingSubAgent().execute('check_room_availability', {
      check_in: '2026-10-05', check_out: '2026-10-07', guests: 3,
      adults: 2, children: 1, rooms: 1, stay_type: 'overnight', promo_code: 'OFFER26', currency: 'INR',
    }, {
      userId: 7, conversationId: 9, channel: 'instagram', inboundText: 'Please check',
      nlu: { intent: 'availability_inquiry', secondaryIntents: [], entities: {}, sentiment: { label: 'neutral', score: 0 }, urgency: 'low', needsHuman: false, summary: '', riskLevel: 'low', riskFactors: [], classificationConfidence: 1 },
      slots: {}, memory: {}, intel: {}, lead: {}, agentConfig: null, history: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const url = new URL(result.externalBookingHandoff!.url);
    expect(result.externalBookingHandoff).toMatchObject({
      stage: 'search', propertyId: 10955, adults: 2, children: 1,
      guests: 3, rooms: 1, customerConfirmed: false,
    });
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      propertyId: '10955', checkIn: '2026-10-05', checkOut: '2026-10-07',
      adults: '2', children: '1', rooms: '1', stayType: 'overnight', promoCode: 'OFFER26', currency: 'INR',
    });
    expect(result.toolResults?.[0]?.result).toMatchObject({ status: 'external_booking_search_ready' });
    expect(String(result.toolResults?.[0]?.result?.note)).not.toMatch(/no rooms|sold out/i);
    expect(capabilityOutcomeStatus('availability.check', {
      name: 'check_room_availability', args: {}, result: result.toolResults?.[0]?.result,
      status: 'success', success: true, confirmedSideEffect: false,
    })).toBe('redirected');
    expect(renderExternalBookingMessage(result.externalBookingHandoff!, 'instagram'))
      .toContain('live rooms and rates');
  });

  it('honors an explicit search-link request even when local rooms exist, without collecting identity', async () => {
    searchAvailability.mockResolvedValueOnce([{
      roomTypeId: 4, name: 'Club Room', capacity: 2, pricePerNight: 5000,
      totalPrice: 10000, nights: 2, availableCount: 1, currency: 'INR', amenities: [],
    }]);
    const result = await new BookingSubAgent().execute('check_room_availability', {
      check_in: '2026-10-05', check_out: '2026-10-07', guests: 2,
      adults: 2, children: 0, rooms: 1, promo_code: 'QA26', currency: 'INR',
    }, {
      userId: 7, conversationId: 9, channel: 'web',
      inboundText: 'Give the official hotel booking link. Do not create a reservation.',
      nlu: { entities: {}, semanticRequest: semanticIntent('booking_link', 'stay') }, slots: {}, memory: {}, intel: {}, lead: {},
      agentConfig: null, history: [],
    } as any);
    expect(result.externalBookingHandoff).toMatchObject({ stage: 'search', customerConfirmed: false });
    expect(result.toolResults?.[0]?.result).toMatchObject({ count: 1, status: 'external_booking_search_ready', confirmedSideEffect: false });
    const url = new URL(result.externalBookingHandoff!.url);
    expect(url.searchParams.get('promoCode')).toBe('QA26');
    expect(url.searchParams.has('email')).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(requestsExternalBookingSearch(semanticIntent('booking_link', 'stay', { explicit: false }))).toBe(false);
    expect(requestsExternalBookingSearch(semanticIntent('information', 'stay'))).toBe(false);
  });

  it('adds a terminal redirected path to managed hospitality journey graphs', () => {
    const graph = updateHotelBookingFallbackGraph({
      schemaVersion: 2, entryNodeId: 'start', fields: [
        { key: 'stay.adults' }, { key: 'stay.children' },
      ],
      nodes: [
        { id: 'start', type: 'trigger', data: {} },
        { id: 'check-availability', type: 'capability', data: { args: {} } },
        { id: 'complete', type: 'complete', data: {} },
      ],
      edges: [], metadata: {},
    }, 3);
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: 'external-search-complete', type: 'complete' }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: 'check-availability', target: 'external-search-complete',
      condition: expect.objectContaining({ value: 'redirected' }),
    }));
  });

  it('accepts verified Meta sender identities for external checkout without treating them as phone numbers', () => {
    for (const channel of ['whatsapp', 'instagram', 'instagram_comment', 'facebook', 'facebook_comment']) {
      expect(hasExternalBookingContactMethod({
        channel,
        providerIdentity: 'provider-scoped-sender-id',
      })).toBe(true);
    }
    expect(hasExternalBookingContactMethod({ channel: 'email', providerIdentity: 'provider-id' })).toBe(false);
    expect(hasExternalBookingContactMethod({ channel: 'email', email: 'guest@example.com' })).toBe(true);
    expect(hasExternalBookingContactMethod({ channel: 'instagram', providerIdentity: '  ' })).toBe(false);
  });

  it('registers and validates the governed tool for every hotel agent configuration', () => {
    expect(validateSupportToolArgs('continue_external_booking', {
      room_type_id: 2,
      agreed_price_per_night: 5000,
    })).toMatchObject({ success: true });
    expect(validateSupportToolArgs('continue_external_booking', {
      room_type_id: 0,
      agreed_price_per_night: 5000,
    })).toMatchObject({ success: false });
    expect(DEFAULT_SUPPORT_AGENT_PROFILES.find((profile) => profile.type === 'hotel_sales')?.toolsEnabled)
      .toContain('continue_external_booking');
  });

  it('adds the capability globally to templates and existing hotel configurations', async () => {
    const statements: string[] = [];
    const client = { query: jest.fn(async (statement: string) => {
      statements.push(statement);
      return { rows: [] };
    }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await addExternalBookingTool(client as any);
    const migrationSql = statements.join('\n');
    expect(migrationSql).toContain('support_agent_templates');
    expect(migrationSql).toContain('ai_agent_configs');
    expect(migrationSql).toContain('continue_external_booking');
    expect(migrationSql).toContain("agent_type = 'hotel_sales'");
    expect(migrationSql).toContain("template_mode = 'managed'");
  });
});
