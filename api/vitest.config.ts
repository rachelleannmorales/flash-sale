import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // One shared Postgres; parallel files exhaust max_connections and the pool.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 20_000,
    reporters: 'default',
    environment: 'node',
  },
});
