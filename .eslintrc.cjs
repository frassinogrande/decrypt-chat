/** @type {import('eslint').Linter.Config} */
module.exports = {
    root: true,
    extends: ['eslint:recommended', 'plugin:svelte/recommended', 'prettier'],
    parser: '@typescript-eslint/parser',
    plugins: ['@typescript-eslint'],
    parserOptions: {
        sourceType: 'module',
        ecmaVersion: 2020,
        extraFileExtensions: ['.svelte'],
    },
    env: {
        browser: true,
        es2017: true,
        node: true,
    },
    rules: {
        // Security rules
        'no-console': 'error',

        'no-restricted-syntax': [
            'error',
            {
                selector: "CallExpression[callee.property.name='exportKey']",
                message:
                    'crypto.subtle.exportKey() is forbidden for security. Use non-extractable keys.',
            },
            {
                selector: "CallExpression[callee.name='exportKey']",
                message: 'exportKey() is forbidden for security. Use non-extractable keys.',
            },
            {
                selector: "AssignmentExpression[left.property.name='innerHTML']",
                message:
                    'innerHTML assignment is forbidden for security. Use safe DOM manipulation.',
            },
            {
                selector: "CallExpression[callee.name='eval']",
                message: 'eval() is forbidden for security reasons.',
            },
            {
                selector:
                    "CallExpression[callee.property.name='importKey'][arguments.3.value=true]",
                message:
                    'importKey() with extractable: true allows raw key bytes to be exported. Use false unless the key must be explicitly wrapped — add an eslint-disable comment with justification.',
            },
        ],

        'no-restricted-globals': [
            'error',
            {
                name: 'eval',
                message: 'eval() is forbidden for security reasons.',
            },
        ],

        'no-var': 'error',
        'prefer-const': 'error',
        'no-unused-vars': 'off', // Use TypeScript version instead

        'no-undef': 'off', // TypeScript handles this
    },

    overrides: [
        {
            files: ['*.svelte'],
            parser: 'svelte-eslint-parser',
            parserOptions: {
                parser: '@typescript-eslint/parser',
            },
        },
        {
            // Allow console in the debug utility and server-side error handler
            // (server logging must not be stripped; the debug util is the impl)
            files: ['src/lib/utils/debug.ts', 'src/hooks.server.ts'],
            rules: {
                'no-console': 'off',
            },
        },
        {
            files: [
                '*.config.js',
                '*.config.ts',
                'vite.config.ts',
                '**/*.test.ts',
                '**/*.spec.ts',
                'debug-*.js',
            ],
            rules: {
                'no-console': 'off',
            },
        },
        {
            // Allow exportKey in specific secure locations
            files: ['src/lib/utils/secure-key-manager.ts'],
            rules: {
                'no-restricted-syntax': [
                    'error',
                    {
                        selector: "AssignmentExpression[left.property.name='innerHTML']",
                        message:
                            'innerHTML assignment is forbidden for security. Use safe DOM manipulation.',
                    },
                    {
                        selector: "CallExpression[callee.name='eval']",
                        message: 'eval() is forbidden for security reasons.',
                    },
                ],
            },
        },
    ],

    globals: {
        __SECURE_BUILD__: 'readonly',
        __DEV__: 'readonly',
    },
};
