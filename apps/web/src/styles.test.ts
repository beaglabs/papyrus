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

  it('pins the composer as a full-width viewport layer independent of transcript height', () => {
    expect(styles).toMatch(/\.agent-main\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s)
    expect(styles).toMatch(/\.agent-surface\s*\{[^}]*position:\s*relative;[^}]*align-self:\s*stretch;[^}]*min-height:\s*0;[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\);/s)
    expect(styles).not.toMatch(/\.agent-surface\s*\{[^}]*height:\s*100%;/s)
    expect(styles).toMatch(/\.composer-layer\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*80;[^}]*left:\s*0;[^}]*right:\s*0;[^}]*bottom:\s*0;[^}]*width:\s*100%;/s)
    expect(styles).toMatch(/\.composer\s*\{[^}]*z-index:\s*81;[^}]*width:\s*100%;[^}]*pointer-events:\s*auto;/s)
    expect(styles).toMatch(/\.composer-tools\s*\{[^}]*width:\s*100%;[^}]*overflow:\s*hidden;/s)
    expect(styles).toMatch(/\.composer-workspace-state\s*\{[^}]*flex:\s*1 1 auto;[^}]*text-overflow:\s*ellipsis;/s)
    expect(styles).toMatch(/\.message-list\s*\{[^}]*z-index:\s*1;[^}]*grid-row:\s*3;[^}]*overflow-y:\s*auto;[^}]*padding:[^;]*--composer-clearance/s)
    expect(styles).not.toContain('.message-list { overflow: visible; }')
  })

  it('keeps Links previews inside the Papyrus design system without imposing a borrowed theme', () => {
    expect(styles).toMatch(/\.links-view\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--foreground\);/s)
    expect(styles).toMatch(/\.link-preview\s*\{[^}]*border:\s*2px solid var\(--border\);[^}]*box-shadow:\s*var\(--shadow\);/s)
    expect(styles).toMatch(/\.link-preview iframe[^}]*background:\s*var\(--surface\);/s)
    expect(styles).not.toContain('#15111d')
    expect(styles).not.toContain('#003f2e')
    expect(styles).not.toContain('#c6a7ff')
  })
})
