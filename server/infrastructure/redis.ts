/**
 * Redis Connection Manager
 * Provides shared Redis connection for BullMQ, Event Bus, Rate Limiting, and Caching
 */

import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

let redisConnection: Redis | null = null;
let subscriberConnection: Redis | null = null;

/**
 * Build Redis connection options from environment variables
 */
function getRedisConfig() {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
    retryStrategy: (times: number) => {
      if (times > 10) {
        logger.error('[Redis] Max retries reached, giving up');
        return null;
      }
      const delay = Math.min(times * 200, 5000);
      logger.warn(`[Redis] Retrying connection in ${delay}ms (attempt ${times})`);
      return delay;
    },
  };
}

/**
 * Get or create the main Redis connection (for BullMQ producers, caching, etc.)
 */
export function getRedisConnection(): Redis {
  if (!redisConnection) {
    const config = getRedisConfig();
    redisConnection = new Redis(config);

    redisConnection.on('connect', () => {
      logger.info('[Redis] Connected successfully');
    });

    redisConnection.on('error', (err) => {
      logger.error({ err }, '[Redis] Connection error');
    });

    redisConnection.on('close', () => {
      logger.warn('[Redis] Connection closed');
    });
  }
  return redisConnection;
}

/**
 * Get or create a subscriber Redis connection (for Pub/Sub - needs dedicated connection)
 */
export function getRedisSubscriber(): Redis {
  if (!subscriberConnection) {
    const config = getRedisConfig();
    subscriberConnection = new Redis(config);

    subscriberConnection.on('connect', () => {
      logger.info('[Redis:Subscriber] Connected successfully');
    });

    subscriberConnection.on('error', (err) => {
      logger.error({ err }, '[Redis:Subscriber] Connection error');
    });
  }
  return subscriberConnection;
}

/**
 * Check if Redis is available
 */
export async function isRedisAvailable(): Promise<boolean> {
  try {
    const redis = getRedisConnection();
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Gracefully close all Redis connections
 */
export async function closeRedisConnections(): Promise<void> {
  const promises: Promise<void>[] = [];

  if (redisConnection) {
    promises.push(
      redisConnection.quit().then(() => {
        redisConnection = null;
        logger.info('[Redis] Main connection closed');
      })
    );
  }

  if (subscriberConnection) {
    promises.push(
      subscriberConnection.quit().then(() => {
        subscriberConnection = null;
        logger.info('[Redis:Subscriber] Subscriber connection closed');
      })
    );
  }

  await Promise.all(promises);
}
