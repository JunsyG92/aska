'use strict';
// Règles de qualité vérifiées par la CI (npm run lint).
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
    // Les tests de bout en bout envoient du code à exécuter dans la page (page.evaluate).
    files: ['test/e2e/**/*.js', 'scripts/readme-media.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Les séquences ANSI sont ici voulues : on vérifie leur filtrage.
    files: ['src/main/runner.js', 'src/cli.js', 'test/**/*.js'],
    rules: { 'no-control-regex': 'off' },
  },
  {
    // Interface : navigateur en bac à sable, sans Node.
    files: ['src/renderer/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
];
