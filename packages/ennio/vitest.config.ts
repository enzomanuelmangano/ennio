import { defineConfig } from 'vitest/config';

// Unit tests run against the CLI source directly (no simulator, no
// socket, no idb). Integration / E2E lives in `ennio test
// example/maestro-e2e` and is intentionally NOT a vitest suite.
export default defineConfig({
  test: {
    include: ['src/cli/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
