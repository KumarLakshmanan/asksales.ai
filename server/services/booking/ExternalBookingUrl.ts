import net from 'node:net';
import { lookup } from 'node:dns/promises';

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function isPrivateHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) return isPrivateIpv4(hostname);
  if (ipVersion === 6) {
    const normalized = hostname.toLowerCase();
    const mapped = normalized.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
    if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
    if (mapped?.[2] && mapped[3]) {
      const high = Number.parseInt(mapped[2], 16);
      const low = Number.parseInt(mapped[3], 16);
      return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return normalized === '::' || normalized === '::1'
      || normalized.startsWith('fc') || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith('ff')
      || normalized.startsWith('2001:db8:')
      || normalized.startsWith('2001:10:')
      || normalized.startsWith('2001:20:');
  }
  return false;
}

export function isPublicExternalBookingAddress(value: string): boolean {
  return !isPrivateHostname(value);
}

/** Owner-configured, customer-facing booking URLs must be public HTTPS URLs.
 * The original trimmed string is returned so delivery never rewrites a signed
 * or provider-specific query string. */
export function safeExternalBookingUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const original = value.trim();
  if (!original || original.length > 2_000
    || Array.from(original).some(character => character.charCodeAt(0) <= 0x20)
    || /[<>"'`]/.test(original)) return null;
  try {
    const parsed = new URL(original);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || isPrivateHostname(parsed.hostname)) return null;
    return original;
  } catch {
    return null;
  }
}

/** Resolve hostnames before saving or handing off so a public-looking name
 * cannot direct customers to a private or loopback address. DNS failures fail
 * closed; the URL itself is never fetched by the application. */
export async function validateExternalBookingUrlDestination(value: unknown): Promise<string | null> {
  const safe = safeExternalBookingUrl(value);
  if (!safe) return null;
  const hostname = new URL(safe).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) return isPublicExternalBookingAddress(hostname) ? safe : null;
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((entry) => isPublicExternalBookingAddress(entry.address))
      ? safe
      : null;
  } catch {
    return null;
  }
}
