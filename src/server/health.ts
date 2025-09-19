import { Queue } from 'bullmq';
import { createRedisClient } from '../lib/redis';
import { CatalogClient } from '../clients/catalog';
import { FileExplorerClient } from '../clients/fileExplorer';
import { getConfig } from '../config';

interface HealthCheckResult {
  status: 'ok' | 'error';
  detail?: string;
  latencyMs?: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  dependencies: {
    redis: HealthCheckResult;
    queue: HealthCheckResult;
    catalog: HealthCheckResult;
    fileExplorer: HealthCheckResult;
    aiConnector: HealthCheckResult;
  };
}

export async function runHealthChecks(queue: Queue): Promise<HealthReport> {
  const results = await Promise.all([
    checkRedis(),
    checkQueue(queue),
    checkCatalog(),
    checkFileExplorer(),
    checkAiConnector()
  ]);

  const [redis, queueResult, catalog, fileExplorer, aiConnector] = results;
  const dependencies = { redis, queue: queueResult, catalog, fileExplorer, aiConnector };
  const overall = Object.values(dependencies).every((d) => d.status === 'ok') ? 'ok' : 'degraded';

  return {
    status: overall,
    dependencies
  };
}

async function checkRedis(): Promise<HealthCheckResult> {
  const client = createRedisClient();
  const start = Date.now();
  try {
    await client.ping();
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    return { status: 'error', detail: (error as Error).message };
  } finally {
    await client.quit();
  }
}

async function checkQueue(queue: Queue): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    await queue.getJobCounts();
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    return { status: 'error', detail: (error as Error).message };
  }
}

async function checkCatalog(): Promise<HealthCheckResult> {
  const client = new CatalogClient();
  const start = Date.now();
  try {
    await client.listRepositories({ page: 1, perPage: 1 });
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    return { status: 'error', detail: (error as Error).message };
  }
}

async function checkFileExplorer(): Promise<HealthCheckResult> {
  const { FILE_EXPLORER_BASE_URL, FILE_EXPLORER_TOKEN } = getConfig();
  const start = Date.now();
  try {
    const response = await fetch(`${FILE_EXPLORER_BASE_URL.replace(/\/$/, '')}/healthz`, {
      headers: FILE_EXPLORER_TOKEN ? { Authorization: `Bearer ${FILE_EXPLORER_TOKEN}` } : undefined
    });
    if (!response.ok) {
      return { status: 'error', detail: `HTTP ${response.status}` };
    }
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    return { status: 'error', detail: (error as Error).message };
  }
}

async function checkAiConnector(): Promise<HealthCheckResult> {
  const { AI_CONNECTOR_BASE_URL } = getConfig();
  const start = Date.now();
  try {
    const response = await fetch(`${AI_CONNECTOR_BASE_URL.replace(/\/$/, '')}/healthz`);
    if (!response.ok) {
      return { status: 'error', detail: `HTTP ${response.status}` };
    }
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    return { status: 'error', detail: (error as Error).message };
  }
}
