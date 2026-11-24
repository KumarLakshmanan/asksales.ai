import { getActiveAdminCredential } from '../models/adminApiCredentials/functions.js';

const DEFAULT_GRAPH_API_VERSION = 'v25.0';
let resolvedVersion: string | null = null;

/**
 * Get the configured Meta/Facebook Graph API version from admin credentials.
 * Caches the result after first successful lookup.
 */
export async function getGraphApiVersion(): Promise<string> {
  if (resolvedVersion) return resolvedVersion;
  try {
    const adminCred = await getActiveAdminCredential('meta_app');
    const config = adminCred?.config as { apiVersion?: string } | null;
    if (config?.apiVersion) {
      resolvedVersion = config.apiVersion;
      return resolvedVersion;
    }
  } catch { /* fallback to default */ }
  return DEFAULT_GRAPH_API_VERSION;
}

/**
 * Build the Graph API base URL for the given version.
 */
export function getGraphApiBase(version: string): string {
  return `https://graph.facebook.com/${version}`;
}

/**
 * Clear the cached version (useful if admin updates the config at runtime).
 */
export function clearGraphApiVersionCache(): void {
  resolvedVersion = null;
}

/**
 * Get the base URL for Meta OAuth redirect URIs.
 * In local development, uses NGROK_URL (since Meta OAuth doesn't work with localhost).
 * In production, uses APP_URL (e.g. https://api.asksales.ai).
 */
export function getOAuthBaseUrl(): string {
  return process.env.NGROK_URL || process.env.APP_URL || process.env.API_URL || 'http://localhost:8080';
}
