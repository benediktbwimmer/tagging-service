import fs from 'node:fs/promises';
import { getConfig } from '../config';
import { PromptContext } from '../jobs/types';

let templateCache: string | null = null;

async function loadTemplate(): Promise<string> {
  if (templateCache) {
    return templateCache;
  }
  const { promptTemplatePathAbs } = getConfig();
  const content = await fs.readFile(promptTemplatePathAbs, 'utf8');
  templateCache = content;
  return content;
}

function interpolate(template: string, replacements: Record<string, string>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => {
    return replacements[key] ?? '';
  });
}

export async function buildPrompt(context: PromptContext): Promise<string> {
  const template = await loadTemplate();
  const repositorySummary = [
    `Name: ${context.repository.name}`,
    context.repository.description ? `Description: ${context.repository.description}` : undefined,
    context.repository.defaultBranch ? `Default branch: ${context.repository.defaultBranch}` : undefined,
    `Repository URL: ${context.repository.repoUrl}`
  ]
    .filter(Boolean)
    .join('\n');

  const existingTags = context.existingTags
    .map((tag) => `- ${tag.key}: ${tag.value}`)
    .join('\n');

  const fileSummaries = context.fileSummaries
    .map((file) => `## ${file.path}\n${file.snippet}\n`)
    .join('\n');

  return interpolate(template, {
    repositorySummary,
    existingTags: existingTags || 'No existing tags.',
    readmeSummary: context.repository.readme?.slice(0, 4000) ?? 'README not available.',
    fileSummaries: fileSummaries || 'No file summaries available.'
  });
}

export function resetPromptTemplateCache(): void {
  templateCache = null;
}
