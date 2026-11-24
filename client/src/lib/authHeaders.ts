/**
 * Shared auth header helper.
 *
 * Phase 6.9 / CLIENT-009: queryClient.ts was duplicating the
 * "read Bearer token from localStorage" logic with api.ts / admin-api.ts /
 * support-api.ts. Centralising it here means a future change to the auth
 * scheme (e.g. moving the token to a HttpOnly cookie) only touches one
 * place.
 *
 * Returns an empty object when running on the server (so the import
 * doesn't crash during SSR) and when no token is present.
 */
import { businessProfileHeaders } from './business-profile';

export function getAuthHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = window.localStorage.getItem("token");
  return { ...businessProfileHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
