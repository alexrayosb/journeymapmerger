// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'fixtures/**',
      '.wrangler/**',
      'tools/spike/results/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/**/*.ts', 'tools/spike/web/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
  },
  {
    files: ['tools/**/*.ts', 'tests/**/*.ts', 'vite.config.ts'],
    ignores: ['tools/spike/web/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.js'],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
