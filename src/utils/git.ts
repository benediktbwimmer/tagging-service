import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { getConfig } from '../config';
import { logger } from '../lib/logger';
import { TransientJobError } from '../jobs/errors';

const execFileAsync = promisify(execFile);

async function runGit(args: string[], options: { cwd?: string } = {}): Promise<void> {
  try {
    await execFileAsync('git', args, options);
  } catch (error) {
    throw new TransientJobError(`Git command failed: git ${args.join(' ')}`, error);
  }
}

export async function ensureWorkspace(): Promise<string> {
  const { workspaceRootAbs } = getConfig();
  if (!fs.existsSync(workspaceRootAbs)) {
    fs.mkdirSync(workspaceRootAbs, { recursive: true });
  }
  return workspaceRootAbs;
}

export interface CheckoutOptions {
  repositoryId: string;
  repoUrl: string;
  defaultBranch?: string;
}

export async function ensureRepositoryCheckout(options: CheckoutOptions): Promise<string> {
  const root = await ensureWorkspace();
  const repoPath = path.join(root, options.repositoryId);
  const branch = options.defaultBranch ?? 'main';

  if (!fs.existsSync(repoPath)) {
    logger.info({ repoPath }, 'Cloning repository for tagging');
    await runGit(['clone', '--depth', '1', '--branch', branch, options.repoUrl, repoPath]);
    return repoPath;
  }

  logger.info({ repoPath }, 'Refreshing repository for tagging');
  await runGit(['fetch', '--all', '--prune'], { cwd: repoPath });
  try {
    await runGit(['rev-parse', `origin/${branch}`], { cwd: repoPath });
    await runGit(['reset', '--hard', `origin/${branch}`], { cwd: repoPath });
  } catch (error) {
    logger.warn({ repoPath, branch, err: error }, 'Falling back to git pull');
    await runGit(['pull', '--ff-only'], { cwd: repoPath });
  }

  return repoPath;
}
