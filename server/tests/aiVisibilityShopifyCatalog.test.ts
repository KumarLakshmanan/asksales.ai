import { describe, expect, it, jest } from '@jest/globals';
import {
  fetchShopifyCatalog,
  normalizeShopifyProduct,
  ShopifyCatalogError,
  type ShopifyCatalogGraphqlRequester,
} from '../services/aiVisibility/ShopifyCatalogService.js';

function product(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Product ${id}`,
    description: 'A verified product description.',
    onlineStoreUrl: `https://store.example/products/${id}`,
    status: 'ACTIVE',
    featuredMedia: { preview: { image: { url: `https://cdn.example/${id}.jpg` } } },
    variants: {
      pageInfo: { hasNextPage: false },
      nodes: [{
        id: `${id}-variant`, sku: `SKU-${id}`, barcode: `GTIN-${id}`, price: '19.95',
        availableForSale: true, inventoryQuantity: 4, inventoryItem: { requiresShipping: true },
      }],
    },
    ...overrides,
  };
}

describe('AI Visibility Shopify catalog ingestion', () => {
  it('normalizes only real Shopify product and variant signals', () => {
    const normalized = normalizeShopifyProduct(product('1'), 'USD');
    expect(normalized).toEqual(expect.objectContaining({
      id: 'SKU-1',
      shopify_product_id: '1',
      title: 'Product 1',
      description: 'A verified product description.',
      image: 'https://cdn.example/1.jpg',
      price: 19.95,
      currency: 'USD',
      availability: 'in_stock',
      shipping: 'required',
    }));
    expect(normalized).not.toHaveProperty('reviews');
    expect(normalized).not.toHaveProperty('returns');
  });

  it('paginates the Admin API and fingerprints stable normalized products', async () => {
    const requester = jest.fn<ShopifyCatalogGraphqlRequester>()
      .mockResolvedValueOnce({
        shop: { name: 'Orbit Store', currencyCode: 'USD' },
        products: { nodes: [product('1')], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } },
      })
      .mockResolvedValueOnce({
        shop: { name: 'Orbit Store', currencyCode: 'USD' },
        products: { nodes: [product('2')], pageInfo: { hasNextPage: false, endCursor: null } },
      });

    const first = await fetchShopifyCatalog({ storeDomain: 'https://orbit-store.myshopify.com/', accessToken: 'secret' }, requester);
    expect(requester).toHaveBeenNthCalledWith(1, expect.objectContaining({ storeDomain: 'orbit-store.myshopify.com' }), expect.any(String), { first: 100, after: null });
    expect(requester).toHaveBeenNthCalledWith(2, expect.any(Object), expect.any(String), { first: 100, after: 'cursor-1' });
    expect(first.products).toHaveLength(2);
    expect(first.pagesFetched).toBe(2);
    expect(first.inputFingerprint).toHaveLength(64);

    const sameRequester = jest.fn<ShopifyCatalogGraphqlRequester>().mockResolvedValue({
      shop: { name: 'Orbit Store', currencyCode: 'USD' },
      products: { nodes: [product('1'), product('2')], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const same = await fetchShopifyCatalog({ storeDomain: 'orbit-store.myshopify.com', accessToken: 'secret' }, sameRequester);
    expect(same.inputFingerprint).toBe(first.inputFingerprint);
  });

  it('records truncated variant coverage without inventing missing variants', async () => {
    const requester = jest.fn<ShopifyCatalogGraphqlRequester>().mockResolvedValue({
      shop: { name: 'Orbit Store', currencyCode: 'EUR' },
      products: {
        nodes: [product('1', { variants: { pageInfo: { hasNextPage: true }, nodes: [] } })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const result = await fetchShopifyCatalog({ storeDomain: 'orbit-store.myshopify.com', accessToken: 'secret' }, requester);
    expect(result.variantTruncatedProducts).toBe(1);
    expect(result.products[0]).toEqual(expect.objectContaining({ availability: 'out_of_stock', variants: [] }));
  });

  it('rejects empty, oversized, and invalidly paginated catalogs visibly', async () => {
    const empty = jest.fn<ShopifyCatalogGraphqlRequester>().mockResolvedValue({
      shop: { name: 'Orbit', currencyCode: 'USD' },
      products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    await expect(fetchShopifyCatalog({ storeDomain: 'orbit.myshopify.com', accessToken: 'secret' }, empty)).rejects.toMatchObject({ code: 'SHOPIFY_CATALOG_EMPTY' });

    const oversized = jest.fn<ShopifyCatalogGraphqlRequester>().mockResolvedValue({
      shop: { name: 'Orbit', currencyCode: 'USD' },
      products: { nodes: [product('1'), product('2')], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    await expect(fetchShopifyCatalog({ storeDomain: 'orbit.myshopify.com', accessToken: 'secret' }, oversized, 1)).rejects.toMatchObject({ code: 'SHOPIFY_CATALOG_LIMIT_EXCEEDED' });

    const noCursor = jest.fn<ShopifyCatalogGraphqlRequester>().mockResolvedValue({
      shop: { name: 'Orbit', currencyCode: 'USD' },
      products: { nodes: [product('1')], pageInfo: { hasNextPage: true, endCursor: null } },
    });
    await expect(fetchShopifyCatalog({ storeDomain: 'orbit.myshopify.com', accessToken: 'secret' }, noCursor)).rejects.toBeInstanceOf(ShopifyCatalogError);
  });
});
