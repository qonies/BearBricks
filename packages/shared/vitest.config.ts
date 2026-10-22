import { defineConfig } from 'vitest/config';

// 覆盖率门槛（test-plan §2：shared ≥ 85%）；阈值取略低于基线防回退，branches 余量小、删测试前先跑 coverage
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 85,
        lines: 90,
      },
    },
  },
});
