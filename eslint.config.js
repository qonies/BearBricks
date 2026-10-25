// ESLint flat config（technical-design §10）
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.cjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
  {
    // 聊天清洗正则包含控制字符（有意为之）；测试允许 any
    files: ['packages/server/src/**/*.ts', 'packages/shared/src/protocol/messages.ts'],
    rules: { 'no-control-regex': 'off' },
  },
  {
    files: ['**/tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);