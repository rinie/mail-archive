const { configs, plugins } = require('eslint-config-airbnb-extended');

module.exports = [
  { ignores: ['node_modules/**', 'attachments/**', 'mail.duckdb*'] },
  plugins.importX,
  plugins.stylistic,
  plugins.node,
  ...configs.base.recommended,
  ...configs.node.recommended,
  {
    languageOptions: {
      sourceType: 'commonjs',
      parserOptions: { ecmaVersion: 'latest' },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Ingestion is a synchronous, single-threaded CLI walk over local mbox
    // files (byte-exact offsets, no concurrent requests to serve) — sync
    // fs calls are the natural fit here, not an accidental blocking bug.
    files: ['backend/ingest/**/*.js'],
    rules: {
      'n/no-sync': 'off',
    },
  },
];
