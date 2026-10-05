import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

/**
 * Lint config.
 *
 * The source carried ten `eslint-disable` comments with no linter installed to
 * read them, so they were decoration. This makes them real, and — more usefully
 * — makes the rules that would have caught a stale hook dependency enforceable
 * in CI rather than a matter of memory.
 *
 * Type-aware linting is on: `tsc --noEmit` proves the code is well-typed but says
 * nothing about whether a `useEffect` is reading a value it did not declare, and
 * that is the class of bug that is invisible in review and intermittent at
 * runtime.
 */
export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'android', 'e2e-screenshots'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  /* ---------------- the app ---------------- */
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.browser, ...globals.worker },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // `no-undef` is redundant and wrong on TypeScript: it reports every DOM
      // and worker global as undefined because it reads no type information,
      // while `tsc` already resolves all of them against `lib.dom` and
      // `lib.webworker`. Two tools disagreeing about the same fact is worse
      // than one tool being right.
      'no-undef': 'off',
      // Underscore-prefixed args are how this codebase marks a deliberately
      // unused callback parameter, so they are exempt from the unused rule.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // `any` is the single largest hole in a TypeScript codebase, but this one
      // legitimately uses it at the map-spec boundary: MapLibre's
      // `StyleSpecification` cannot express the layer definitions the offline
      // style builds programmatically. It is allowed, and counted, so the
      // number stays visible instead of quietly growing.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['error', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  /* ---------------- the OSM worker ----------------
   *
   * `engine.worker.ts` is loaded via `new Worker(..., { type: 'module' })` and
   * runs in a worker global scope, so it gets worker globals rather than the
   * browser's — most importantly no `window` and no DOM. */
  {
    files: ['src/osm/engine.worker.ts', 'src/osm/pbf.ts'],
    languageOptions: { globals: { ...globals.worker } },
  },

  /* ---------------- tests ----------------
   *
   * Tests reach into deliberately awkward states on purpose: undefined error
   * values, circular objects, `any`-typed JSON. Holding them to the same
   * standards as app code would mean filling every one with a suppression. */
  {
    files: ['test/**/*.{ts,tsx,mjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-console': 'off',
    },
  },

  /* ---------------- node-side tooling ----------------
   *
   * `tools/` and the `.mjs` suites run under Node, not the WebView, and use
   * globals that are neither `browser` nor `worker`: `process`, `TextEncoder`,
   * `ReadableStream` and `CompressionStream` are all Node globals. */
  {
    files: ['tools/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off', 'no-undef': 'off' },
  },

  /* ---------------- config files ---------------- */
  {
    files: ['vite.config.ts', 'capacitor.config.ts', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'react-refresh/only-export-components': 'off', 'no-undef': 'off' },
  },
);