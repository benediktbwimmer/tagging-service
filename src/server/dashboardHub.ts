import type { Queue } from 'bullmq';
import type WebSocket from 'ws';
import { getJobStatusCounts, listRecentRuns, type RecentJobRunRecord } from '../db/jobStore';
import { logger } from '../lib/logger';

interface DashboardSummary {
  totalJobs: number;
  queuedJobs: number;
  runningJobs: number;
  succeededJobs: number;
  failedJobs: number;
}

interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export type DashboardEventType =
  | 'repository-event'
  | 'job-enqueued'
  | 'job-started'
  | 'job-completed'
  | 'job-failed';

export interface DashboardEvent {
  id: number;
  timestamp: string;
  type: DashboardEventType;
  message: string;
  repositoryId?: string;
  details?: Record<string, unknown>;
}

export interface DashboardSnapshot {
  generatedAt: string;
  summary: DashboardSummary;
  queue: QueueCounts;
  events: DashboardEvent[];
}

export interface RepositoryEventPayload {
  eventName: string;
  repositoryId: string;
  ingestStatus?: string;
}

const MAX_EVENTS = 50;

export class DashboardHub {
  private clients = new Set<WebSocket>();
  private events: DashboardEvent[] = [];
  private snapshot: DashboardSnapshot = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalJobs: 0,
      queuedJobs: 0,
      runningJobs: 0,
      succeededJobs: 0,
      failedJobs: 0
    },
    queue: {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0
    },
    events: []
  };
  private nextEventId = 1;

  constructor(private readonly queue: Queue) {}

  async bootstrap(): Promise<void> {
    const recentRuns = listRecentRuns(MAX_EVENTS).reverse();
    for (const run of recentRuns) {
      const timestamp = run.completed_at ?? run.started_at;
      const type: DashboardEventType = run.status === 'failed' ? 'job-failed' : 'job-completed';
      const message =
        run.status === 'failed'
          ? `Run ${run.id} failed${run.error_message ? `: ${run.error_message}` : ''}`
          : `Run ${run.id} succeeded`;
      this.pushEvent({
        type,
        timestamp,
        repositoryId: run.repository_id,
        message,
        details: buildRunDetails(run)
      });
    }

    await this.refreshSnapshot();
  }

  addClient(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on('close', () => {
      this.clients.delete(socket);
    });
    socket.on('error', (err) => {
      logger.warn({ err }, 'Dashboard client socket error');
      this.clients.delete(socket);
    });
    socket.send(JSON.stringify({ type: 'snapshot', payload: this.snapshot }));
  }

  async refreshSnapshot(): Promise<void> {
    const statusCounts = getJobStatusCounts();
    const jobCounts = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');

    this.snapshot = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalJobs: statusCounts.total,
        queuedJobs: statusCounts.queued,
        runningJobs: statusCounts.running,
        succeededJobs: statusCounts.succeeded,
        failedJobs: statusCounts.failed
      },
      queue: {
        waiting: jobCounts.waiting ?? 0,
        active: jobCounts.active ?? 0,
        completed: jobCounts.completed ?? 0,
        failed: jobCounts.failed ?? 0,
        delayed: jobCounts.delayed ?? 0
      },
      events: [...this.events]
    };

    this.broadcast();
  }

  async recordRepositoryEvent(event: RepositoryEventPayload): Promise<void> {
    this.pushEvent({
      type: 'repository-event',
      timestamp: new Date().toISOString(),
      repositoryId: event.repositoryId,
      message: `${event.eventName} (${event.ingestStatus ?? 'unknown'})`
    });
    await this.refreshSnapshot();
  }

  async recordJobEvent(
    type: Exclude<DashboardEventType, 'repository-event'>,
    data: {
      repositoryId?: string;
      jobId?: string;
      message: string;
      details?: Record<string, unknown>;
    }
  ): Promise<void> {
    this.pushEvent({
      type,
      timestamp: new Date().toISOString(),
      repositoryId: data.repositoryId,
      message: data.message,
      details: data.details
    });
    await this.refreshSnapshot();
  }

  private broadcast(): void {
    const payload = JSON.stringify({ type: 'snapshot', payload: this.snapshot });
    for (const socket of this.clients) {
      if (socket.readyState !== socket.OPEN) {
        this.clients.delete(socket);
        continue;
      }
      try {
        socket.send(payload);
      } catch (err) {
        logger.warn({ err }, 'Failed to broadcast dashboard snapshot');
        this.clients.delete(socket);
      }
    }
  }

  private pushEvent(event: Omit<DashboardEvent, 'id'>): void {
    const entry: DashboardEvent = { id: this.nextEventId++, ...event };
    this.events = [entry, ...this.events].slice(0, MAX_EVENTS);
  }
}

function buildRunDetails(run: RecentJobRunRecord): Record<string, unknown> {
  return {
    jobRunId: run.id,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    status: run.status,
    latencyMs: run.latency_ms,
    promptTokens: run.prompt_tokens,
    completionTokens: run.completion_tokens,
    costUsd: run.cost_usd
  };
}
