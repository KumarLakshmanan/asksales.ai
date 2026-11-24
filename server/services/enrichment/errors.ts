/** Shared HTTP error type without loading provider or wallet services. */
export class EnrichmentBillingError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
