import { defineConfig } from 'vitest/config';

// Unit tests: no network, Claude is faked.
export default defineConfig({ test: { environment: 'node', include: ['src/**/*.test.ts'] } });
