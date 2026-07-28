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
    'tuf/no-raw-user-in-response': 'error',
  },
  // `lint` runs with --no-inline-config, so exemptions live here where they show
  // up in review rather than in an eslint-disable comment next to the code.
  overrides: [
    {
      // The one sanctioned reader of password hashes.
      files: ['src/server/services/auth/passwordCredential.ts'],
      rules: {'tuf/no-unsafe-user-include': 'off'},
    },
    {
      // One-off migration / backfill scripts operate on credential columns by
      // design and never serve HTTP responses.
      files: ['src/misc/scripts/**/*.ts', 'src/database/migrations/**/*'],
      rules: {'tuf/no-unsafe-user-include': 'off'},
    },
  ],
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
