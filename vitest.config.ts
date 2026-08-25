import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@counterparty/core': r('./packages/core/src/index.ts'),
      '@counterparty/demo': r('./packages/demo/src/index.ts'),
      '@counterparty/config': r('./packages/config/src/index.ts'),
      '@counterparty/llm': r('./packages/llm/src/index.ts'),
      '@counterparty/rails': r('./packages/rails/src/index.ts'),
      '@counterparty/extract': r('./packages/extract/src/index.ts'),
      '@counterparty/agents': r('./packages/agents/src/index.ts'),
      '@counterparty/store': r('./packages/store/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scenarios/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});

