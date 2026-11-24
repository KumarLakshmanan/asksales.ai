import { describe, expect, it } from '@jest/globals';
import {
  fetchWooCommerceCatalog,
  normalizeWooCommerceProduct,
  parseStoreApiBody,
} from '../services/aiVisibility/WooCommerceCatalogService.js';
import { parseAndValidateCommerceFeed } from '../services/aiVisibility/CommerceFeedService.js';

// The shape the public Store API returns (trimmed from aimplifylabs.com).
const storeProduct = (id: number) => ({
  id,
  name: 'Samsung Watch',
  permalink: `https://shop.example/product/watch-${id}/`,
  sku: `0${id}`,
  short_description: '<p>A smart watch &amp; fitness tracker.</p>',
  description: '<p>Long description</p>',
  prices: { price: '249900', currency_code: 'INR', currency_minor_unit: 2 },
  images: [{ src: `https://shop.example/wp-content/uploads/watch-${id}.jpg`, alt: '' }],
  is_in_stock: true,
  review_count: 0,
  average_rating: '0',
  variations: [],
});

describe('WooCommerce catalog import', () => {
  it('reads past markup a theme prints before the JSON', () => {
    const body = `<i class="caseicon-shopping-cart pxl-mr-12"></i>Add to Cart${JSON.stringify([storeProduct(1)])}`;
    expect(parseStoreApiBody(body)).toEqual([storeProduct(1)]);
  });

  it('turns a Store API product into feed fields, with the price in currency units', () => {
    expect(normalizeWooCommerceProduct(storeProduct(3))).toEqual({
      id: '03',
      woocommerce_product_id: '3',
      sku: '03',
      title: 'Samsung Watch',
      description: 'A smart watch & fitness tracker.',
      image: 'https://shop.example/wp-content/uploads/watch-3.jpg',
      price: 2499,
      currency: 'INR',
      availability: 'in_stock',
      online_store_url: 'https://shop.example/product/watch-3/',
    });
  });

  it('pages through the catalog and validates it like an uploaded feed', async () => {
    const requested: string[] = [];
    const catalog = await fetchWooCommerceCatalog('https://shop.example/some/page', async (url) => {
      requested.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      const items = Array.from({ length: page === 1 ? 100 : 20 }, (_, index) => storeProduct(page * 1000 + index));
      return { status: 200, body: JSON.stringify(items), totalPages: 2 };
    });
    expect(requested).toEqual([
      'https://shop.example/wp-json/wc/store/v1/products?per_page=100&page=1',
      'https://shop.example/wp-json/wc/store/v1/products?per_page=100&page=2',
    ]);
    expect(catalog).toEqual(expect.objectContaining({ storeDomain: 'shop.example', currency: 'INR', pagesFetched: 2, truncated: false }));
    const validation = parseAndValidateCommerceFeed(Buffer.from(JSON.stringify({ products: catalog.products })), 'woocommerce-catalog.json', 'application/json');
    expect(validation.itemCount).toBe(120);
    // No reviews and no shipping or return policy in the Store API: those are reported missing.
    expect(validation.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(['reviews']));
  });

  it('explains when a website does not share a WooCommerce product list', async () => {
    await expect(
      fetchWooCommerceCatalog('https://orocircle.com', async () => ({ status: 404, body: '{"code":"rest_no_route"}', totalPages: null })),
    ).rejects.toThrow('orocircle.com does not share a WooCommerce product list. Upload a product feed instead.');
    await expect(
      fetchWooCommerceCatalog('https://shop.example', async () => ({ status: 200, body: '[]', totalPages: 1 })),
    ).rejects.toThrow('The WooCommerce store has no published products.');
  });
});
