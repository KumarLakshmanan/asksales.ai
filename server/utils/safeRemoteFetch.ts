import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, buildConnector } from 'undici';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isPrivateAddress(address: string): boolean {
  try {
    // process() converts every IPv4-mapped IPv6 spelling to IPv4 first.
    const parsed = ipaddr.process(address);
    if (parsed.kind() === 'ipv6' && !(parsed as ipaddr.IPv6).match(ipaddr.parse('2000::') as ipaddr.IPv6, 3)) return true;
    return parsed.range() !== 'unicast';
  } catch {
    return true;
  }
}

async function resolvePublicHttpUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported');
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not supported');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new Error('Only standard web ports are supported');
  }

  const rawHostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;
  if (!hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')) {
    throw new Error('Private network addresses are not supported');
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Private network addresses are not supported');
  }
  return { url, addresses };
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  return (await resolvePublicHttpUrl(rawUrl)).url;
}

/** A fresh connection can use only the addresses approved for this hop. */
function pinnedDispatcher(addresses: Array<{ address: string; family: number }>) {
  const pinned = addresses[0];
  const connect = buildConnector({
    timeout: 10_000,
    lookup: (_hostname, options, callback) => {
      if (options.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    },
  });
  return new Agent({
    connect: (options, callback) => connect(options, (error, socket) => {
      if (error || !socket) return callback(error || new Error('Connection failed'), null);
      if (!socket.remoteAddress || isPrivateAddress(socket.remoteAddress)
        || !addresses.some(({ address }) => ipaddr.process(address).toString() === ipaddr.process(socket.remoteAddress!).toString())) {
        socket.destroy();
        return callback(new Error('Remote peer did not match the approved public address'), null);
      }
      callback(null, socket);
    }),
  });
}

export async function fetchPublicHttpUrl(
  rawUrl: string,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<{ response: Response; finalUrl: string; redirectCount: number; redirectChain: Array<{ url: string; statusCode: number; destination: string }> }> {
  let currentUrl = rawUrl;
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const headers = new Headers(init.headers);
  headers.delete('host');
  let method = init.method || 'GET';
  let body = init.body;

  const redirectChain: Array<{ url: string; statusCode: number; destination: string }> = [];
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const approved = await resolvePublicHttpUrl(currentUrl);
    currentUrl = approved.url.toString();
    const dispatcher = pinnedDispatcher(approved.addresses);
    let response: Response;
    try {
      // Node's bundled dispatcher types may lag the installed Undici types;
      // both implement the public Dispatcher protocol used by native fetch.
      const options = { ...init, headers, method, body, signal, redirect: 'manual' as const, dispatcher };
      response = await fetch(currentUrl, options as unknown as RequestInit);
      // close() drains the active response before releasing the per-hop pool.
      void dispatcher.close().catch(() => dispatcher.destroy());
    } catch (error) {
      await dispatcher.destroy();
      throw error;
    }
    if (!REDIRECT_STATUSES.has(response.status) || init.redirect === 'manual') {
      return { response, finalUrl: currentUrl, redirectCount, redirectChain };
    }

    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Redirect response did not include a location');
    if (redirectCount === maxRedirects) throw new Error('Too many redirects');
    const destination = new URL(location, currentUrl).toString();
    if (new URL(destination).origin !== new URL(currentUrl).origin) {
      for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name);
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method.toUpperCase() === 'POST')) {
      method = method.toUpperCase() === 'HEAD' ? 'HEAD' : 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    redirectChain.push({ url: currentUrl, statusCode: response.status, destination });
    currentUrl = destination;
  }

  throw new Error('Too many redirects');
}

export async function readResponseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Remote file exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`Remote file exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
