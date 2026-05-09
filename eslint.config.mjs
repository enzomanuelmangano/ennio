import expoConfig from 'eslint-config-expo/flat.js';
import prettierConfig from 'eslint-config-prettier';
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
      'packages/core/nitrogen/generated/**',
      'patches/**',
      '**/*.xcassets/**',
      'bun.lock',
    ],
  },
  ...expoConfig,
  prettierConfig,
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
