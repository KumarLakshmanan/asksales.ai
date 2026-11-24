/**
 * Timing Constants
 *
 * Timeouts, polling intervals, delays, and streaming chunk sizes.
 */

// ─── Streaming / WebSocket ──────────────────────────────────────────────────────

/** WebSocket heartbeat interval (ms) */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

/** Delay in LangGraph graph processing (ms) */
export const GRAPH_PROCESSING_DELAY_MS = 200;

// ─── Polling Intervals ──────────────────────────────────────────────────────────

/** Analytics / cron poll interval (5 minutes) */
export const ANALYTICS_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Actor health check interval (5 minutes) */
export const ACTOR_HEALTH_CHECK_INTERVAL_MS = 300_000;

/** Actor health check timeout (10 seconds) */
export const ACTOR_HEALTH_CHECK_TIMEOUT_MS = 10_000;

/** Channel session cache timeout (5 minutes) */
export const CHANNEL_SESSION_CACHE_TIMEOUT_MS = 5 * 60 * 1000;

/** Channel session cleanup interval (1 minute) */
export const CHANNEL_SESSION_CLEANUP_INTERVAL_MS = 60_000;

/** Outreach sender poll interval (5 seconds) */
export const OUTREACH_POLL_INTERVAL_MS = 5_000;

/** Video generation poll interval (10 seconds) */
export const VIDEO_POLL_INTERVAL_MS = 10_000;

/** Video generation max poll attempts (60 × 10s = 10 min) */
export const VIDEO_MAX_POLL_ATTEMPTS = 60;

/** Image generation timeout (3 minutes) */
export const IMAGE_GENERATION_TIMEOUT_MS = 3 * 60 * 1000;

/** Video generation timeout (5 minutes) */
export const VIDEO_GENERATION_TIMEOUT_MS = 5 * 60 * 1000;

/** Individual LLM HTTP request timeout (2 minutes). Must remain below widget execution leases. */
export const LLM_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

// ─── Retry / Backoff ────────────────────────────────────────────────────────────

// ─── Batch Sizes ────────────────────────────────────────────────────────────────

/** Outreach sender batch size */
export const OUTREACH_SENDER_BATCH_SIZE = 10;

/** Outreach sender max concurrent */
export const OUTREACH_SENDER_MAX_CONCURRENT = 3;

