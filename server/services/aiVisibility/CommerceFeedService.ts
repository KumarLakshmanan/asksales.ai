import { createHash } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';

type Product = Record<string, unknown>;

export interface CommerceValidationResult {
  sourceType: 'csv' | 'json' | 'xml' | 'shopify';
  itemCount: number;
  validItemCount: number;
  score: number;
  inputFingerprint: string;
  fieldCoverage: Record<string, number>;
  issues: Array<{
    field: string;
    missing: number;
    invalid?: number;
    code?: string;
    severity: string;
    message: string;
  }>;
  summary: Record<string, unknown>;
}

export const COMMERCE_FIELDS: Record<string, string[]> = {
  identifier: ['id', 'sku', 'gtin', 'mpn', 'identifier', 'product_id'],
  title: ['title', 'name', 'product_name'],
  description: ['description', 'body_html', 'summary'],
  image: ['image', 'image_url', 'image_link', 'featured_image'],
  price: ['price', 'sale_price', 'amount'],
  currency: ['currency', 'price_currency', 'currency_code'],
  availability: ['availability', 'stock_status', 'inventory_status', 'in_stock'],
  variants: ['variants', 'variant', 'options'],
  shipping: ['shipping', 'shipping_cost', 'shipping_policy'],
  returns: ['returns', 'return_policy', 'merchant_return_policy'],
  reviews: ['reviews', 'review_count', 'rating', 'aggregate_rating'],
};

function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/^.*:/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function normalizeProduct(value: unknown): Product {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      normalizeKey(key),
      item,
    ]),
  );
}

function hasValue(product: Product, aliases: string[]): boolean {
  return aliases.some((alias) => {
    const value = product[alias];
    return (
      value !== undefined &&
      value !== null &&
      value !== '' &&
      (!Array.isArray(value) || value.length > 0)
    );
  });
}

function fieldValue(product: Product, aliases: string[]): unknown {
  for (const alias of aliases) if (hasValue(product, [alias])) return product[alias];
  return undefined;
}

function nonEmpty(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(
    value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length,
  );
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

function isValidPrice(value: unknown): boolean {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value.trim())
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0;
}

function isValidCurrency(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Z]{3}$/i.test(value.trim());
}

function isValidAvailability(value: unknown): boolean {
  if (typeof value === 'boolean' || value === 0 || value === 1) return true;
  if (typeof value !== 'string') return false;
  return /^(in[ _-]?stock|out[ _-]?of[ _-]?stock|available|unavailable|pre[ _-]?order|back[ _-]?order|discontinued|sold[ _-]?out|true|false|0|1)$/i.test(
    value.trim(),
  );
}

function validatesField(field: string, value: unknown): boolean {
  if (!nonEmpty(value)) return false;
  if (field === 'image') return isHttpUrl(value);
  if (field === 'price') return isValidPrice(value);
  if (field === 'currency') return isValidCurrency(value);
  if (field === 'availability') return isValidAvailability(value);
  if (field === 'reviews' && typeof value === 'number') return Number.isFinite(value) && value >= 0;
  return true;
}

function findProductArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    if (value.length && value.every((item) => item && typeof item === 'object')) return value;
    return [];
  }
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['products', 'product', 'items', 'item', 'entries', 'entry']) {
    if (record[key]) {
      const candidate = Array.isArray(record[key]) ? (record[key] as unknown[]) : [record[key]];
      if (candidate.length) return candidate;
    }
  }
  for (const child of Object.values(record)) {
    const candidate = findProductArray(child);
    if (candidate.length) return candidate;
  }
  return [];
}

export function parseAndValidateCommerceFeed(
  buffer: Buffer,
  fileName: string,
  mimeType?: string,
  mapping: Record<string, string> = {},
): CommerceValidationResult {
  const lower = fileName.toLowerCase();
  const text = buffer.toString('utf8');
  let sourceType: CommerceValidationResult['sourceType'];
  let values: unknown[];
  if (lower.endsWith('.csv') || mimeType === 'text/csv') {
    sourceType = 'csv';
    values = parseCsv(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as unknown[];
  } else if (lower.endsWith('.json') || mimeType === 'application/json') {
    sourceType = 'json';
    const parsed = JSON.parse(text) as unknown;
    values = Array.isArray(parsed) ? parsed : findProductArray(parsed);
  } else if (lower.endsWith('.xml') || mimeType?.includes('xml')) {
    sourceType = 'xml';
    const parsed = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      parseTagValue: false,
      trimValues: true,
    }).parse(text) as unknown;
    values = findProductArray(parsed);
  } else {
    throw new Error('Upload a CSV, JSON, or XML product feed.');
  }
  if (!values.length)
    throw new Error('The feed does not contain any recognizable product records.');
  if (values.length > 100_000) throw new Error('The feed exceeds the 100,000 product limit.');
  for (const field of Object.keys(mapping))
    if (!COMMERCE_FIELDS[field]) throw new Error(`Unknown mapped field: ${field}`);
  const products = values
    .map(normalizeProduct)
    .map((product) => ({
      ...product,
      ...Object.fromEntries(
        Object.entries(mapping)
          .filter(([, source]) => source.trim())
          .map(([field, source]) => [COMMERCE_FIELDS[field][0], product[normalizeKey(source)]]),
      ),
    }))
    .filter((product) => Object.keys(product).length > 0);
  if (!products.length) throw new Error('The feed contains no valid product objects.');

  const required = [
    'identifier',
    'title',
    'description',
    'image',
    'price',
    'currency',
    'availability',
  ];
  const recommended = ['variants', 'shipping', 'returns', 'reviews'];
  const identifiers = products
    .map((product) => fieldValue(product, COMMERCE_FIELDS.identifier))
    .map((value) =>
      String(value ?? '')
        .trim()
        .toLowerCase(),
    );
  const identifierCounts = identifiers.reduce((counts, identifier) => {
    if (identifier) counts.set(identifier, (counts.get(identifier) || 0) + 1);
    return counts;
  }, new Map<string, number>());
  const validByField = Object.fromEntries(
    Object.entries(COMMERCE_FIELDS).map(([field, aliases]) => [
      field,
      products.map((product, index) => {
        const value = fieldValue(product, aliases);
        if (!validatesField(field, value)) return false;
        return field !== 'identifier' || identifierCounts.get(identifiers[index]) === 1;
      }),
    ]),
  ) as Record<string, boolean[]>;
  const fieldCoverage = Object.fromEntries(
    Object.keys(COMMERCE_FIELDS).map((field) => [
      field,
      validByField[field].filter(Boolean).length / products.length,
    ]),
  );
  const validItemCount = products.filter((_product, index) =>
    required.every((field) => validByField[field][index]),
  ).length;
  const requiredScore =
    required.reduce((sum, field) => sum + fieldCoverage[field], 0) / required.length;
  const recommendedScore =
    recommended.reduce((sum, field) => sum + fieldCoverage[field], 0) / recommended.length;
  const score = Math.round((requiredScore * 0.8 + recommendedScore * 0.2) * 10000) / 100;
  const issues = Object.keys(COMMERCE_FIELDS).flatMap((field) => {
    const valuesForField = products.map((product) => fieldValue(product, COMMERCE_FIELDS[field]));
    const missing = valuesForField.filter((value) => !nonEmpty(value)).length;
    const invalid = products.length - validByField[field].filter(Boolean).length - missing;
    const severity = required.includes(field) ? 'high' : 'medium';
    return [
      ...(missing
        ? [
            {
              field,
              missing,
              invalid: 0,
              code: 'missing',
              severity,
              message: `${missing} of ${products.length} products are missing ${field} data.`,
            },
          ]
        : []),
      ...(invalid
        ? [
            {
              field,
              missing: 0,
              invalid,
              code: field === 'identifier' ? 'invalid_or_duplicate' : 'invalid',
              severity,
              message: `${invalid} of ${products.length} products have invalid${field === 'identifier' ? ' or duplicate' : ''} ${field} data.`,
            },
          ]
        : []),
    ];
  });
  return {
    sourceType,
    itemCount: products.length,
    validItemCount,
    score,
    inputFingerprint: createHash('sha256')
      .update(buffer)
      .update(JSON.stringify(mapping))
      .digest('hex'),
    fieldCoverage,
    issues,
    summary: {
      products: products.map((product, index) => ({
        row: index + 1,
        identifier: String(fieldValue(product, COMMERCE_FIELDS.identifier) ?? ''),
        title: String(fieldValue(product, COMMERCE_FIELDS.title) ?? ''),
        valid: required.every((field) => validByField[field][index]),
        issues: Object.keys(COMMERCE_FIELDS).filter((field) => !validByField[field][index]),
      })),
      mapping,
      fullyValidRate: validItemCount / products.length,
      requiredFields: required,
      recommendedFields: recommended,
      validationVersion: 2,
      fieldCoverageMeaning: 'share_of_products_with_valid_values',
    },
  };
}
