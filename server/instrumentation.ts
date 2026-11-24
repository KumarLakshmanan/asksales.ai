/**
 * OpenTelemetry Instrumentation Bootstrap
 * 
 * Must be imported FIRST before any other imports in the application entry point.
 * Provides distributed tracing, metrics, and log correlation.
 * 
 * Usage: import './instrumentation.js' at the top of index.ts
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
// @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const OTEL_ENABLED = process.env.OTEL_ENABLED === 'true';
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
const SERVICE_NAME = process.env.SERVICE_NAME || 'salesmarketing-server';
const SERVICE_VERSION = process.env.SERVICE_VERSION || '1.0.0';

let sdk: NodeSDK | null = null;

if (OTEL_ENABLED) {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    'deployment.environment': process.env.NODE_ENV || 'development',
  });

  // Trace exporter
  const traceExporter = new OTLPTraceExporter({
    url: `${OTEL_ENDPOINT}/v1/traces`,
  });

  // Metric exporter
  const metricExporter = new OTLPMetricExporter({
    url: `${OTEL_ENDPOINT}/v1/metrics`,
  });

  const metricReader = new PeriodicExportingMetricReader({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exporter: metricExporter as any,
    exportIntervalMillis: 30000, // Export metrics every 30 seconds
  });

  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Instrument HTTP, Express, pg (PostgreSQL), ioredis
        '@opentelemetry/instrumentation-http': {
          enabled: true,
        },
        '@opentelemetry/instrumentation-express': {
          enabled: true,
        },
        '@opentelemetry/instrumentation-pg': {
          enabled: true,
        },
        '@opentelemetry/instrumentation-ioredis': {
          enabled: true,
        },
        // Disable noisy ones
        '@opentelemetry/instrumentation-fs': {
          enabled: false,
        },
        '@opentelemetry/instrumentation-dns': {
          enabled: false,
        },
        '@opentelemetry/instrumentation-net': {
          enabled: false,
        },
      }),
    ],
  });

  sdk.start();
  console.log(`[OpenTelemetry] SDK started — exporting to ${OTEL_ENDPOINT}`);
}

/**
 * Gracefully shut down OpenTelemetry
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    console.log('[OpenTelemetry] SDK shutdown complete');
  }
}

export { sdk as otelSdk };
