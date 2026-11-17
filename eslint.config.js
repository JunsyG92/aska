'use strict';
// Quality rules checked by CI (npm run lint).
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'dist/', 'test/e2e/out/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-implicit-globals': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // End-to-end tests send code to run in the page (page.evaluate).
    files: ['test/e2e/**/*.js', 'scripts/readme-media.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // ANSI sequences are intended here: we check that they are filtered.
    files: ['src/main/runner.js', 'src/cli.js', 'test/**/*.js'],
    rules: { 'no-control-regex': 'off' },
  },
  {
    // UI: sandboxed browser, without Node.
    files: ['src/renderer/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
];
