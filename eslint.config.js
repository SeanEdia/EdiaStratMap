import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        alert: 'readonly',
        FileReader: 'readonly',
        ClipboardItem: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        HTMLElement: 'readonly',
        Event: 'readonly',
        prompt: 'readonly',
        requestAnimationFrame: 'readonly',
        DOMParser: 'readonly',
        MutationObserver: 'readonly',
        // Libraries loaded via CDN
        L: 'readonly',
        XLSX: 'readonly',
      },
    },
    rules: {
      // Relaxed rules suitable for this project
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'prefer-const': 'warn',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.bak'],
  },
];
