import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { FileExplorerClient } from '../clients/fileExplorer';
import { logger } from '../lib/logger';
import { FileSummary } from './types';

const MAX_FILES = 20;
const MAX_SNIPPET_LENGTH = 800;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'venv']);

function truncateSnippet(content: string): string {
  if (content.length <= MAX_SNIPPET_LENGTH) {
    return content;
  }
  return `${content.slice(0, MAX_SNIPPET_LENGTH)}\n...`;
}

async function readSnippet(filePath: string): Promise<string> {
  const stats = await fsPromises.stat(filePath);
  if (stats.size > 200_000) {
    const handle = await fsPromises.open(filePath, 'r');
    const buffer = Buffer.alloc(2000);
    await handle.read(buffer, 0, 2000, 0);
    await handle.close();
    return truncateSnippet(buffer.toString('utf8'));
  }
  const content = await fsPromises.readFile(filePath, 'utf8').catch(() => '');
  return truncateSnippet(content);
}

async function discoverLocalFiles(repoPath: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [repoPath];

  while (stack.length && results.length < MAX_FILES) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await fsPromises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= MAX_FILES) {
        break;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const relative = path.relative(repoPath, fullPath);
        results.push(relative);
      }
    }
  }

  return results;
}

export async function gatherFileSummaries(
  repositoryId: string,
  repoPath: string,
  fileExplorerClient: FileExplorerClient
): Promise<FileSummary[]> {
  const summaries: FileSummary[] = [];

  try {
    const explorerResults = await fileExplorerClient.searchFiles(repositoryId, MAX_FILES);
    if (explorerResults?.length) {
      for (const result of explorerResults.slice(0, MAX_FILES)) {
        const snippet = result.preview ?? (await readSnippet(path.join(repoPath, result.path)).catch(() => ''));
        summaries.push({ path: result.path, snippet });
      }
    }
  } catch (error) {
    logger.warn({ repositoryId, err: error }, 'File explorer search failed, falling back to local discovery');
  }

  if (summaries.length === 0 && fs.existsSync(repoPath)) {
    const localFiles = await discoverLocalFiles(repoPath);
    for (const relativePath of localFiles) {
      const snippet = await readSnippet(path.join(repoPath, relativePath)).catch(() => '');
      summaries.push({ path: relativePath, snippet });
    }
  }

  return summaries.slice(0, MAX_FILES);
}
