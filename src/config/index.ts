import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

loadEnv();

const configSchema = z.object({
  NODE_ENV: z.string().optional().default('development'),
  PORT: z.coerce.number().int().positive().default(5103),
  REDIS_URL: z.string().url(),
  REDIS_EVENTS_CHANNEL: z.string().min(1).default('apphub:events'),
  CATALOG_BASE_URL: z.string().url(),
  CATALOG_TOKEN: z.string().min(1, 'CATALOG_TOKEN is required'),
  FILE_EXPLORER_BASE_URL: z.string().url(),
  FILE_EXPLORER_TOKEN: z.string().optional(),
  AI_CONNECTOR_BASE_URL: z.string().url(),
  AI_CONNECTOR_MODEL: z.string().min(1).default('gpt-4o-mini'),
  WORKSPACE_ROOT: z.string().min(1).default('./workspace'),
  TAGGING_CONCURRENCY: z.coerce.number().int().positive().default(2),
  TAGGING_PROMPT_TEMPLATE_PATH: z.string().min(1).default('templates/default_prompt.md'),
  WEBHOOK_URL: z.string().url().optional(),
  DATABASE_PATH: z.string().min(1).default('data/tagging-service.sqlite'),
  LOG_LEVEL: z.string().optional().default('info')
});

export type ServiceConfig = z.infer<typeof configSchema> & {
  workspaceRootAbs: string;
  promptTemplatePathAbs: string;
  databasePathAbs: string;
};

let cachedConfig: ServiceConfig | null = null;

export function getConfig(): ServiceConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = configSchema.parse(process.env);
  const workspaceRootAbs = path.resolve(parsed.WORKSPACE_ROOT);
  const promptTemplatePathAbs = path.resolve(parsed.TAGGING_PROMPT_TEMPLATE_PATH);
  const databasePathAbs = path.resolve(parsed.DATABASE_PATH);

  cachedConfig = {
    ...parsed,
    workspaceRootAbs,
    promptTemplatePathAbs,
    databasePathAbs
  };

  return cachedConfig;
}
