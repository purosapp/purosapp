module.exports = {
  root: true,
  ignorePatterns: [
    'build/',
    'dist/',
    'dist-electron/',
    'node_modules/',
    'release/',
    'vendor/',
    'electron/main/providers/generated.ts',
    'electron/generated-provider-runtime.ts',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['providers/**', '**/providers/*/src/**', '**/providers/*/helper/**', '@providers/**'],
        message: 'Core code must depend on the versioned provider API, never provider implementations.',
      }],
    }],
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'error',
  },
  overrides: [{
    files: ['tests/**/*.test.ts', 'tests/fixtures/**/*.ts'],
    rules: {
      // Integration tests live outside core and may compare both sides of the boundary.
      'no-restricted-imports': 'off',
    },
  }],
}
