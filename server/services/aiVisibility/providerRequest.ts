/** HTTP and pricing helpers shared by the AI visibility provider services. */

export type CredentialConfig = Record<string, unknown>;

export function configString(
  config: CredentialConfig | null | undefined,
  key: string,
  fallback: string,
): string {
  const value = config?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function calculateCost(
  config: CredentialConfig | null | undefined,
  inputTokens?: number,
  outputTokens?: number,
): number {
  const inputPerMillion = Number(config?.inputCostPerMillion || 0);
  const outputPerMillion = Number(config?.outputCostPerMillion || 0);
  return (((inputTokens || 0) * inputPerMillion + (outputTokens || 0) * outputPerMillion) / 1_000_000) * 100;
}

export async function jsonRequest(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (timeout as any).unref === 'function') (timeout as any).unref();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* use status error below */
    }
    if (!response.ok) {
      const apiError = body.error as { message?: string } | undefined;
      throw new Error(apiError?.message || `Provider returned HTTP ${response.status}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}
