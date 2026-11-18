import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import stylistic from '@stylistic/eslint-plugin';

export default [
  { ignores: ['node_modules/**', '.venv/**', '.tools/**', 'public/vendor/**', 'dist/**'] },
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: { parser: tseslint.parser },
    ...js.configs.recommended,
    plugins: { '@stylistic': stylistic, '@typescript-eslint': tseslint.plugin },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description' }],
      '@typescript-eslint/no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/eol-last': ['error', 'always'],
      '@stylistic/no-multiple-empty-lines': ['error', { max: 2, maxEOF: 0 }],
    },
  },
  { files: ['**/*.mts'], languageOptions: { globals: globals.node } },
  { files: ['scripts/smoke-browser.mts'], languageOptions: { globals: globals.browser } },
  { files: ['public/**/*.ts'], languageOptions: { globals: globals.browser } },
];
