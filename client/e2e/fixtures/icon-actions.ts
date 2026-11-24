import type { HotelRoomType } from '../../src/hooks/use-hotel-data';

// Disposable identities only. Shared by component and browser regressions.
export const campaignRecords = [
  { id: 901, title: 'Underlying thread title', icp: { campaignName: 'Synthetic campaign with a very long full title that must survive visual truncation and remain available to assistive technology' } },
  { id: 902, title: 'Duplicate synthetic campaign', icp: null },
  { id: 903, title: 'Duplicate synthetic campaign', icp: null },
  { id: 904, title: null, icp: null },
  { id: 905, title: '   ', icp: { campaignName: '   ' } },
  ...Array.from({ length: 5 }, (_, index) => ({ id: 906 + index, title: `Synthetic campaign ${index}`, icp: null })),
  { id: 911, title: 'Duplicate synthetic campaign', icp: null },
].map(record => ({ ...record, selectedAgent: null, businessId: 4102, business: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', stats: { leadsCount: 0, contentCount: 0, outreachCount: 0, adCopyCount: 0, imageCount: 0, videoCount: 0 } }));

export const campaignTargets = [
  'Synthetic campaign with a very long full title that must survive visual truncation and remain available to assistive technology (ID 901)',
  'Duplicate synthetic campaign (ID 902)',
  'Duplicate synthetic campaign (ID 903)',
  'Campaign 904',
  'Campaign 905',
  ...Array.from({ length: 5 }, (_, index) => `Synthetic campaign ${index} (ID ${906 + index})`),
  'Duplicate synthetic campaign (ID 911)',
];

export const roomRecords: HotelRoomType[] = [
  { id: 801, name: 'Synthetic room with a very long full name that must survive visual truncation and remain available to assistive technology' },
  { id: 802, name: 'Duplicate synthetic room' },
  { id: 803, name: 'Duplicate synthetic room' },
  { id: 804, name: '' },
  { id: 805, name: '   ' },
].map(record => ({ ...record, capacity: 2, base_price: '150', min_price: '100', max_discount_pct: '20', amenities: ['WiFi'] }));

export const roomTargets = [
  'Synthetic room with a very long full name that must survive visual truncation and remain available to assistive technology (ID 801)',
  'Duplicate synthetic room (ID 802)',
  'Duplicate synthetic room (ID 803)',
  'Room type 804',
  'Room type 805',
];
