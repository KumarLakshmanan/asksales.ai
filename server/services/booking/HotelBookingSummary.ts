export interface VerifiedHotelBookingSummaryInput {
  roomName: string;
  roomCount: number;
  guests: number;
  checkIn: string;
  checkOut: string;
  pricePerNight: number;
  currency: string;
}

export interface VerifiedHotelAvailabilityOptionsInput {
  checkIn: string;
  checkOut: string;
  guests: number;
  options: Array<{
    roomName: string;
    pricePerNight: number;
    currency: string;
  }>;
}

function money(amount: number, currency: string): string {
  const normalizedCurrency = currency.toUpperCase();
  if (normalizedCurrency === 'INR') return `₹${amount.toLocaleString('en-IN')}`;
  return `${normalizedCurrency} ${amount.toLocaleString('en-US')}`;
}

/** Copies the successful public lookup without adding payment or policy claims. */
export function renderVerifiedHotelPaymentMethods(result: Record<string, unknown>): string | null {
  if (result.success !== true || !Array.isArray(result.payment_methods)
    || !result.payment_methods.every(method => typeof method === 'string' && method.trim())) return null;
  return result.payment_methods.length > 0
    ? result.payment_methods.map(method => `- ${method}`).join('\n')
    : typeof result.message === 'string' && result.message.trim() ? result.message : null;
}

/** Renders the confirmation boundary from verified live-tool values only. */
export function renderVerifiedHotelBookingSummary(input: VerifiedHotelBookingSummaryInput): string {
  const roomLabel = input.roomCount === 1 ? 'room' : 'rooms';
  const guestLabel = input.guests === 1 ? 'guest' : 'guests';
  const price = money(input.pricePerNight, input.currency);
  return [
    'I checked live availability. Here is your booking summary:',
    `- Room: ${input.roomCount} ${roomLabel} — ${input.roomName}`,
    `- Dates: ${input.checkIn} to ${input.checkOut}`,
    `- Guests: ${input.guests} ${guestLabel}`,
    `- Verified nightly rate: ${price}`,
    '',
    `Are you sure you want to book ${input.roomCount} ${roomLabel} of this ${input.roomName} from ${input.checkIn} to ${input.checkOut} for ${input.guests} ${guestLabel} at ${price} per night?`,
  ].join('\n');
}

/** Renders the selection boundary from the complete verified live result. */
export function renderVerifiedHotelAvailabilityOptions(input: VerifiedHotelAvailabilityOptionsInput): string {
  const guestLabel = input.guests === 1 ? 'guest' : 'guests';
  if (input.options.length === 0) {
    return `No rooms are available for ${input.checkIn} to ${input.checkOut} for ${input.guests} ${guestLabel}.`;
  }
  return [
    `I checked live availability for ${input.checkIn} to ${input.checkOut} for ${input.guests} ${guestLabel}.`,
    ...input.options.map((option, index) =>
      `${index + 1}. ${option.roomName} — ${money(option.pricePerNight, option.currency)} per night`),
    '',
    'Which verified room or villa option would you like?',
  ].join('\n');
}
