import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    testMatch: 'extension.spec.ts',
    fullyParallel: false,
    workers: 1,
    timeout: 45_000,
    expect: { timeout: 8_000 },
    outputDir: 'test-results',
    reporter: 'list',
});
