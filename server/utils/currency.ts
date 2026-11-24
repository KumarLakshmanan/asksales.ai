import { roundMoney as roundCurrency } from '../../shared/money.js';
export { roundCurrency };
const DEFAULT_USD_TO_INR_RATE = 100;

/**
 * Return the configured accounting conversion used when translating provider
 * costs (stored as USD cents) into INR. The fallback preserves the historic
 * application rate while allowing production to configure it explicitly.
 */
export function getUsdToInrRate(): number {
  const configuredRate = Number(process.env.USD_TO_INR_RATE);
  return Number.isFinite(configuredRate) && configuredRate > 0
    ? configuredRate
    : DEFAULT_USD_TO_INR_RATE;
}

export function usdCentsToInr(costCents: number, usdToInrRate = getUsdToInrRate()): number {
  if (!Number.isFinite(costCents) || costCents <= 0) return 0;
  return (costCents / 100) * usdToInrRate;
}

/**
 * The one rounding rule for every charge priced from a measured provider cost
 * (LLM, embeddings, Apify, image and video): round up to a whole credit, and
 * charge at least one credit for any non-zero cost. A tiny tolerance keeps
 * float noise such as 40.0000000001 from rounding up to 41.
 */
export function meteredCreditsFromInr(costInr: number, usageCreditsPerInr: number): number {
  if (!Number.isFinite(costInr) || costInr <= 0 || !Number.isFinite(usageCreditsPerInr) || usageCreditsPerInr <= 0) return 0;
  return Math.max(1, Math.ceil(costInr * usageCreditsPerInr - 1e-9));
}

export function meteredCreditsFromUsd(costUsd: number, usageCreditsPerInr: number, usdToInrRate = getUsdToInrRate()): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
  return meteredCreditsFromInr(costUsd * usdToInrRate, usageCreditsPerInr);
}

export function creditsToInr(credits: number, creditsPerInr: number): number {
  if (!Number.isFinite(credits) || credits <= 0 || !Number.isFinite(creditsPerInr) || creditsPerInr <= 0) {
    return 0;
  }
  return credits / creditsPerInr;
}

