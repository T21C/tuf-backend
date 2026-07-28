/**
 * Security-only ESLint config used to gate production builds.
 * Intentionally minimal so pre-existing style lint does not block deploys.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['tuf'],
  rules: {
    'tuf/no-unsafe-user-include': 'error',
  },
  ignorePatterns: [
    'dist/**/*',
    'dist.tmp/**/*',
    'build/**/*',
    'node_modules/**/*',
    'uploads/**/*',
    'temp/**/*',
    'cache/**/*',
    'backups/**/*',
    'profiles/**/*',
    'eslint-plugin-tuf/**/*',
    'ts-traces/**/*',
  ],
  reportUnusedDisableDirectives: false,
};
