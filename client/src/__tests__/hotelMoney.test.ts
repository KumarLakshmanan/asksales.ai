import { describe, expect, it } from 'vitest';
import { confirmedHotelRevenue, formatHotelAmount, hotelRevenueDisplay } from '@/lib/hotel-money';

const format = (amount: number, currency?: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
describe('AS026 stored hotel currency provenance', () => {
  it.each(['USD', 'INR', 'EUR'])('formats the two equivalent zero summaries from saved property %s', currency => {
    expect(hotelRevenueDisplay({}, currency, format)).toBe(hotelRevenueDisplay(confirmedHotelRevenue([]), currency, format));
    expect(hotelRevenueDisplay({}, currency, format)).toBe(format(0, currency));
  });
  it('preserves historical currency groups independently of the current property', () => {
    const bookings = [{ status: 'confirmed', currency: 'INR', total_price: '150' }, { status: 'confirmed', currency: 'USD', total_price: '20' }, { status: 'cancelled', currency: 'USD', total_price: '500' }];
    const snapshot = JSON.stringify(bookings);
    expect(confirmedHotelRevenue(bookings)).toEqual({ INR: 150, USD: 20 });
    expect(hotelRevenueDisplay(confirmedHotelRevenue(bookings), 'EUR', format)).toBe(`${format(150, 'INR')} · ${format(20, 'USD')}`);
    expect(JSON.stringify(bookings)).toBe(snapshot);
  });
  it('does not assign account/property currency to amounts with missing provenance', () => {
    expect(formatHotelAmount(25, undefined, format)).toBe('25.00 (currency unknown)');
    expect(hotelRevenueDisplay({}, undefined, format)).toBe('0.00 (currency unknown)');
    expect(hotelRevenueDisplay(confirmedHotelRevenue([{ status: 'confirmed', currency: '', total_price: '25' }]), 'USD', format)).toBe('25.00 (currency unknown)');
  });
});
