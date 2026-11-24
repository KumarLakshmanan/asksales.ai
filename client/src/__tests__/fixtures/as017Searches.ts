import type { HotelBooking, HotelRoomType } from '@/hooks/use-hotel-data';

// Deliberately synthetic populations; assertions derive counts from these records.
export const searchRuns = ['completed', 'completed', 'running', 'pending', 'failed'].map((status, index) => ({
  id: 701 + index,
  userId: 4101,
  leadName: `Synthetic ${status} ${index + 1}`,
  leadEmail: `run-${index + 1}@example.test`,
  status,
  createdAt: '2026-10-01T12:00:00.000Z',
  totalIterations: 0,
  emailsFound: 0,
  phonesFound: 0,
  websitesFound: 0,
}));

export const searchCampaigns = Array.from({ length: 12 }, (_, index) => ({
  id: 801 + index,
  title: `Synthetic campaign ${index + 1}`,
  selectedAgent: null,
  businessId: 4102,
  business: { id: 4102, name: 'Regression Business', industry: null },
  icp: null,
  stats: { leadsCount: 0, contentCount: 0, outreachCount: 0, adCopyCount: 0, imageCount: 0, videoCount: 0 },
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
}));

export const searchRoomTypes: HotelRoomType[] = ['Synthetic garden room', 'Synthetic city suite', 'Synthetic twin room'].map((name, index) => ({
  id: 901 + index,
  name,
  capacity: 2,
  base_price: '100',
  min_price: '80',
  max_discount_pct: '20',
  amenities: ['WiFi'],
}));

export const searchBookings: HotelBooking[] = [{
  id: 1001,
  guest_name: 'Synthetic guest',
  check_in_date: '2026-10-12',
  check_out_date: '2026-10-13',
  nights: 1,
  number_of_guests: 1,
  number_of_rooms: 1,
  total_price: '100',
  currency: 'USD',
  status: 'confirmed',
  payment_status: 'paid',
  room_type: searchRoomTypes[0].name,
  created_at: '2026-10-01T12:00:00.000Z',
}];

export const searchNoMatch = 'zzqa-no-match-20261010';
