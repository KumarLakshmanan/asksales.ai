/**
 * Vertex AI Service Account Authentication Utility
 * 
 * Loads a GCP service account JSON file from disk for authenticating
 * with Vertex AI (image & video generation).
 * 
 * Credentials are supplied through an explicit runtime secret mount using
 * VERTEX_SERVICE_ACCOUNT_FILE or GOOGLE_APPLICATION_CREDENTIALS.
 */

import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

export interface VertexServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
  universe_domain?: string;
}

const VERTEX_LOCATION_PATTERN = /^[a-z]+(?:-[a-z0-9]+)+\d$/;

/**
 * Parse a governed Vertex AI service-account credential. The caller is
 * responsible for keeping the original JSON encrypted and out of logs.
 */
export function parseVertexServiceAccountJson(value: string): VertexServiceAccount {
  if (!value || value.length > 10_000) {
    throw new Error('Vertex AI service account JSON must be between 1 and 10000 characters');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Vertex AI credential must be valid service account JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Vertex AI credential must be a service account object');
  }
  const candidate = parsed as Partial<VertexServiceAccount>;
  if (
    candidate.type !== 'service_account'
    || typeof candidate.project_id !== 'string'
    || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(candidate.project_id)
    || typeof candidate.client_email !== 'string'
    || !candidate.client_email.endsWith('.gserviceaccount.com')
    || typeof candidate.private_key !== 'string'
    || !candidate.private_key.includes('BEGIN PRIVATE KEY')
    || candidate.private_key.includes('REPLACE_WITH_YOUR')
  ) {
    throw new Error('Vertex AI service account JSON is missing a valid project_id, client_email, or private_key');
  }

  return candidate as VertexServiceAccount;
}

export function normalizeVertexLocation(value: unknown): string {
  const location = typeof value === 'string' && value.trim() ? value.trim() : 'us-central1';
  if (location.length > 40 || (location !== 'global' && !VERTEX_LOCATION_PATTERN.test(location))) {
    throw new Error('Vertex AI location must be a valid Google Cloud region such as us-central1');
  }
  return location;
}

/**
 * Build a short-lived OpenAI-compatible Vertex credential for runtimes that
 * cannot consume the Google Gen AI SDK directly (currently Mastra). The
 * service-account private key never leaves the server or enters agent state.
 */
export async function createVertexOpenAICompatibilityConfig(
  serviceAccountJson: string,
  config: { location?: string; projectId?: string; model?: string } = {},
): Promise<{ accessToken: string; baseURL: string; model: string; projectId: string; location: string }> {
  const serviceAccount = parseVertexServiceAccountJson(serviceAccountJson);
  const location = normalizeVertexLocation(config.location);
  if (config.projectId && config.projectId !== serviceAccount.project_id) {
    throw new Error('Vertex AI projectId must match the service account project_id');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const accessTokenResult = await client.getAccessToken();
  const accessToken = typeof accessTokenResult === 'string'
    ? accessTokenResult
    : accessTokenResult?.token;
  if (!accessToken) throw new Error('Google Cloud did not issue a Vertex AI access token');
  const host = location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${location}-aiplatform.googleapis.com`;
  return {
    accessToken,
    baseURL: `https://${host}/v1/projects/${encodeURIComponent(serviceAccount.project_id)}/locations/${encodeURIComponent(location)}/endpoints/openapi`,
    model: config.model?.trim() || 'gemini-2.5-flash',
    projectId: serviceAccount.project_id,
    location,
  };
}

let cachedAccount: VertexServiceAccount | null | undefined;

/**
 * Load the Vertex AI service account JSON.
 * Returns null if no valid service account file is found.
 * Result is cached after the first call.
 */
export function loadVertexServiceAccount(): VertexServiceAccount | null {
  if (cachedAccount !== undefined) {
    return cachedAccount;
  }

  // Only an explicit runtime secret mount is supported. Never search the
  // checkout or packaged data directories for reusable cloud private keys.
  const credentialFile = process.env.VERTEX_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentialFile) {
    if (!path.isAbsolute(credentialFile)) throw new Error('Vertex credential path must be absolute');
    cachedAccount = parseVertexServiceAccountJson(fs.readFileSync(credentialFile, 'utf-8'));
    return cachedAccount;
  }
  cachedAccount = null;
  return null;
}
