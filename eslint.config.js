import path from 'path';
import { fileURLToPath } from 'url';

import qunitRecommended from 'eslint-plugin-qunit/configs/recommended';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname
});

export default [
  ...compat.extends('eslint-config-semistandard'),
  {
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', vars: 'all' }],
      'comma-dangle': 'off',
      'multiline-ternary': 'off',
      'no-throw-literal': 'off',
      'object-shorthand': 'off',
      'operator-linebreak': ['error', 'before'],
    }
  },
  {
    files: ['test/*.js'],
    languageOptions: {
      globals: {
        QUnit: 'readonly'
      }
    },
    ...qunitRecommended,
    rules: {
      'object-property-newline': 'off',
    }
  },
  {
    files: ['src/client.cjs'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'commonjs'
    },
    rules: {
      'no-var': 'off',
    }
  }
];
