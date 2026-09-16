import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:3210' } },
  build: { sourcemap: true },
  // Vitest stubs CSS by default, so `import styles from './styles.css?raw'`
  // resolved to an empty string and the style-contract tests compared '' against
  // real selectors. Processing CSS returns the raw text those tests assert on.
  test: { css: true },
})
