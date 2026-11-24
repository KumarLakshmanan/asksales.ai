import { api } from './api';

/** A short API restart must not leave a permanent gateway error on this page.
 * Retry read requests only; provider-specific errors need the stated action. */
export async function socialInsightsGet<T>(url: string): Promise<T> {
  const delays = [1000, 2000, 4000, 8000, 15000];
  for (let attempt = 0; ; attempt++) {
    try { return await api.get<T>(url); }
    catch (error) {
      const detail = error as { status?: number; data?: {code?: string} };
      if (![502,503,504].includes(detail?.status || 0) || detail?.data?.code?.startsWith('SOCIAL_') || detail?.data?.code === 'DATABASE_QUERY_TIMEOUT' || attempt >= delays.length) throw error;
      await new Promise(resolve => setTimeout(resolve,delays[attempt]));
    }
  }
}
