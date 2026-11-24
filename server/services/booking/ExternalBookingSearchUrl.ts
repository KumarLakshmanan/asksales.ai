import { safeExternalBookingUrl } from './ExternalBookingUrl.js';
import { parsePositiveIdOrUndefined as positiveInteger } from '../../utils/paramParsers.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const PERSONAL_QUERY_KEYS = [
  'name', 'firstName', 'lastName', 'fullName', 'email', 'phone', 'phoneNumber', 'mobile',
];

export interface ExternalBookingSearchInput {
  baseUrl: string;
  propertyId?: number | string | null;
  checkIn: string;
  checkOut: string;
  stayType?: 'overnight' | 'dayuse' | null;
  adults?: number | null;
  children?: number | null;
  rooms?: number | null;
  promoCode?: string | null;
  currency?: string | null;
  roomOccupancies?: Array<{
    adults: number;
    children?: number;
    childAges?: number[];
  }>;
}

/** A bounded public-search refinement, never consent to create/modify a booking. */
export function parseExternalSearchCountCorrection(text: string): Partial<Pick<ExternalBookingSearchInput, 'adults' | 'children' | 'rooms'>> | undefined {
  const match = text.trim().match(/^(?:actually[,\s]+)?(?:(?:make\s+(?:that|it)|change\s+(?:that|it)\s+to)\s+)?(\d{1,2})\s+(adults?|children|child|rooms?)(?:\s+instead)?[.!]?$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  const field = /^adult/i.test(match[2]) ? 'adults' : /^room/i.test(match[2]) ? 'rooms' : 'children';
  if (value < (field === 'children' ? 0 : 1) || value > (field === 'adults' ? 50 : 20)) return undefined;
  return { [field]: value };
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function setAliasAware(
  params: URLSearchParams,
  canonicalKey: string,
  aliasKey: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  if (params.has(aliasKey) && !params.has(canonicalKey)) {
    params.set(aliasKey, value);
    return;
  }
  params.set(canonicalKey, value);
  params.delete(aliasKey);
}

/**
 * Add only the public search-stage parameters supported by the external hotel
 * booking engine. Guest identity and checkout details are deliberately removed
 * because they belong on the provider's secure, stateful checkout page.
 */
export function buildExternalBookingSearchUrl(input: ExternalBookingSearchInput): string | null {
  const safeBase = safeExternalBookingUrl(input.baseUrl);
  if (!safeBase || !DATE_PATTERN.test(input.checkIn) || !DATE_PATTERN.test(input.checkOut)) return null;

  const parsed = new URL(safeBase);
  for (const key of PERSONAL_QUERY_KEYS) parsed.searchParams.delete(key);

  const propertyId = positiveInteger(input.propertyId);
  if (propertyId !== undefined) parsed.searchParams.set('propertyId', String(propertyId));
  parsed.searchParams.set('checkIn', input.checkIn);
  parsed.searchParams.set('checkOut', input.checkOut);

  const stayType = input.stayType === 'dayuse' ? 'dayuse' : 'overnight';
  setAliasAware(parsed.searchParams, 'stayType', 'type', stayType);

  const adults = positiveInteger(input.adults);
  const children = nonNegativeInteger(input.children);
  const rooms = positiveInteger(input.rooms);
  if (adults !== undefined) parsed.searchParams.set('adults', String(adults));
  if (children !== undefined) parsed.searchParams.set('children', String(children));
  if (rooms !== undefined) parsed.searchParams.set('rooms', String(rooms));

  const promoCode = String(input.promoCode || '').trim().slice(0, 100);
  setAliasAware(parsed.searchParams, 'promoCode', 'promo', promoCode || undefined);
  const currency = String(input.currency || '').trim().toUpperCase();
  if (CURRENCY_PATTERN.test(currency)) parsed.searchParams.set('currency', currency);

  input.roomOccupancies?.slice(0, 20).forEach((occupancy, index) => {
    const roomNumber = index + 1;
    const roomAdults = positiveInteger(occupancy.adults);
    const roomChildren = nonNegativeInteger(occupancy.children);
    if (roomAdults !== undefined) parsed.searchParams.set(`adults_${roomNumber}`, String(roomAdults));
    if (roomChildren !== undefined) parsed.searchParams.set(`children_${roomNumber}`, String(roomChildren));
    const childAges = occupancy.childAges
      ?.map(nonNegativeInteger)
      .filter((age): age is number => age !== undefined && age <= 17)
      .slice(0, 10);
    if (childAges?.length) parsed.searchParams.set(`childAges_${roomNumber}`, childAges.join(','));
  });

  return safeExternalBookingUrl(parsed.toString());
}

export function externalPropertyIdFromUrl(value: string): number | undefined {
  const safe = safeExternalBookingUrl(value);
  if (!safe) return undefined;
  return positiveInteger(new URL(safe).searchParams.get('propertyId'));
}
