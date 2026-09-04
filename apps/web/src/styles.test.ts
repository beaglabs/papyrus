import { describe, expect, it } from 'vitest'
import styles from './styles.css?raw'

describe('Agent chat style contract', () => {
  it('keeps the chat surface, message renderer, and composer layout rules together', () => {
    for (const selector of [
      '.agent-main {',
      '.agent-surface {',
      '.message-list {',
      '.chat-message {',
      '.message-body {',
      '.message-markdown {',
      '.message-code {',
      '.message-table-wrap {',
      '.agent-thinking {',
      '.composer-input-row {',
      '.composer-toolbar {',
      '.composer-attachments {',
      '.library-picker {',
      '.library-results {',
    ]) {
      expect(styles, `missing ${selector}`).toContain(selector)
    }
  })

  it('pins the composer as the final grid row without letting it escape the viewport', () => {
    expect(styles).toMatch(/\.agent-main\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s)
    expect(styles).toMatch(/\.agent-surface\s*\{[^}]*min-height:\s*0;[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto;/s)
    expect(styles).toMatch(/\.composer\s*\{[^}]*position:\s*relative;[^}]*padding:[^;]*safe-area-inset-bottom/s)
    expect(styles).not.toMatch(/\.composer\s*\{[^}]*position:\s*sticky/s)
    expect(styles).toMatch(/\.message-list\s*\{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s)
    expect(styles).not.toContain('.message-list { overflow: visible; }')
  })

})
