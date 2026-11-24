type CurrencyFormatter = (amount: number, currency?: string) => string;

/** Stored property currency labels inventory; stored booking currency labels history. */
export function hotelCurrency(currency: string | null | undefined): string | undefined {
  const code = currency?.trim().toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) ? code : undefined;
}

export function formatHotelAmount(amount: number, currency: string | null | undefined, format: CurrencyFormatter): string {
  const code = hotelCurrency(currency);
  return code ? format(amount, code) : `${amount.toFixed(2)} (currency unknown)`;
}

export function hotelRevenueDisplay(totals: Record<string, number>, propertyCurrency: string | null | undefined, format: CurrencyFormatter): string {
  const entries = Object.entries(totals);
  if (!entries.length) return formatHotelAmount(0, propertyCurrency, format);
  return entries.map(([currency, amount]) => formatHotelAmount(Number(amount), currency, format)).join(' · ');
}

export function confirmedHotelRevenue(bookings: Array<{ status: string; currency?: string; total_price: string }>): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const booking of bookings) {
    if (booking.status !== 'confirmed') continue;
    const currency = hotelCurrency(booking.currency) || 'UNKNOWN';
    totals[currency] = (totals[currency] || 0) + Number(booking.total_price);
  }
  return totals;
}
