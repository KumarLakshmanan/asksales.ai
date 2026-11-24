export const API_PRICING_NUMERIC_FIELDS = [
  'promptCostPerMillion',
  'completionCostPerMillion',
  'creditsPerUnit',
  'marginPercentage',
  'originalPromptCostPerMillion',
  'originalCompletionCostPerMillion',
  'originalCreditsPerUnit',
] as const;

export function parsePricingNumber(value: unknown, field: string): string {
  const parsed = Number(value);
  const minimum = field === 'marginPercentage' ? -99 : 0;
  const maximum = field === 'marginPercentage' ? 999.99 : 100_000_000;
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return String(parsed);
}

export function parseApiPricingUpdate(input: unknown, requireId: boolean) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Pricing update must be an object');
  const body = input as Record<string, unknown>;
  const allowed = new Set(['id', 'name', 'isActive', ...API_PRICING_NUMERIC_FIELDS]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error('Pricing update contains unsupported fields');
  const parsed: Record<string, unknown> = {};
  if (requireId) {
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Pricing ID must be a positive integer');
    parsed.id = id;
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 255) {
      throw new Error('Name must contain between 1 and 255 characters');
    }
    parsed.name = body.name.trim();
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') throw new Error('isActive must be a boolean');
    parsed.isActive = body.isActive;
  }
  for (const field of API_PRICING_NUMERIC_FIELDS) {
    if (body[field] !== undefined) parsed[field] = parsePricingNumber(body[field], field);
  }
  const valueCount = Object.keys(parsed).length - (requireId ? 1 : 0);
  if (valueCount === 0) throw new Error('At least one pricing field is required');
  return parsed;
}

export type StoragePricingInput = {
  pricingKey?: string;
  name?: string;
  description?: string | null;
  pricePerGbCents?: number;
  currency?: string;
  isActive?: boolean;
};

export function parseStoragePricingInput(body: unknown, partial = false): { value?: StoragePricingInput; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'A pricing object is required' };
  const input = body as Record<string, unknown>;
  const allowed = new Set(partial
    ? ['name', 'description', 'pricePerGbCents', 'currency', 'isActive']
    : ['pricingKey', 'name', 'description', 'pricePerGbCents', 'currency', 'isActive']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { error: 'The request contains unsupported pricing fields' };
  const value: StoragePricingInput = {};
  if (!partial || input.pricingKey !== undefined) {
    if (typeof input.pricingKey !== 'string' || !/^[a-z][a-z0-9_]{1,99}$/.test(input.pricingKey)) {
      return { error: 'Pricing key must contain 2 to 100 lowercase letters, numbers, or underscores' };
    }
    value.pricingKey = input.pricingKey;
  }
  if (!partial || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 200) {
      return { error: 'Name must contain between 1 and 200 characters' };
    }
    value.name = input.name.trim();
  }
  if (input.description !== undefined) {
    if (input.description !== null && (typeof input.description !== 'string' || input.description.length > 2_000)) {
      return { error: 'Description must contain at most 2,000 characters' };
    }
    value.description = typeof input.description === 'string' ? input.description.trim() || null : null;
  }
  if (!partial || input.pricePerGbCents !== undefined) {
    const price = Number(input.pricePerGbCents);
    if (!Number.isSafeInteger(price) || price < 0 || price > 100_000_000) {
      return { error: 'Price per GB must be a non-negative integer in minor currency units' };
    }
    value.pricePerGbCents = price;
  }
  if (!partial || input.currency !== undefined) {
    if (typeof input.currency !== 'string' || !/^[A-Za-z]{3}$/.test(input.currency)) {
      return { error: 'Currency must be a three-letter ISO code' };
    }
    value.currency = input.currency.toUpperCase();
  }
  if (input.isActive !== undefined) {
    if (typeof input.isActive !== 'boolean') return { error: 'isActive must be a boolean' };
    value.isActive = input.isActive;
  }
  return { value };
}

export function parseCreditPricingUpdates(updates: unknown): Array<{ id: number; creditsPerUnit: string; isActive?: boolean }> {
  if (!Array.isArray(updates) || updates.length < 1 || updates.length > 200) {
    throw new Error('Updates must contain between 1 and 200 pricing records');
  }
  const seenIds = new Set<number>();
  return updates.map((update) => {
    if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('Each pricing update must be an object');
    const input = update as Record<string, unknown>;
    if (Object.keys(input).some((key) => !['id', 'creditsPerUnit', 'isActive'].includes(key))) {
      throw new Error('A pricing update contains unsupported fields');
    }
    const id = Number(input.id);
    const creditsPerUnit = Number(input.creditsPerUnit);
    if (!Number.isSafeInteger(id) || id <= 0 || seenIds.has(id)) throw new Error('Pricing IDs must be unique positive integers');
    if (!Number.isFinite(creditsPerUnit) || creditsPerUnit < 0 || creditsPerUnit > 100_000_000) {
      throw new Error('Credits per unit must be between 0 and 100,000,000');
    }
    if (input.isActive !== undefined && typeof input.isActive !== 'boolean') throw new Error('isActive must be a boolean');
    seenIds.add(id);
    return {
      id,
      creditsPerUnit: creditsPerUnit.toFixed(2),
      ...(input.isActive !== undefined ? { isActive: input.isActive as boolean } : {}),
    };
  });
}
