import { expect, it } from 'vitest';
import { isSafeExternalBookingUrl } from '@/lib/hotel-booking-url';
// Tests only: never import the Node/DNS enforcement module into the browser.
import { safeExternalBookingUrl } from '../../../server/services/booking/ExternalBookingUrl';

it.each(['https://localhost./', 'https://100.64.0.1/', 'https://192.0.2.1/', 'https://[::ffff:127.0.0.1]/',
  'https://[::ffff:7f00:1]/', 'https://[::ffff:8.8.8.8]/', 'https://[2001:db8::1]/', 'https://[2001:4860:4860::8888]/',
  'https://192.0.0.1/', 'https://192.88.99.1/', 'https://198.18.1.1/', 'https://198.51.100.1/', 'https://203.0.113.1/',
  'https://10.0.0.1/', 'https://127.1/', 'https://169.254.1.1/', 'https://172.31.1.1/', 'https://192.168.1.1/',
  'https://[fc00::1]/', 'https://[fe80::1]/', 'https://[ff00::1]/', 'https://[::1]/', 'https://host.internal/',
  'https://user:pass@booking.example.test/', 'http://booking.example.test/', 'not a URL',
  'https://8.8.8.8/', 'https://booking.example.test/signed?a=%2F&token=synthetic', ' https://booking.example.test/ ',
])('matches the existing server syntax policy for %s', url => {
  expect(isSafeExternalBookingUrl(url)).toBe(Boolean(safeExternalBookingUrl(url)));
});
