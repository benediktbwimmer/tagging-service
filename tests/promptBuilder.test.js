"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const prompt_1 = require("src/utils/prompt");
beforeEach(() => {
    (0, prompt_1.resetPromptTemplateCache)();
});
test('buildPrompt interpolates context values', async () => {
    const context = {
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
    const prompt = await (0, prompt_1.buildPrompt)(context);
    expect(prompt).toContain('Tagging Service');
    expect(prompt).toContain('language: typescript');
    expect(prompt).toContain('src/index.ts');
    expect(prompt).toContain('console.log("hello")');
});
