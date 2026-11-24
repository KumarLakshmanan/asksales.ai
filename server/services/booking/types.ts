/**
 * Shared types for the hotel booking domain used by the WhatsApp Sales Agent.
 */

export interface AvailabilitySearchQuery {
  userId: number;
  checkIn: string;  // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  guests: number;
  rooms?: number;
  roomTypeName?: string; // optional fuzzy filter, e.g. "deluxe"
}

export interface RoomOption {
  roomTypeId: number;
  hotelId: number;
  name: string;
  description: string | null;
  capacity: number;
  nights: number;
  pricePerNight: number;   // highest nightly rate in the stay (safe quote anchor)
  basePrice: number;
  minPrice: number;
  maxDiscountPct: number;
  totalPrice: number;      // sum of nightly rates * rooms
  availableCount: number;  // min available across the date range
  currency: string;
  amenities: string[];
}

export interface BookingDraft {
  userId: number;
  conversationId?: number | null;
  leadId?: number | null;
  roomTypeId: number;
  guestName?: string | null;
  guestEmail?: string | null;
  guestPhone?: string | null;
  checkIn: string;
  checkOut: string;
  guests: number;
  rooms: number;
  agreedPricePerNight?: number;
  /** Used by callers that quote an exact whole-stay total across variable nightly rates. */
  agreedTotalPrice?: number;
  /** Ignored for pricing authority; the owned hotel property's currency wins. */
  currency?: string;
  specialRequests?: string | null;
}

export interface BookingRecord {
  id: number;
  status: string;
  paymentStatus: string;
  totalPrice: number;
  currency: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  rooms: number;
  roomTypeId: number;
  hotelPropertyId: number;
  paymentLink?: string | null;
  paymentProvider?: string | null;
  holdExpiresAt?: string | null;
  cancellationReason?: string | null;
  inventoryReserved: boolean;
}
