import { defineConfig } from 'vitest/config';
import { buildDefines } from './apps/web/build-info';

export default defineConfig({
  define: buildDefines(),
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'apps/*/test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20000,
  },
});
