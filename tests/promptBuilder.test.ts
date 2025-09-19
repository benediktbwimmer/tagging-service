import { buildPrompt, resetPromptTemplateCache } from 'src/utils/prompt';
import { PromptContext } from 'src/jobs/types';

beforeEach(() => {
  resetPromptTemplateCache();
});

test('buildPrompt interpolates context values', async () => {
  const context: PromptContext = {
    repository: {
      id: 'repo-123',
      name: 'Tagging Service',
      repoUrl: 'https://example.com/repo.git',
      description: 'A test repository',
      defaultBranch: 'main',
      readme: 'This README describes the repo.',
      tags: [{ key: 'language', value: 'typescript' }]
    },
    existingTags: [{ key: 'language', value: 'typescript' }],
    fileSummaries: [{ path: 'src/index.ts', snippet: 'console.log("hello")' }]
  };

  const prompt = await buildPrompt(context);
  expect(prompt).toContain('Tagging Service');
  expect(prompt).toContain('language: typescript');
  expect(prompt).toContain('src/index.ts');
  expect(prompt).toContain('console.log("hello")');
});
