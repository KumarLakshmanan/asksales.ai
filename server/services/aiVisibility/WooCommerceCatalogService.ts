import { createHash } from 'node:crypto';
import { fetchPublicHttpUrl } from '../../utils/safeRemoteFetch.js';

/**
 * Reads a WooCommerce store's catalog from its public Store API
 * (/wp-json/wc/store/v1/products), which needs no login, and turns each product into the
 * same fields a product feed has.
 */

const PAGE_SIZE = 100;
const MAX_PAGES = 50; // 5,000 products

export class WooCommerceCatalogError extends Error {}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const plain = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&#8217;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return plain || null;
}

/** Some themes print markup before the JSON; read from the first array or object. */
export function parseStoreApiBody(body: string): unknown {
  const start = body.search(/[[{]/);
  if (start < 0) throw new WooCommerceCatalogError('The store did not return a product list.');
  try {
    return JSON.parse(body.slice(start));
  } catch {
    throw new WooCommerceCatalogError('The store returned a product list that could not be read.');
  }
}

export function normalizeWooCommerceProduct(value: unknown): JsonRecord {
  const product = asRecord(value);
  const prices = asRecord(product.prices);
  const minorUnit = Number(prices.currency_minor_unit ?? 2);
  const rawPrice = Number(prices.price);
  const images = Array.isArray(product.images) ? product.images.map(asRecord) : [];
  const variations = Array.isArray(product.variations) ? product.variations : [];
  const reviewCount = Number(product.review_count);
  const sku = text(product.sku);
  return Object.fromEntries(
    Object.entries({
      id: sku || (product.id !== undefined ? String(product.id) : null),
      woocommerce_product_id: product.id !== undefined ? String(product.id) : null,
      sku,
      title: text(product.name),
      description: text(product.short_description) || text(product.description),
      image: typeof images[0]?.src === 'string' ? images[0].src : null,
      price: Number.isFinite(rawPrice) ? rawPrice / 10 ** (Number.isFinite(minorUnit) ? minorUnit : 2) : null,
      currency: typeof prices.currency_code === 'string' ? prices.currency_code : null,
      availability:
        typeof product.is_in_stock === 'boolean' ? (product.is_in_stock ? 'in_stock' : 'out_of_stock') : null,
      variants: variations.length ? variations : null,
      reviews:
        Number.isFinite(reviewCount) && reviewCount > 0
          ? { count: reviewCount, average_rating: Number(product.average_rating) || null }
          : null,
      online_store_url: typeof product.permalink === 'string' ? product.permalink : null,
    }).filter(([, item]) => item !== null && item !== undefined),
  );
}

export async function fetchWooCommerceCatalog(
  website: string,
  fetchPage: (url: string) => Promise<{ status: number; body: string; totalPages: number | null }> = async (url) => {
    const { response } = await fetchPublicHttpUrl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; AskSalesBot/1.0; +https://asksales.ai)' },
    });
    const totalPages = Number(response.headers.get('x-wp-totalpages'));
    return {
      status: response.status,
      body: (await response.text()).slice(0, 20_000_000),
      totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : null,
    };
  },
) {
  const origin = new URL(website).origin;
  const products: JsonRecord[] = [];
  let pagesFetched = 0;
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { status, body, totalPages } = await fetchPage(
      `${origin}/wp-json/wc/store/v1/products?per_page=${PAGE_SIZE}&page=${page}`,
    );
    pagesFetched += 1;
    if (status === 404 || status === 401 || status === 403) {
      throw new WooCommerceCatalogError(
        page === 1
          ? `${new URL(origin).hostname} does not share a WooCommerce product list. Upload a product feed instead.`
          : 'The store stopped sharing its product list part way through. Try again.',
      );
    }
    if (status < 200 || status >= 300) {
      throw new WooCommerceCatalogError(`The store answered with HTTP ${status}. Try again later.`);
    }
    const items = parseStoreApiBody(body);
    if (!Array.isArray(items)) throw new WooCommerceCatalogError('The store did not return a product list.');
    products.push(...items.map(normalizeWooCommerceProduct));
    const lastPage = totalPages ? page >= totalPages : items.length < PAGE_SIZE;
    if (lastPage) break;
    if (page === MAX_PAGES) truncated = true;
  }
  if (!products.length) {
    throw new WooCommerceCatalogError('The WooCommerce store has no published products.');
  }
  const serialized = JSON.stringify({ products });
  return {
    products,
    storeDomain: new URL(origin).hostname,
    currency: (products.find((item) => typeof item.currency === 'string')?.currency as string) || null,
    pagesFetched,
    truncated,
    inputFingerprint: createHash('sha256').update(serialized).digest('hex'),
  };
}
