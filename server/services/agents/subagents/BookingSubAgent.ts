import { SubAgentBase, SubAgentContext, SubAgentResult } from './SubAgentBase.js';
import { getAvailabilityProvider } from '../../booking/AvailabilityProvider.js';
import { recommendationService } from '../../booking/RecommendationService.js';
import { getHotelPaymentConfiguration, validateExternalBookingUrlDestination } from '../../booking/PaymentProvider.js';
import { db } from '../../../models/db.js';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { explicitCustomerConfirmation } from '../orchestration/SupportJourneyRuntime.js';
import { confidentSemanticIntent, type SupportSemanticIntent } from '../orchestration/SupportSemanticIntent.js';
import {
  buildExternalBookingSearchUrl,
  externalPropertyIdFromUrl,
} from '../../booking/ExternalBookingSearchUrl.js';

const LARGE_GROUP_ROOMS = Number(process.env.SALES_LARGE_GROUP_ROOMS || 5);

/** A search-page link is not a confirmed checkout or a local reservation. */
export function requestsExternalBookingSearch(request?: SupportSemanticIntent): boolean {
  const semantic = confidentSemanticIntent(request);
  return semantic?.explicit === true && semantic.action === 'booking_link';
}

export function normalizeOptionalRoomPreference(value: unknown): string | undefined {
  const requested = typeof value === 'string' ? value.trim() : '';
  return /^(?:no\s+preference|any(?:\s+(?:room|villa|option))?|all(?:\s+(?:rooms?|villas?|options?))?)$/i.test(requested)
    ? undefined
    : requested || undefined;
}

export function selectAvailableRoomTypeId(
  selection: unknown,
  availableIds: number[],
  roomTypes: Array<{ id: number; name: string }>,
): number | undefined {
  const requested = String(selection || '').trim();
  if (!requested || availableIds.length === 0) return undefined;
  if (/^\d+$/.test(requested)) {
    const index = Number(requested) - 1;
    return availableIds[index];
  }
  const normalized = requested.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const candidates = roomTypes.filter((room) => availableIds.includes(room.id));
  return candidates.find((room) => room.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === normalized)?.id
    ?? candidates.find((room) => {
      const name = room.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      return name.includes(normalized) || normalized.includes(name);
    })?.id;
}

export function resolveExternalCheckoutPrice(input: {
  boundPrice?: unknown;
  availabilityPrice: unknown;
  negotiatedPrice?: unknown;
  negotiatedForSelectedRoom: boolean;
}): number {
  return Number(input.boundPrice
    ?? (input.negotiatedForSelectedRoom ? input.negotiatedPrice : input.availabilityPrice));
}

export function availabilityQuoteRequiresRefresh(input: {
  expiresAt: unknown;
  availableRoomTypeIds: unknown;
  roomTypeId: number;
  now?: number;
}): boolean {
  const expiresAt = Date.parse(String(input.expiresAt || ''));
  const availableRoomTypeIds = Array.isArray(input.availableRoomTypeIds)
    ? input.availableRoomTypeIds.map(Number).filter(Number.isSafeInteger)
    : [];
  return !Number.isFinite(expiresAt)
    || expiresAt < (input.now ?? Date.now())
    || !availableRoomTypeIds.includes(input.roomTypeId);
}

export function hasGovernedExternalBookingConfirmation(ctx: SubAgentContext): boolean {
  const directive = ctx.playbookDirective;
  const confirmed = directive?.journey?.fields?.['stay.confirmed'];
  return directive?.requiredAction === 'continue_external_booking'
    && directive.nodeId === 'continue-booking'
    && confirmed?.value === true
    && (confirmed.status === 'collected' || confirmed.status === 'verified');
}

const PROVIDER_CONTACT_CHANNELS = new Set([
  'whatsapp',
  'instagram',
  'instagram_comment',
  'facebook',
  'facebook_comment',
]);

/**
 * External checkout only needs a verified way to continue the conversation;
 * it does not create a local booking record that requires a phone number.
 * Official provider sender identities are therefore valid contact methods on
 * every supported conversational Meta channel. They remain channel identities
 * and must never be persisted into a guest phone/email column.
 */
export function hasExternalBookingContactMethod(input: {
  channel: string;
  phone?: unknown;
  email?: unknown;
  providerIdentity?: unknown;
}): boolean {
  if (String(input.phone || '').trim() || String(input.email || '').trim()) return true;
  return PROVIDER_CONTACT_CHANNELS.has(input.channel)
    && Boolean(String(input.providerIdentity || '').trim());
}

function playbookField(ctx: SubAgentContext, key: string): unknown {
  const field = ctx.playbookDirective?.journey?.fields?.[key];
  return field && (field.status === 'collected' || field.status === 'verified') ? field.value : undefined;
}

function normalizeStayType(value: unknown): 'overnight' | 'dayuse' {
  return /^(?:day[\s_-]*use|day[\s_-]*stay)$/i.test(String(value || '').trim()) ? 'dayuse' : 'overnight';
}

export class BookingSubAgent extends SubAgentBase {
  readonly metadata = {
    id: 'booking',
    name: 'Booking Sub-Agent',
    description: 'Manages room availability checks, collected booking details, and booking creation.',
    intents: ['booking_request', 'availability_inquiry', 'modify_booking'],
    priority: 10,
    tools: [
      {
        type: 'function',
        function: {
          name: 'check_room_availability',
          description: 'Check live room availability and nightly pricing for a date range and guest count. Only call once you have check-in date, check-out date, and number of guests.',
          parameters: {
            type: 'object',
            properties: {
              check_in: { type: 'string', description: 'Check-in date, YYYY-MM-DD.' },
              check_out: { type: 'string', description: 'Check-out date, YYYY-MM-DD.' },
              guests: { type: 'integer', description: 'Number of guests.' },
              adults: { type: 'integer', description: 'Number of adults, when known.' },
              children: { type: 'integer', description: 'Number of children, when known.' },
              rooms: { type: 'integer', description: 'Number of rooms (default 1).' },
              room_type: { type: 'string', description: 'Optional room type filter, e.g. "deluxe".' },
              stay_type: { type: 'string', enum: ['overnight', 'dayuse'], description: 'Overnight stay or day use.' },
              promo_code: { type: 'string', description: 'Optional public promotion code.' },
              currency: { type: 'string', description: 'Optional three-letter display currency.' },
            },
            required: ['check_in', 'check_out', 'guests'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'continue_external_booking',
          description: 'Validate a confirmed room selection for a property using external checkout. Call only after current availability and pricing have been verified, the complete booking summary was shown, and the customer explicitly confirmed it. The delivery layer appends the owner-approved URL; never write or modify a URL yourself.',
          parameters: {
            type: 'object',
            properties: {
              room_type_id: { type: 'integer' },
              agreed_price_per_night: { type: 'number' },
              guest_name: { type: 'string' },
              guest_email: { type: 'string' },
            },
            required: ['room_type_id', 'agreed_price_per_night'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'save_booking_details',
          description: 'Persist booking details the customer has provided so far (slot-filling). Call whenever the customer gives any of: dates, guest count, rooms, chosen room type, guest name, guest phone number, or special requests. Returns the current collected state and what is still missing.',
          parameters: {
            type: 'object',
            properties: {
              check_in: { type: 'string' }, check_out: { type: 'string' },
              guests: { type: 'integer' }, rooms: { type: 'integer' },
              room_type_id: { type: 'integer', description: 'Chosen room type id (from availability results).' },
              guest_name: { type: 'string', description: 'The customer\'s real name.' },
              guest_phone: { type: 'string', description: 'The customer\'s telephone/contact phone number.' },
              guest_email: { type: 'string' },
              special_requests: { type: 'string' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'create_booking',
          description: 'Validate and propose a governed booking action. Only call after explicit confirmation with check-in, check-out, guests, a chosen room_type_id, current availability, and an approved nightly price. A proposal is not a confirmed booking and does not provide a payment link.',
          parameters: {
            type: 'object',
            properties: {
              room_type_id: { type: 'integer' },
              agreed_price_per_night: { type: 'number' },
              guest_name: { type: 'string' },
              guest_email: { type: 'string' },
              included_perks: { type: 'array', items: { type: 'string' }, description: 'Perks you promised the customer during negotiation (e.g. "Complimentary breakfast for 2"), so the hotel honors them.' },
            },
            required: ['room_type_id', 'agreed_price_per_night'],
          },
        },
      },
    ],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(name: string, args: any, ctx: SubAgentContext): Promise<SubAgentResult> {
    const { userId, conversationId, channel, slots } = ctx;

    switch (name) {
      case 'check_room_availability': {
        if (!args.check_in || !args.check_out) {
          return {
            toolResults: [{
              name,
              result: { error: 'Both check_in and check_out dates are required. Ask the guest for these dates.' }
            }]
          };
        }
        const stayType = normalizeStayType(args.stay_type ?? playbookField(ctx, 'stay.stayType'));
        const checkInTime = new Date(args.check_in + 'T00:00:00Z').getTime();
        const checkOutTime = new Date(args.check_out + 'T00:00:00Z').getTime();
        if (isNaN(checkInTime) || isNaN(checkOutTime)
          || checkOutTime < checkInTime || (stayType === 'overnight' && checkOutTime === checkInTime)) {
          return {
            toolResults: [{
              name,
              result: { error: 'Invalid check-in or check-out date range. Make sure check-out is after check-in, and format is YYYY-MM-DD. Ask the guest to clarify.' }
            }]
          };
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slotsUpdate: Record<string, any> = {};
        if (args.check_in) slotsUpdate.checkIn = args.check_in;
        if (args.check_out) slotsUpdate.checkOut = args.check_out;
        if (args.guests) slotsUpdate.guests = Number(args.guests);
        if (args.rooms) slotsUpdate.rooms = Number(args.rooms);

        const mergedSlots = { ...slots, ...slotsUpdate };

        const roomTypeName = normalizeOptionalRoomPreference(args.room_type);
        const options = await getAvailabilityProvider().searchAvailability({
          userId,
          checkIn: args.check_in,
          checkOut: args.check_out,
          guests: Number(args.guests),
          rooms: args.rooms ? Number(args.rooms) : 1,
          roomTypeName,
        });

        const rec = recommendationService.recommend(options, {
          guests: Number(args.guests) || mergedSlots.guests,
          rooms: args.rooms ? Number(args.rooms) : mergedSlots.rooms,
          travelReason: ctx.memory.travelReason,
          budgetPerNight: ctx.nlu.entities.budgetPerNight || ctx.memory.budgetPerNight,
        });

        const reasonById = new Map(rec.ranked.map((r) => [r.roomTypeId, r.reason]));
        const result = {
          success: true,
          confirmedSideEffect: false,
          count: options.length,
          options: options.map((o) => ({
            room_type_id: o.roomTypeId,
            name: o.name,
            capacity: o.capacity,
            price_per_night: o.pricePerNight,
            total_price: o.totalPrice,
            nights: o.nights,
            available: o.availableCount,
            currency: o.currency,
            amenities: o.amenities,
            why: reasonById.get(o.roomTypeId),
          })),
          recommended_room_type_id: rec.topPick?.roomTypeId,
          recommendation: rec.topPick ? `${rec.topPick.name} — ${rec.topPick.reason}` : undefined,
          note: options.length === 0 ? 'No rooms match those dates/occupancy.' : undefined,
        };

        const availabilityCheckedAt = new Date();
        slotsUpdate.availabilityCheckedAt = availabilityCheckedAt.toISOString();
        slotsUpdate.availabilityExpiresAt = new Date(availabilityCheckedAt.getTime() + 15 * 60 * 1000).toISOString();
        slotsUpdate.availableRoomTypeIds = options.map((option) => option.roomTypeId);
        slotsUpdate.quotedPricesByRoomType = Object.fromEntries(options.map((option) => [String(option.roomTypeId), option.pricePerNight]));

        const requestedSearchLink = requestsExternalBookingSearch(ctx.nlu.semanticRequest);
        if (options.length === 0 || requestedSearchLink) {
          const paymentConfig = await getHotelPaymentConfiguration(userId);
          const approvedUrl = paymentConfig.paymentMethodsEnabled
            ? null
            : await validateExternalBookingUrlDestination(paymentConfig.externalBooking.url);
          if (approvedUrl) {
            const children = Number(args.children ?? playbookField(ctx, 'stay.children'));
            const adults = Number(args.adults ?? playbookField(ctx, 'stay.adults'));
            const guests = Number(args.guests);
            const normalizedChildren = Number.isSafeInteger(children) && children >= 0 ? children : 0;
            const normalizedAdults = Number.isSafeInteger(adults) && adults > 0
              ? adults
              : Math.max(1, guests - normalizedChildren);
            const rooms = args.rooms ? Number(args.rooms) : 1;
            const searchUrl = buildExternalBookingSearchUrl({
              baseUrl: approvedUrl,
              propertyId: externalPropertyIdFromUrl(approvedUrl),
              checkIn: String(args.check_in),
              checkOut: String(args.check_out),
              stayType,
              adults: normalizedAdults,
              children: normalizedChildren,
              rooms,
              promoCode: args.promo_code ?? playbookField(ctx, 'stay.promoCode'),
              currency: args.currency ?? playbookField(ctx, 'stay.currency'),
            });
            if (searchUrl) {
              const propertyId = externalPropertyIdFromUrl(searchUrl);
              const urlFingerprint = crypto.createHash('sha256').update(searchUrl).digest('hex');
              const handoff = {
                mode: 'external_booking' as const,
                stage: 'search' as const,
                ...(propertyId ? { propertyId } : {}),
                checkIn: String(args.check_in),
                checkOut: String(args.check_out),
                guests,
                adults: normalizedAdults,
                children: normalizedChildren,
                rooms,
                stayType,
                url: searchUrl,
                title: paymentConfig.externalBooking.linkTitle || 'View live rooms and rates',
                customerConfirmed: false,
              };
              return {
                toolResults: [{
                  name,
                  result: {
                    ...result,
                    status: 'external_booking_search_ready',
                    note: requestedSearchLink
                      ? 'The guest requested the official search page. The delivery layer will share the verified booking search; no room selection, reservation, or payment is confirmed.'
                      : 'Local inventory did not provide a verified result. The delivery layer will share the live booking search; do not infer availability from the local data.',
                  },
                }],
                slotsUpdate,
                externalBookingHandoff: handoff,
                effectProposals: [{
                  type: 'external_booking_referral',
                  payload: {
                    stage: 'search',
                    propertyId: propertyId ?? null,
                    checkIn: handoff.checkIn,
                    checkOut: handoff.checkOut,
                    guests,
                    adults: normalizedAdults,
                    children: normalizedChildren,
                    rooms,
                    stayType,
                    urlFingerprint,
                    customerConfirmed: false,
                  },
                }],
              };
            }
          }
        }

        return { toolResults: [{ name, result }], slotsUpdate };
      }

      case 'save_booking_details': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slotsUpdate: Record<string, any> = {};
        if (args.check_in) slotsUpdate.checkIn = args.check_in;
        if (args.check_out) slotsUpdate.checkOut = args.check_out;
        if (args.guests) slotsUpdate.guests = Number(args.guests);
        if (args.rooms) slotsUpdate.rooms = Number(args.rooms);
        if (args.room_type_id) slotsUpdate.roomTypeId = Number(args.room_type_id);
        if (args.guest_name) slotsUpdate.guestName = args.guest_name;
        if (args.guest_phone) slotsUpdate.guestPhone = args.guest_phone;
        if (args.guest_email) slotsUpdate.guestEmail = args.guest_email;
        if (args.special_requests) slotsUpdate.specialRequests = args.special_requests;

        const mergedSlots = { ...slots, ...slotsUpdate };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const missing = ['checkIn', 'checkOut', 'guests', 'roomTypeId'].filter((k) => !(mergedSlots as any)[k]);
        
        return {
          toolResults: [{
            name,
            result: { success: true, confirmedSideEffect: false, collected: mergedSlots, missing, ready_to_book: missing.length === 0 }
          }],
          slotsUpdate,
          // A booking guest may be someone other than the sender. Keep these
          // details in booking slots; only governed customer-profile bindings
          // may update the sender's CRM identity.
          effectProposals: [],
        };
      }

      case 'create_booking': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const missing = ['checkIn', 'checkOut', 'guests', 'roomTypeId'].filter((k) => !(slots as any)[k]);
        if (missing.length) {
          return {
            toolResults: [{
              name,
              result: { error: `Cannot book yet — missing: ${missing.join(', ')}` }
            }]
          };
        }
        const rooms = slots.rooms || 1;
        if (rooms >= LARGE_GROUP_ROOMS) {
          // Large group must be escalated
          return {
            escalated: true,
            escalationReason: `Large group booking (${rooms} rooms)`,
            escalationType: 'sales',
            crmPipelineStatus: 'negotiation',
            toolResults: [{
              name,
              result: { booked: false, escalated: true, note: 'Large group booking routed to a sales specialist.' }
            }]
          };
        }

        const roomTypeId = Number(args.room_type_id ?? slots.roomTypeId);
        const confirmation = explicitCustomerConfirmation(ctx.inboundText) === true;
        if (!confirmation) {
          return {
            toolResults: [{ name, result: { booked: false, error: 'Explicit customer confirmation is required in the current turn before booking.' } }],
          };
        }
        const contactName = String(args.guest_name ?? slots.guestName ?? ctx.lead.name ?? '').trim();
        const contactPhone = String(slots.guestPhone ?? ctx.lead.phone ?? (channel === 'whatsapp' ? ctx.lead.recipientPhone : '') ?? '').trim();
        const contactEmail = String(args.guest_email ?? slots.guestEmail ?? ctx.lead.email ?? '').trim();
        if (!contactName || /^(?:guest|unknown|user|whatsapp guest|email guest)$/i.test(contactName) || (!contactPhone && !contactEmail)) {
          return {
            toolResults: [{ name, result: { booked: false, error: 'A verified customer name and at least one contact method are required before booking.' } }],
          };
        }
        const availabilityExpiry = Date.parse(String(slots.availabilityExpiresAt || ''));
        if (!Number.isFinite(availabilityExpiry) || availabilityExpiry < Date.now()
          || !Array.isArray(slots.availableRoomTypeIds) || !slots.availableRoomTypeIds.includes(roomTypeId)) {
          return {
            toolResults: [{ name, result: { booked: false, error: 'A current availability quote for the selected room is required before booking.' } }],
          };
        }

        const agreed = Number(args.agreed_price_per_night ?? slots.agreedPricePerNight);
        const availabilityPrice = Number(slots.quotedPricesByRoomType?.[String(roomTypeId)]);
        const negotiatedForRoom = slots.priceQuoteRoomTypeId === roomTypeId && Number.isFinite(slots.agreedPricePerNight);
        if (!Number.isFinite(agreed) || agreed <= 0 || (!negotiatedForRoom && agreed !== availabilityPrice)) {
          return {
            toolResults: [{ name, result: { booked: false, error: 'The booking price is not backed by the current availability or approved negotiation quote.' } }],
          };
        }
        const perks: string[] = Array.isArray(args.included_perks) ? args.included_perks.filter(Boolean).map(String) : [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slotsUpdate: Record<string, any> = {};
        if (perks.length) slotsUpdate.agreedPerks = perks;

        const specialReqParts = [slots.specialRequests, perks.length ? `Promised perks: ${perks.join('; ')}` : ''].filter(Boolean);
        // The specialist validates the full booking invariant and proposes the
        // write. A governed worker will execute it only after the one-time
        // approval, delivery, and idempotency gates are all satisfied.
        return {
          toolResults: [{
            name,
            result: {
              success: true,
              confirmedSideEffect: false,
              status: 'proposed',
              note: 'The booking request passed validation and is awaiting the governed effect-commit worker.'
            }
          }],
          slotsUpdate,
          effectProposals: [{
            type: 'booking',
            requiresApproval: true,
            payload: {
              userId,
              conversationId,
              leadId: ctx.lead.id ?? null,
              roomTypeId,
              guestName: contactName,
              guestEmail: contactEmail || null,
              guestPhone: contactPhone || null,
              checkIn: slots.checkIn!,
              checkOut: slots.checkOut!,
              guests: Number(slots.guests),
              rooms,
              agreedPricePerNight: agreed,
              specialRequests: specialReqParts.length ? specialReqParts.join(' | ') : null,
            },
          }],
        };
      }

      case 'continue_external_booking': {
        const paymentConfig = await getHotelPaymentConfiguration(userId);
        const approvedUrl = await validateExternalBookingUrlDestination(paymentConfig.externalBooking.url);
        if (paymentConfig.paymentMethodsEnabled || !approvedUrl) {
          return {
            toolResults: [{
              name,
              result: {
                success: false,
                error: paymentConfig.paymentMethodsEnabled
                  ? 'External checkout is not active for this property.'
                  : 'The external booking page is unavailable. No booking or referral was created.',
              },
            }],
          };
        }

        const missing = ['checkIn', 'checkOut', 'guests', 'rooms']
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((key) => !(slots as any)[key]);
        if (missing.length) {
          return {
            toolResults: [{ name, result: { success: false, error: `Cannot continue yet — missing: ${missing.join(', ')}` } }],
          };
        }

        let availableIds = Array.isArray(slots.availableRoomTypeIds)
          ? slots.availableRoomTypeIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
          : [];
        let roomTypeId = Number(args.room_type_id);
        let selectedRoomName = '';
        if (args.room_type_name !== undefined) {
          const roomRows = await db.execute(sql`
            SELECT rt.id, rt.name
            FROM room_types rt
            JOIN hotel_properties hp ON hp.id = rt.hotel_id
            WHERE hp.user_id = ${userId}
            ORDER BY rt.id
          `);
          const ownedRooms: Array<{ id: number; name: string }> = roomRows.rows.map((row: unknown) => ({
            id: Number((row as { id?: unknown }).id),
            name: String((row as { name?: unknown }).name || ''),
          }));
          roomTypeId = Number(selectAvailableRoomTypeId(
            args.room_type_name,
            availableIds.length ? availableIds : ownedRooms.map((room) => room.id),
            ownedRooms,
          ));
          selectedRoomName = ownedRooms.find((room) => room.id === roomTypeId)?.name || '';
        } else if (!Number.isSafeInteger(roomTypeId) || roomTypeId <= 0) {
          roomTypeId = Number(slots.roomTypeId);
        }
        if (!Number.isSafeInteger(roomTypeId) || roomTypeId <= 0) {
          return {
            toolResults: [{ name, result: { success: false, error: 'Select one of the currently available room options before continuing.' } }],
          };
        }
        const rooms = Number(slots.rooms);
        const guests = Number(slots.guests);
        const contactName = String(args.guest_name ?? slots.guestName ?? ctx.lead.name ?? '').trim();
        const contactPhone = String(slots.guestPhone ?? ctx.lead.phone ?? '').trim();
        const contactEmail = String(args.guest_email ?? slots.guestEmail ?? ctx.lead.email ?? '').trim();
        if (!contactName || /^(?:guest|unknown|user|whatsapp guest|email guest)$/i.test(contactName)
          || !hasExternalBookingContactMethod({
            channel,
            phone: contactPhone,
            email: contactEmail,
            providerIdentity: ctx.lead.recipientPhone,
          })) {
          return {
            toolResults: [{ name, result: { success: false, error: 'A real customer name and at least one contact method are required.' } }],
          };
        }

        const latestTurnConfirmed = explicitCustomerConfirmation(ctx.inboundText) === true;
        const summaryWasPresented = hasGovernedExternalBookingConfirmation(ctx)
          || [...ctx.history].reverse()
            .filter((item) => item.role === 'assistant')
            .some((item) => /are you sure.*book/i.test(item.content)
              && item.content.includes(String(slots.checkIn))
              && item.content.includes(String(slots.checkOut))
              && item.content.includes(String(guests))
              && new RegExp(`\\b${rooms}\\s+rooms?\\b`, 'i').test(item.content));
        if (!latestTurnConfirmed || !summaryWasPresented) {
          return {
            toolResults: [{
              name,
              result: { success: false, error: 'Show the complete current booking summary and obtain explicit confirmation before sharing external checkout.' },
            }],
          };
        }

        const slotsUpdate: Record<string, unknown> = {};
        if (availabilityQuoteRequiresRefresh({
          expiresAt: slots.availabilityExpiresAt,
          availableRoomTypeIds: availableIds,
          roomTypeId,
        })) {
          const previousPrice = Number(slots.quotedPricesByRoomType?.[String(roomTypeId)]);
          const freshOptions = await getAvailabilityProvider().searchAvailability({
            userId,
            checkIn: String(slots.checkIn),
            checkOut: String(slots.checkOut),
            guests,
            rooms,
            roomTypeName: selectedRoomName || normalizeOptionalRoomPreference(args.room_type_name),
          });
          const refreshedAt = new Date();
          slotsUpdate.availabilityCheckedAt = refreshedAt.toISOString();
          slotsUpdate.availabilityExpiresAt = new Date(refreshedAt.getTime() + 15 * 60 * 1000).toISOString();
          slotsUpdate.availableRoomTypeIds = freshOptions.map((option) => option.roomTypeId);
          slotsUpdate.quotedPricesByRoomType = Object.fromEntries(
            freshOptions.map((option) => [String(option.roomTypeId), option.pricePerNight]),
          );
          availableIds = freshOptions.map((option) => option.roomTypeId);
          const freshSelection = freshOptions.find((option) => option.roomTypeId === roomTypeId);
          if (!freshSelection) {
            return {
              toolResults: [{
                name,
                result: {
                  success: false,
                  code: 'selected_room_unavailable',
                  error: 'The selected room is no longer available for those dates. Recheck availability before continuing.',
                },
              }],
              slotsUpdate,
            };
          }
          if (!Number.isFinite(previousPrice) || previousPrice !== freshSelection.pricePerNight) {
            return {
              toolResults: [{
                name,
                result: {
                  success: false,
                  code: 'quote_changed',
                  error: 'The selected room price changed. Present the refreshed quote and obtain confirmation again.',
                  room_type_id: roomTypeId,
                  price_per_night: freshSelection.pricePerNight,
                  currency: freshSelection.currency,
                },
              }],
              slotsUpdate,
            };
          }
        }
        const availabilityPrice = Number(slots.quotedPricesByRoomType?.[String(roomTypeId)]);
        const negotiatedForRoom = slots.priceQuoteRoomTypeId === roomTypeId
          && Number.isFinite(slots.agreedPricePerNight);
        // A stale negotiation for another room must not override the current
        // live quote. When the playbook did not bind an explicit negotiated
        // price, use the selected room's current availability price.
        const agreed = resolveExternalCheckoutPrice({
          boundPrice: args.agreed_price_per_night,
          availabilityPrice,
          negotiatedPrice: slots.agreedPricePerNight,
          negotiatedForSelectedRoom: negotiatedForRoom,
        });
        if (!Number.isFinite(agreed) || agreed <= 0 || (!negotiatedForRoom && agreed !== availabilityPrice)) {
          return {
            toolResults: [{ name, result: { success: false, error: 'The selected room price is not backed by the current quote.' } }],
          };
        }

        const propertyRows = await db.execute(sql`
          SELECT hp.id
          FROM hotel_properties hp
          JOIN room_types rt ON rt.hotel_id = hp.id
          WHERE hp.user_id = ${userId} AND rt.id = ${roomTypeId}
          LIMIT 1
        `);
        const propertyId = Number((propertyRows.rows[0] as { id?: unknown } | undefined)?.id);
        if (!Number.isSafeInteger(propertyId) || propertyId <= 0) {
          return {
            toolResults: [{ name, result: { success: false, error: 'The selected room does not belong to this property.' } }],
          };
        }

        const checkoutChildren = Number(playbookField(ctx, 'stay.children'));
        const normalizedCheckoutChildren = Number.isSafeInteger(checkoutChildren) && checkoutChildren >= 0
          ? checkoutChildren : 0;
        const checkoutAdults = Number(playbookField(ctx, 'stay.adults'));
        const normalizedCheckoutAdults = Number.isSafeInteger(checkoutAdults) && checkoutAdults > 0
          ? checkoutAdults : Math.max(1, guests - normalizedCheckoutChildren);
        const checkoutPromoCode = playbookField(ctx, 'stay.promoCode');
        const checkoutCurrency = playbookField(ctx, 'stay.currency');
        const checkoutUrl = buildExternalBookingSearchUrl({
          baseUrl: approvedUrl,
          propertyId: externalPropertyIdFromUrl(approvedUrl),
          checkIn: String(slots.checkIn),
          checkOut: String(slots.checkOut),
          stayType: normalizeStayType(playbookField(ctx, 'stay.stayType')),
          adults: normalizedCheckoutAdults,
          children: normalizedCheckoutChildren,
          rooms,
          promoCode: typeof checkoutPromoCode === 'string' ? checkoutPromoCode : undefined,
          currency: typeof checkoutCurrency === 'string' ? checkoutCurrency : undefined,
        }) || approvedUrl;
        const urlFingerprint = crypto.createHash('sha256').update(checkoutUrl).digest('hex');
        const handoff = {
          mode: 'external_booking' as const,
          stage: 'checkout' as const,
          propertyId,
          roomTypeId,
          checkIn: String(slots.checkIn),
          checkOut: String(slots.checkOut),
          guests,
          adults: normalizedCheckoutAdults,
          children: normalizedCheckoutChildren,
          rooms,
          stayType: normalizeStayType(playbookField(ctx, 'stay.stayType')),
          url: checkoutUrl,
          title: paymentConfig.externalBooking.linkTitle || 'Continue your booking',
          customerConfirmed: true as const,
        };
        return {
          toolResults: [{
            name,
            result: {
              success: true,
              confirmedSideEffect: false,
              status: 'external_booking_ready',
              note: 'The verified delivery layer will append the configured booking page. No local booking or inventory hold was created.',
            },
          }],
          slotsUpdate,
          externalBookingHandoff: handoff,
          effectProposals: [{
            type: 'external_booking_referral',
            payload: {
              stage: 'checkout',
              propertyId,
              roomTypeId,
              checkIn: handoff.checkIn,
              checkOut: handoff.checkOut,
              guests,
              adults: normalizedCheckoutAdults,
              children: normalizedCheckoutChildren,
              rooms,
              stayType: handoff.stayType,
              urlFingerprint,
              customerConfirmed: true,
            },
          }],
        };
      }

      default:
        throw new Error(`Tool ${name} not implemented by BookingSubAgent`);
    }
  }
}
export const bookingSubAgent = new BookingSubAgent();
