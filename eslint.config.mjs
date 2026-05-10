import expoConfig from 'eslint-config-expo/flat.js';
import prettierConfig from 'eslint-config-prettier';
import refined from 'eslint-plugin-refined';
import tseslint from 'typescript-eslint';

const unusedVarsOptions = {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
  destructuredArrayIgnorePattern: '^_',
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/lib/**',
      '**/dist/**',
      '**/.expo/**',
      '**/.turbo/**',
      '**/build/**',
      '**/android/build/**',
      '**/android/app/build/**',
      '**/ios/Pods/**',
      'packages/ennio/nitrogen/generated/**',
      'patches/**',
      '**/*.xcassets/**',
      'bun.lock',
    ],
  },
  ...expoConfig,
  prettierConfig,
  {
    files: ['example/**/*.{ts,tsx}'],
    plugins: { refined },
    rules: refined.configs.recommended.rules,
  },
  {
    // Gauntlet intentionally exercises every touchable variant; disable
    // the avoid-touchable-opacity rule there. example/src/App.tsx is the
    // legacy non-router demo and isn't part of the live app surface.
    files: ['example/app/gauntlet/**/*.{ts,tsx}', 'example/src/**/*.{ts,tsx}'],
    rules: { 'refined/avoid-touchable-opacity': 'off' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'import/no-unresolved': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', unusedVarsOptions],
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['**/*.{js,jsx}'],
    rules: {
      'import/no-unresolved': 'off',
      'no-unused-vars': ['warn', unusedVarsOptions],
    },
  },
  {
    files: ['**/e2e/**/*.{ts,tsx,js,jsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
    },
  },
];
