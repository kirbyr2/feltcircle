import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'apps/*/test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20000,
  },
});
