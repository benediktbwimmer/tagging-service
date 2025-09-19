import IORedis, { Redis, RedisOptions } from 'ioredis';
import { getConfig } from '../config';

export function createRedisClient(overrides: Partial<RedisOptions> = {}): Redis {
  const { REDIS_URL } = getConfig();
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    ...overrides
  });
}
