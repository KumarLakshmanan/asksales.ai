import { contentRequestKey, needsContentReceipt } from './content-request-key';
import { creatorSessionScope } from './creator-session';
import { businessProfileHeaders } from './business-profile';
import { billingOrganizationHeaders } from './billing-organization';

import { uploadFormWithProgress } from './uploadFormProgress';
import { withRequestDeadline } from './request-deadline';

export interface ApiOptions extends RequestInit {
  /** Reads default to 30 seconds; use 0 only for an intentional long-running read. */
  timeoutMs?: number;
  skipAuth?: boolean;
  skipBillingOrganization?: boolean;
  suppressUnauthorizedEvent?: boolean;
  /** GET/HEAD only: retry a network failure or 502/503/504 twice. Defaults to true. */
  retryTransient?: boolean;
  params?: Record<string, string | number | boolean | null | undefined>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public data?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ApiClientConfig {
  tokenStorageKey: string;
  profileStorageKeys: string[];
  unauthorizedEvent: string;
  unauthorizedMessage?: string;
}

// Base waits before the 1st and 2nd read retry; each gets up to +50% jitter so
// many tabs or parallel requests do not retry in lockstep against a busy server.
export const TRANSIENT_READ_RETRY_DELAYS_MS: readonly number[] = [500, 1500];

/** Read at call time. Tests of a feature's own error/recovery screen set
 * `delaysMs` to [] so a single simulated failure reaches that screen. */
export const transientReadRetry: { delaysMs: readonly number[] } = { delaysMs: TRANSIENT_READ_RETRY_DELAYS_MS };

/** The API stopped a query that ran past its time limit (504 with this code,
 * see server/tenancy/databaseAvailability.ts). The person may retry; the
 * client does not replay it on its own, because repeating a slow query during
 * an overload only adds load. */
export const QUERY_TIMEOUT_CODE = "DATABASE_QUERY_TIMEOUT";

export function isQueryTimeout(error: unknown): boolean {
  const data = error instanceof ApiError ? error.data : undefined;
  return Boolean(data && typeof data === "object" && (data as { code?: unknown }).code === QUERY_TIMEOUT_CODE);
}

/** Network failure (status 0) or a gateway/availability error. The API sends
 * 503 + Retry-After when a request could not reach its database (see
 * server/tenancy/databaseAvailability.ts). 500 is not retried: it is a handler
 * error. A query timeout is not retried either (isQueryTimeout). 408 is our
 * own 30 s deadline, and repeating it would only multiply the wait. */
export function isTransientReadFailure(error: unknown): boolean {
  return error instanceof ApiError && [0, 502, 503, 504].includes(error.status ?? -1) && !isQueryTimeout(error);
}

function waitBeforeRetry(baseMs: number, signal?: AbortSignal | null): Promise<void> {
  const ms = baseMs + Math.random() * baseMs * 0.5;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Request cancelled', 'AbortError')); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Request cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `fetch` for direct downloads, exports and media previews that need the raw
 * Response (blob, CSV) and so cannot use the JSON API client. Applies the same
 * read retry: GET/HEAD only, network failure or 502/503/504, twice. */
export async function fetchWithReadRetry(input: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method || "GET").toUpperCase();
  const delays = ["GET", "HEAD"].includes(method) ? transientReadRetry.delaysMs : [];
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = init === undefined ? await fetch(input) : await fetch(input, init);
    } catch (error) {
      const aborted = init?.signal?.aborted || (error instanceof Error && error.name === "AbortError");
      if (attempt >= delays.length || aborted) throw error;
      await waitBeforeRetry(delays[attempt], init?.signal);
      continue;
    }
    if (attempt >= delays.length || ![502, 503, 504].includes(response.status) || init?.signal?.aborted) return response;
    // A query the API stopped for running too long is not repeated automatically.
    if (response.status === 504) {
      const body: unknown = await response.clone().json().catch(() => null);
      if (body && typeof body === "object" && (body as { code?: unknown }).code === QUERY_TIMEOUT_CODE) return response;
    }
    await response.body?.cancel().catch(() => undefined);
    await waitBeforeRetry(delays[attempt], init?.signal);
  }
}

const getApiBaseUrl = () =>
  (process.env.NEXT_PUBLIC_API_URL || "").trim().replace(/\/+$/, "");

export function buildApiUrl(endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  const normalizedPath = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${getApiBaseUrl()}${normalizedPath}`;
}

function appendQueryParams(url: string, params?: ApiOptions["params"]): string {
  if (!params) return url;
  const [pathname, existingQuery = ""] = url.split("?", 2);
  const query = new URLSearchParams(existingQuery);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

export function getCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function errorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object") return fallback;
  const record = data as Record<string, unknown>;
  return typeof record.error === "string"
    ? record.error
    : typeof record.message === "string"
      ? record.message
      : fallback;
}

function unwrap<T>(data: unknown): T {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (record.success === true && "data" in record) {
      const extraKeys = Object.keys(record).filter((key) => key !== "success" && key !== "data");
      if (extraKeys.length === 0) return record.data as T;
    }
  }
  return data as T;
}

// CRM raw-query responses also expose their UTC reminder instant as `dueDate`.
// Keep this alias exact: other Date fields can represent calendar dates.
const API_TIMESTAMP_FIELD = /(?:At|_at|For|_for|Until|_until|Timestamp|_timestamp)$|^dueDate$/;
const NAIVE_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * PostgreSQL `timestamp without time zone` values represent UTC instants in
 * this application. Some raw-query responses arrive without a `Z`, which
 * browsers otherwise interpret as local wall-clock time and display 5½ hours
 * early in India. Make API timestamps unambiguous while preserving strings.
 */
export function normalizeApiTimestamps(value: unknown, field = ''): unknown {
  if (typeof value === 'string' && API_TIMESTAMP_FIELD.test(field) && NAIVE_UTC_TIMESTAMP.test(value)) {
    return `${value.replace(' ', 'T')}Z`;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeApiTimestamps(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeApiTimestamps(item, key)]));
  }
  return value;
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => undefined);
  }
  return response.text();
}

export function createApiClient(config: ApiClientConfig) {
  const dispatchUnauthorized = () => {
    if (typeof window === "undefined") return;
    localStorage.removeItem(config.tokenStorageKey);
    config.profileStorageKeys.forEach((key) => localStorage.removeItem(key));
    window.dispatchEvent(new CustomEvent(config.unauthorizedEvent));
  };

  const performRequest = async <T>(endpoint: string, options: ApiOptions = {}): Promise<T> => {
    const {
      skipAuth = false,
      skipBillingOrganization = false,
      suppressUnauthorizedEvent = false,
      params,
      ...fetchOptions
    } = options;
    const headers = new Headers(fetchOptions.headers);
    const isForm = typeof FormData !== "undefined" && fetchOptions.body instanceof FormData;
    if (!isForm && fetchOptions.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    if (!skipAuth && typeof window !== "undefined") {
      const token = localStorage.getItem(config.tokenStorageKey);
      if (token) headers.set("authorization", `Bearer ${token}`);
      if (config.tokenStorageKey === 'token') {
        Object.entries({ ...businessProfileHeaders(), ...(skipBillingOrganization ? {} : billingOrganizationHeaders(endpoint, fetchOptions.method)) }).forEach(([key, value]) => { if (!headers.has(key)) headers.set(key, value); });
      }
    }

    const method = (fetchOptions.method || "GET").toUpperCase();
    const receipt = method === 'POST' && typeof fetchOptions.body === 'string' && needsContentReceipt(endpoint) && typeof window !== 'undefined'
      ? await contentRequestKey(endpoint, fetchOptions.body, creatorSessionScope())
      : null;
    if (receipt && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', receipt.key);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const csrf = getCsrfToken();
      if (csrf) headers.set("x-xsrf-token", csrf);
    }

    try {
      const requestUrl = appendQueryParams(buildApiUrl(endpoint), params);
      const requestInit: RequestInit = {
        ...fetchOptions,
        headers,
        credentials: "include",
      };
      let response = await fetch(requestUrl, requestInit);
      let data = await parseResponse(response);

      // Session-authenticated tabs can outlive the rotating double-submit
      // cookie (for example after a dev-server restart). Bootstrap one fresh
      // token and replay the same unsafe request exactly once. This prevents
      // tab persistence and widget autosave from failing until the next login.
      const isCsrfRejection = response.status === 403
        && errorMessage(data, "").toLowerCase().includes("csrf token");
      if (isCsrfRejection && !["GET", "HEAD", "OPTIONS"].includes(method)) {
        await fetch(buildApiUrl("/api/auth/csrf-token"), {
          method: "GET",
          credentials: "include",
        });
        const refreshedCsrf = getCsrfToken();
        if (refreshedCsrf) {
          headers.set("x-xsrf-token", refreshedCsrf);
          response = await fetch(requestUrl, { ...requestInit, headers });
          data = await parseResponse(response);
        }
      }

      // A received terminal response completes this attempt. Only uncertain or
      // still-running work retains its key for safe recovery on the next click.
      const canonicalReceipt = unwrap<unknown>(data);
      const receiptRecord = canonicalReceipt && typeof canonicalReceipt === 'object' ? canonicalReceipt as Record<string, unknown> : null;
      const rawReceipt = data && typeof data === 'object' ? data as Record<string, unknown> : null;
      const unconfirmed = [receiptRecord?.code, rawReceipt?.code].some(code => code === 'CONTENT_REQUEST_PENDING' || code === 'EMAIL_SAVE_UNCONFIRMED');
      const validTemplateReceipt = endpoint !== '/api/content/templates' || (response.ok && receiptRecord && Number.isSafeInteger(receiptRecord.id) && Number(receiptRecord.id) > 0 && typeof receiptRecord.content === 'string');
      const validContactReceipt = endpoint !== '/api/crm/contacts' || (response.ok && receiptRecord && Number.isSafeInteger(receiptRecord.id) && Number(receiptRecord.id) > 0);
      if (validTemplateReceipt && validContactReceipt && response.status < 500 && !unconfirmed && response.headers.get('Content-Request-Confirmed') === 'true' && receiptRecord) receipt?.clear();
      if (response.status === 401) {
        if (!suppressUnauthorizedEvent) dispatchUnauthorized();
        throw new ApiError(
          errorMessage(data, config.unauthorizedMessage || "Unauthorized"),
          401,
          data,
        );
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        throw new ApiError(
          errorMessage(data, retryAfter ? `Rate limited. Retry after ${retryAfter}s.` : "Rate limited. Please wait."),
          429,
          data,
        );
      }
      if (response.status === 402) {
        throw new ApiError(
          errorMessage(data, "Insufficient credits. Please recharge your wallet."),
          402,
          data,
        );
      }
      if (response.status === 503) {
        throw new ApiError(
          errorMessage(data, "Service temporarily unavailable. Please try again."),
          503,
          data,
        );
      }
      if (!response.ok) {
        throw new ApiError(errorMessage(data, `HTTP ${response.status}`), response.status, data);
      }

      return unwrap<T>(normalizeApiTimestamps(data));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError(error instanceof Error ? error.message : "Network error", 0);
    }
  };

  const request = async <T>(endpoint: string, options: ApiOptions = {}): Promise<T> => {
    const method = (options.method || 'GET').toUpperCase();
    const { retryTransient = true, ...attemptOptions } = options;
    // Reads change nothing on the server, so a dropped connection or a
    // 5xx (for example a brief database-pool stall) is retried a few
    // times before the page shows an error. Writes are never replayed here.
    const delays = retryTransient && ['GET', 'HEAD'].includes(method) ? transientReadRetry.delaysMs : [];
    for (let attempt = 0; ; attempt++) {
      try {
        return await attemptRequest<T>(endpoint, method, attemptOptions);
      } catch (error) {
        if (attempt >= delays.length || !isTransientReadFailure(error) || attemptOptions.signal?.aborted) throw error;
        await waitBeforeRetry(delays[attempt], attemptOptions.signal);
      }
    }
  };

  const attemptRequest = async <T>(endpoint: string, method: string, options: ApiOptions): Promise<T> => {
    const { timeoutMs = ['GET', 'HEAD'].includes(method) ? 30_000 : 0, ...rest } = options;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Invalid request timeout.');
    if (timeoutMs === 0) return performRequest<T>(endpoint, rest);
    try {
      return await withRequestDeadline(signal => performRequest<T>(endpoint, { ...rest, signal }), timeoutMs, rest.signal);
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new ApiError(error.message, 408);
      throw error;
    }
  };

  const postForm = async <T = unknown>(endpoint: string, formData: FormData, options?: ApiOptions & { onUploadProgress?: (percent: number) => void }): Promise<T> => {
    const { onUploadProgress, ...requestOptions } = options || {};
    if (!onUploadProgress) return request<T>(endpoint, { ...requestOptions, method: 'POST', body: formData });
    const headers = new Headers(requestOptions.headers);
    const token = !requestOptions.skipAuth && typeof window !== 'undefined' ? localStorage.getItem(config.tokenStorageKey) : null;
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (!requestOptions.skipAuth && config.tokenStorageKey === 'token') {
      Object.entries({ ...businessProfileHeaders(), ...(requestOptions.skipBillingOrganization ? {} : billingOrganizationHeaders(endpoint, 'POST')) }).forEach(([key, value]) => { if (!headers.has(key)) headers.set(key, value); });
    }
    const csrf = getCsrfToken();
    if (csrf) headers.set('x-xsrf-token', csrf);
    const send = () => uploadFormWithProgress(appendQueryParams(buildApiUrl(endpoint), requestOptions.params), formData, { headers, signal: requestOptions.signal, onProgress: onUploadProgress });
    let response = await send();
    if (response.status === 403 && errorMessage(response.data, '').toLowerCase().includes('csrf token')) {
      await fetch(buildApiUrl('/api/auth/csrf-token'), { credentials: 'include' });
      const refreshed = getCsrfToken();
      if (refreshed) { headers.set('x-xsrf-token', refreshed); response = await send(); }
    }
    if (response.status === 401 && !requestOptions.suppressUnauthorizedEvent) dispatchUnauthorized();
    if (response.status < 200 || response.status >= 300) throw new ApiError(errorMessage(response.data, `Upload failed (HTTP ${response.status})`), response.status, response.data);
    return unwrap<T>(normalizeApiTimestamps(response.data));
  };

  return {
    get: <T = unknown>(endpoint: string, options?: ApiOptions) =>
      request<T>(endpoint, { ...options, method: "GET" }),
    post: <T = unknown>(endpoint: string, data?: unknown, options?: ApiOptions) =>
      request<T>(endpoint, {
        ...options,
        method: "POST",
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
    put: <T = unknown>(endpoint: string, data?: unknown, options?: ApiOptions) =>
      request<T>(endpoint, {
        ...options,
        method: "PUT",
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
    patch: <T = unknown>(endpoint: string, data?: unknown, options?: ApiOptions) =>
      request<T>(endpoint, {
        ...options,
        method: "PATCH",
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
    delete: <T = unknown>(endpoint: string, options?: ApiOptions) =>
      request<T>(endpoint, { ...options, method: "DELETE" }),
    postForm,
    upload: postForm,
  };
}
