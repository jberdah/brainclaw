// Flat ESLint config (ESLint 9 + typescript-eslint).
//
// Deliberately lenient baseline for an existing, mature codebase adopting lint
// late: the goal is a GREEN `npm run lint` today (0 errors) that gates obvious
// mistakes, with the noisier stylistic/type rules downgraded to warnings so the
// team can ratchet them up over time. Type-aware rules (the `*-type-checked`
// presets) are intentionally NOT enabled — they require full type info and are
// far noisier; `tsc --noEmit` already covers type correctness in CI.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-test/**',
      'node_modules/**',
      'coverage/**',
      'vscode-extension/**', // has its own toolchain
      '**/*.d.ts',
      'scripts/**', // build/release scripts — not part of the shipped surface
      'tests/fixtures/**', // test INPUT data (e.g. Code Map extractor fixtures with
                           // intentional `var` / syntax errors) — not lintable source
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // `any` is used pragmatically across MCP boundary code — warn, don't block.
      '@typescript-eslint/no-explicit-any': 'off',
      // Unused vars: allow `_`-prefixed args/vars; don't flag caught errors.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      // Control chars appear in ANSI-handling / sentinel code on purpose.
      'no-control-regex': 'off',
      // TypeScript's own checker resolves identifiers; ESLint's `no-undef` only
      // produces false positives on TS globals/types/ambient decls. Disabling it
      // is the typescript-eslint-recommended setup for TS sources.
      'no-undef': 'off',
      // Late lint adoption: these fire across existing code. Surface as warnings
      // (visible, non-blocking) and ratchet to 'error' once each is cleared.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      'no-useless-escape': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
    },
  },
  {
    // Tests assert on internal shapes and intentionally build odd inputs.
    files: ['tests/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty': 'off',
    },
  },
);
