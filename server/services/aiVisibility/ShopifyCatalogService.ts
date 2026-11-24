import { createHash } from 'node:crypto';
import { getCredential } from '../credentialService.js';
import { fetchPublicHttpUrl, readResponseBuffer } from '../../utils/safeRemoteFetch.js';
import { asRecord } from '../../../shared/records.js';

const SHOPIFY_API_VERSION = '2026-07';
const PAGE_SIZE = 100;
const VARIANT_PAGE_SIZE = 100;
const DEFAULT_MAX_PRODUCTS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

export interface ShopifyCatalogCredential {
  storeDomain: string;
  accessToken: string;
}

export interface ShopifyCatalogResult {
  storeDomain: string;
  shopName: string | null;
  currency: string;
  products: JsonRecord[];
  inputFingerprint: string;
  pagesFetched: number;
  variantTruncatedProducts: number;
  apiVersion: string;
}

export type ShopifyCatalogGraphqlRequester = (
  credential: ShopifyCatalogCredential,
  query: string,
  variables: Record<string, unknown>,
) => Promise<JsonRecord>;

export class ShopifyCatalogError extends Error {
  constructor(message: string, public readonly code: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'ShopifyCatalogError';
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeStoreDomain(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value)) {
    throw new ShopifyCatalogError('The saved Shopify connection does not contain a valid permanent myshopify.com domain.', 'INVALID_SHOPIFY_DOMAIN', 422);
  }
  return value;
}

function firstImageUrl(product: JsonRecord, variants: JsonRecord[]): string | null {
  const media = asRecord(product.featuredMedia);
  const preview = asRecord(media.preview);
  const previewImage = asRecord(preview.image);
  const featured = nonEmptyString(previewImage.url);
  if (featured) return featured;
  for (const variant of variants) {
    const image = asRecord(variant.image);
    const url = nonEmptyString(image.url);
    if (url) return url;
  }
  return null;
}

export function normalizeShopifyProduct(value: unknown, currency: string): JsonRecord {
  const product = asRecord(value);
  const variantsConnection = asRecord(product.variants);
  const variants = asArray(variantsConnection.nodes).map(asRecord);
  const prices = variants.map((variant) => Number(variant.price)).filter(Number.isFinite);
  const shippingSignals = variants
    .map((variant) => asRecord(variant.inventoryItem).requiresShipping)
    .filter((signal): signal is boolean => typeof signal === 'boolean');
  const firstSku = variants.map((variant) => nonEmptyString(variant.sku)).find(Boolean) || null;
  const firstBarcode = variants.map((variant) => nonEmptyString(variant.barcode)).find(Boolean) || null;
  const normalizedVariants = variants.map((variant) => ({
    id: nonEmptyString(variant.id),
    sku: nonEmptyString(variant.sku),
    barcode: nonEmptyString(variant.barcode),
    price: nonEmptyString(variant.price),
    availableForSale: variant.availableForSale === true,
    inventoryQuantity: typeof variant.inventoryQuantity === 'number' ? variant.inventoryQuantity : null,
    requiresShipping: typeof asRecord(variant.inventoryItem).requiresShipping === 'boolean'
      ? asRecord(variant.inventoryItem).requiresShipping
      : null,
  }));

  return Object.fromEntries(Object.entries({
    id: firstSku || firstBarcode || nonEmptyString(product.id),
    shopify_product_id: nonEmptyString(product.id),
    sku: firstSku,
    gtin: firstBarcode,
    title: nonEmptyString(product.title),
    description: nonEmptyString(product.description),
    image: firstImageUrl(product, variants),
    price: prices.length ? Math.min(...prices) : null,
    currency,
    availability: variants.some((variant) => variant.availableForSale === true) ? 'in_stock' : 'out_of_stock',
    variants: normalizedVariants,
    shipping: shippingSignals.length ? (shippingSignals.some(Boolean) ? 'required' : 'not_required') : null,
    online_store_url: nonEmptyString(product.onlineStoreUrl),
    shopify_status: nonEmptyString(product.status),
  }).filter(([, item]) => item !== null && item !== undefined));
}

export async function requestShopifyCatalogGraphql(
  credential: ShopifyCatalogCredential,
  query: string,
  variables: Record<string, unknown>,
): Promise<JsonRecord> {
  let response: Response;
  try {
    ({ response } = await fetchPublicHttpUrl(
      `https://${credential.storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': credential.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
      0,
    ));
  } catch (error) {
    throw new ShopifyCatalogError(
      error instanceof Error ? `Shopify catalog request failed: ${error.message}` : 'Shopify catalog request failed.',
      'SHOPIFY_CATALOG_NETWORK_ERROR',
      502,
    );
  }

  let raw: Buffer;
  try {
    raw = await readResponseBuffer(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    throw new ShopifyCatalogError(
      error instanceof Error ? `Shopify catalog response could not be read: ${error.message}` : 'Shopify catalog response could not be read.',
      'SHOPIFY_CATALOG_RESPONSE_ERROR',
      502,
    );
  }
  let envelope: JsonRecord;
  try {
    envelope = asRecord(raw.length ? JSON.parse(raw.toString('utf8')) : null);
  } catch {
    throw new ShopifyCatalogError('Shopify returned an invalid catalog response.', 'SHOPIFY_CATALOG_INVALID_RESPONSE', 502);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ShopifyCatalogError(`Shopify returned HTTP ${response.status}.`, 'SHOPIFY_CATALOG_HTTP_ERROR', response.status === 401 || response.status === 403 ? 422 : 502);
  }
  if (Array.isArray(envelope.errors) && envelope.errors.length) {
    const first = asRecord(envelope.errors[0]);
    throw new ShopifyCatalogError(nonEmptyString(first.message) || 'Shopify rejected the catalog query.', 'SHOPIFY_CATALOG_GRAPHQL_ERROR', 422);
  }
  return asRecord(envelope.data);
}

const CATALOG_QUERY = `
  query AiVisibilityShopifyCatalog($first: Int!, $after: String) {
    shop { name currencyCode }
    products(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        description
        onlineStoreUrl
        status
        featuredMedia { preview { image { url } } }
        variants(first: ${VARIANT_PAGE_SIZE}) {
          pageInfo { hasNextPage }
          nodes {
            id
            sku
            barcode
            price
            availableForSale
            inventoryQuantity
            image { url }
            inventoryItem { requiresShipping }
          }
        }
      }
    }
  }
`;

export async function fetchShopifyCatalog(
  credential: ShopifyCatalogCredential,
  requester: ShopifyCatalogGraphqlRequester = requestShopifyCatalogGraphql,
  maxProducts = DEFAULT_MAX_PRODUCTS,
): Promise<ShopifyCatalogResult> {
  const storeDomain = normalizeStoreDomain(credential.storeDomain);
  if (!credential.accessToken.trim()) throw new ShopifyCatalogError('The Shopify connection has no access token.', 'SHOPIFY_NOT_CONNECTED', 409);
  const normalizedCredential = { storeDomain, accessToken: credential.accessToken.trim() };
  const products: JsonRecord[] = [];
  let cursor: string | null = null;
  let shopName: string | null = null;
  let currency: string | null = null;
  let pagesFetched = 0;
  let variantTruncatedProducts = 0;

  while (true) {
    const data = await requester(normalizedCredential, CATALOG_QUERY, { first: PAGE_SIZE, after: cursor });
    pagesFetched += 1;
    const shop = asRecord(data.shop);
    shopName ||= nonEmptyString(shop.name);
    currency ||= nonEmptyString(shop.currencyCode);
    if (!currency) throw new ShopifyCatalogError('Shopify did not return the store currency.', 'SHOPIFY_CATALOG_MISSING_CURRENCY', 422);

    const connection = asRecord(data.products);
    const nodes = asArray(connection.nodes);
    if (products.length + nodes.length > maxProducts) {
      throw new ShopifyCatalogError(`The Shopify catalog exceeds the ${maxProducts.toLocaleString('en-US')} product sync limit.`, 'SHOPIFY_CATALOG_LIMIT_EXCEEDED', 422);
    }
    for (const node of nodes) {
      const product = asRecord(node);
      if (asRecord(asRecord(product.variants).pageInfo).hasNextPage === true) variantTruncatedProducts += 1;
      products.push(normalizeShopifyProduct(product, currency));
    }

    const pageInfo = asRecord(connection.pageInfo);
    if (pageInfo.hasNextPage !== true) break;
    cursor = nonEmptyString(pageInfo.endCursor);
    if (!cursor) throw new ShopifyCatalogError('Shopify pagination did not return a continuation cursor.', 'SHOPIFY_CATALOG_INVALID_PAGINATION', 502);
  }

  if (!products.length) throw new ShopifyCatalogError('The connected Shopify store does not contain any products.', 'SHOPIFY_CATALOG_EMPTY', 422);
  const serialized = JSON.stringify({ products });
  return {
    storeDomain,
    shopName,
    currency,
    products,
    inputFingerprint: createHash('sha256').update(serialized).digest('hex'),
    pagesFetched,
    variantTruncatedProducts,
    apiVersion: SHOPIFY_API_VERSION,
  };
}

export class ShopifyCatalogService {
  async fetchForUser(userId: number): Promise<ShopifyCatalogResult> {
    const credential = await getCredential(userId, 'shopify');
    const storeDomain = nonEmptyString(credential?.config?.storeDomain);
    const accessToken = nonEmptyString(credential?.apiSecret);
    if (!storeDomain || !accessToken) {
      throw new ShopifyCatalogError('Connect Shopify in Assets before syncing a catalog.', 'SHOPIFY_NOT_CONNECTED', 409);
    }
    return fetchShopifyCatalog({ storeDomain, accessToken });
  }
}

export const shopifyCatalogService = new ShopifyCatalogService();
