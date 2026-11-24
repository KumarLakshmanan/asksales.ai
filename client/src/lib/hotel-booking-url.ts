/** Syntax feedback only. The server remains authoritative and also resolves DNS.
 * Parity with its existing address policy is covered by hotelBookingUrl.test. */
function privateIpv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

export function isSafeExternalBookingUrl(value: string): boolean {
  const original = value.trim();
  if (!original || original.length > 2000 || /[\u0000-\u0020<>"'`]/.test(original)) return false;
  try {
    const url = new URL(original);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host || host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !privateIpv4(host);
    if (host.includes(':')) {
      const mapped = host.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
      if (mapped?.[1]) return !privateIpv4(mapped[1]);
      if (mapped?.[2] && mapped[3]) {
        const high = Number.parseInt(mapped[2], 16), low = Number.parseInt(mapped[3], 16);
        return !privateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
      return !(host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
        || host.startsWith('ff') || host.startsWith('2001:db8:') || host.startsWith('2001:10:') || host.startsWith('2001:20:'));
    }
    return true;
  } catch { return false; }
}
