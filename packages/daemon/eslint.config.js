import tseslint from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier';

export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/', 'node_modules/'],
  },
  ...tseslint.configs.recommended,
  {
    plugins: { prettier },
    rules: {
      'prettier/prettier': 'error',

      // Security: no dynamic code execution
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',

      // Code quality
      'no-console': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],

      // Allow empty functions (useful for noop implementations)
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    // CLI commands are user-facing terminal output by design.
    files: ['src/index.ts', 'src/cli/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Tests may intentionally use `any` for fixture flexibility.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
