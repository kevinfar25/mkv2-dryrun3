// Minimal-but-real lint config. Its job in this sandbox is to be a THIRD blocking CI check,
// matching tradegamesfinal's required-check set (typecheck·test·build / migration hygiene / lint).
// The MK V2 jig's `ci-wait --require` must have three required checks to enforce, and a
// deliberately-broken phase must be able to redden this one specifically.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '.next/**', 'node_modules/**', 'next-env.d.ts', '.mkv2-run/**', 'db/**',
      // The skill under test is the TOOL, not this sandbox's app code. Linting it here would
      // mean any upstream skill edit reddens sandbox CI — and the drift guard requires the copy
      // to stay byte-identical to canonical, so the lint could never be fixed locally anyway.
      '.claude/**',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly' },
    },
    rules: {
      // Real rules with teeth, so a sloppy phase genuinely fails lint rather than
      // lint being a rubber stamp that only ever passes.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-debugger': 'error',
      'prefer-const': 'error',
      'no-var': 'error',   // does not flag ambient `declare global` vars — see lib/db.ts
      'eqeqeq': ['error', 'always'],
    },
  },
  {
    // The prior run's formatting tests deliberately feed precision-edge numeric literals to
    // prove the formatter does not silently mangle them. Flagging the literals defeats the test.
    files: ['tests/**', 'e2e/**'],
    rules: { 'no-loss-of-precision': 'off' },
  },
];
