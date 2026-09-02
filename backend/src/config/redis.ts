import Redis from 'ioredis';
import config from '../config';
import logger from '../utils/logger';

const redis = new Redis(config.redis.url, {
  password: config.redis.password,
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  lazyConnect: true,
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

redis.on('error', (err) => {
  logger.error('Redis connection error', err);
});

/**
 * Cache a value with optional TTL (seconds).
 */
export async function cacheSet(key: string, value: any, ttl?: number): Promise<void> {
  try {
    const serialized = JSON.stringify(value);
    if (ttl) {
      await redis.setex(key, ttl, serialized);
    } else {
      await redis.set(key, serialized);
    }
  } catch {
    // Silently fail — cache is optional
  }
}

/**
 * Retrieve a cached value.
 */
export async function cacheGet<T = any>(key: string): Promise<T | null> {
  try {
    const value = await redis.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  } catch {
    return null;
  }
}

/**
 * Delete a cached value.
 */
export async function cacheDel(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch {
    // Silently fail
  }
}

/**
 * Invalidate all keys matching a pattern.
 */
export async function cacheInvalidate(pattern: string): Promise<void> {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // Silently fail
  }
}

export default redis;
