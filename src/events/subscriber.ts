import { Queue } from 'bullmq';
import { createRedisClient } from '../lib/redis';
import { getConfig } from '../config';
import { logger } from '../lib/logger';
import { hasRecentSuccessfulRun } from '../db/jobStore';
import { TaggingJobData } from '../jobs/types';
import { taggingJobId } from '../queue';

interface RepositoryShape {
  id?: string;
  ingestStatus?: string;
  [key: string]: unknown;
}

interface LegacyIncomingEvent {
  event?: string;
  payload?: {
    repository?: RepositoryShape;
    [key: string]: unknown;
  };
}

interface EnvelopeIncomingEvent {
  origin?: string;
  event?: {
    type?: string;
    data?: {
      repository?: RepositoryShape;
      repositoryId?: string;
      ingestStatus?: string;
      event?: {
        repositoryId?: string;
        status?: string;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

type IncomingEvent = LegacyIncomingEvent | EnvelopeIncomingEvent;

interface NormalizedEvent {
  eventName: string;
  repositoryId: string;
  ingestStatus?: string;
}

const RECENCY_WINDOW_MS = 1000 * 60 * 60 * 12; // 12 hours

type RepositoryEventListener = (event: {
  eventName: string;
  repositoryId: string;
  ingestStatus?: string;
}) => void | Promise<void>;

export class EventSubscriber {
  private readonly redis = createRedisClient({ enableAutoPipelining: true });
  private listening = false;
  private readonly messageListener = (_channel: string, message: string) => {
    void this.handleMessage(message).catch((err) => {
      logger.error({ err }, 'Failed to handle incoming event');
    });
  };

  constructor(private readonly queue: Queue, private readonly repositoryListener?: RepositoryEventListener) {}

  async start(): Promise<void> {
    if (this.listening) {
      return;
    }
    const { REDIS_EVENTS_CHANNEL } = getConfig();
    await this.redis.subscribe(REDIS_EVENTS_CHANNEL);
    this.redis.on('message', this.messageListener);
    this.redis.on('error', (err) => {
      logger.error({ err }, 'Redis subscriber error');
    });
    this.listening = true;
    logger.info({ channel: getConfig().REDIS_EVENTS_CHANNEL }, 'Subscribed to repository events');
  }

  async stop(): Promise<void> {
    if (!this.listening) {
      return;
    }
    const { REDIS_EVENTS_CHANNEL } = getConfig();
    this.redis.removeListener('message', this.messageListener);
    await this.redis.unsubscribe(REDIS_EVENTS_CHANNEL);
    this.listening = false;
    await this.redis.quit();
  }

  private async handleMessage(raw: string): Promise<void> {
    let parsed: IncomingEvent;
    try {
      parsed = JSON.parse(raw) as IncomingEvent;
    } catch (error) {
      logger.warn({ raw }, 'Ignoring non-JSON event payload');
      return;
    }

    const normalized = this.normalizeEvent(parsed);
    if (!normalized) {
      return;
    }

    const { eventName, repositoryId, ingestStatus } = normalized;

    try {
      await this.repositoryListener?.({
        eventName,
        repositoryId,
        ingestStatus
      });
    } catch (error) {
      logger.warn({ error }, 'Repository event listener failed');
    }

    if (eventName === 'repository.updated' || eventName === 'repository.ingestion-event') {
      if (ingestStatus !== 'ready') {
        return;
      }
      const repoId = repositoryId;
      if (hasRecentSuccessfulRun(repoId, RECENCY_WINDOW_MS)) {
        logger.debug({ repoId }, 'Skipping event because repository was tagged recently');
        return;
      }
      await this.enqueueTaggingJob({ repositoryId: repoId, trigger: 'event' });
    }
  }

  private normalizeEvent(parsed: IncomingEvent): NormalizedEvent | null {
    let eventName: string | undefined;
    let repositoryId: string | undefined;
    let ingestStatus: string | undefined;

    if (typeof parsed?.event === 'string') {
      eventName = parsed.event;
      const payload = (parsed as LegacyIncomingEvent).payload;
      repositoryId = payload?.repository?.id;
      ingestStatus = payload?.repository?.ingestStatus;
    } else if (parsed && typeof parsed === 'object' && parsed.event && typeof parsed.event === 'object') {
      const envelopeEvent = parsed.event as EnvelopeIncomingEvent['event'];
      if (typeof envelopeEvent?.type === 'string') {
        eventName = envelopeEvent.type;
      }
      const data = envelopeEvent?.data;
      if (data && typeof data === 'object') {
        if (data.repository && typeof data.repository === 'object') {
          if (typeof data.repository.id === 'string') {
            repositoryId = data.repository.id;
          }
          if (typeof data.repository.ingestStatus === 'string') {
            ingestStatus = data.repository.ingestStatus;
          }
        }
        if (!repositoryId && typeof (data as { repositoryId?: string }).repositoryId === 'string') {
          repositoryId = (data as { repositoryId: string }).repositoryId;
        }
        if (!ingestStatus && typeof (data as { ingestStatus?: string }).ingestStatus === 'string') {
          ingestStatus = (data as { ingestStatus: string }).ingestStatus;
        }
        if (data.event && typeof data.event === 'object') {
          const nestedEvent = data.event as { repositoryId?: string; status?: string };
          if (!repositoryId && typeof nestedEvent.repositoryId === 'string') {
            repositoryId = nestedEvent.repositoryId;
          }
          if (!ingestStatus && typeof nestedEvent.status === 'string') {
            ingestStatus = nestedEvent.status;
          }
        }
      }
    }

    if (!eventName?.startsWith('repository.')) {
      return null;
    }
    if (!repositoryId) {
      logger.debug({ eventName }, 'Ignoring repository event without repository id');
      return null;
    }

    return { eventName, repositoryId, ingestStatus };
  }

  private async enqueueTaggingJob(data: TaggingJobData): Promise<void> {
    const jobId = taggingJobId(data.repositoryId);
    await this.queue.add('tag-repository', data, { jobId });
    logger.info({ repositoryId: data.repositoryId }, 'Enqueued tagging job from event');
  }
}
