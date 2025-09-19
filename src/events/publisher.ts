import { getConfig } from '../config';
import { createRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';

export class EventPublisher {
  private readonly channel: string;
  private readonly redis = createRedisClient();

  constructor(channel?: string) {
    const { REDIS_EVENTS_CHANNEL } = getConfig();
    this.channel = channel ?? REDIS_EVENTS_CHANNEL;
  }

  async publish(event: string, payload: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify({ event, payload, emittedAt: new Date().toISOString() });
    try {
      await this.redis.publish(this.channel, body);
    } catch (error) {
      logger.error({ event, err: error }, 'Failed to publish event');
    }
  }
}
