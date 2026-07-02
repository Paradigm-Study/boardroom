import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

// Minimal flat config: typescript-eslint's (non-type-checked) recommended set
// across the TypeScript sources, with no-unused-vars promoted to an error since
// tsconfig does not set noUnusedLocals — so dead code is caught here instead. The
// two canonical react-hooks rules apply to the web client.
const noUnusedVars = ['error', {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrors: 'none',
  ignoreRestSiblings: true,
}]

export default tseslint.config(
  // .claude/ holds session artifacts, including whole worktree copies of this repo —
  // linting those doubles every finding and breaks the parser's project resolution.
  { ignores: ['**/dist/**', '**/node_modules/**', 'eslint.config.js', '.claude/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: { '@typescript-eslint/no-unused-vars': noUnusedVars },
  },
  {
    // The menubar shell (Electron main + the icon-build script) is plain JS, so
    // the TS unused-vars rule above never reaches it. Apply the base rule here so
    // dead code is caught there too. no-undef stays off: these run on Node/Electron
    // with ambient globals (require, __dirname, fetch, AbortSignal, …).
    files: ['**/*.{js,mjs}'],
    rules: { 'no-unused-vars': noUnusedVars },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
)
