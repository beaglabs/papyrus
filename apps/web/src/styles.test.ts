import { describe, expect, it } from 'vitest'
import styles from './styles.css?raw'

/**
 * Every component source under src/, so a nested one cannot escape the checks below.
 * Resolved through Vite rather than node:fs: the web tsconfig carries no node types, and
 * `?raw` is the same mechanism this file already uses to read the stylesheet.
 */
const componentSources = Object.entries(
  import.meta.glob('./**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
).map(([path, source]) => [path.replace(/^\.\//, ''), source] as const)

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
  it('keeps History as a neutral cascade instead of a highlighted navigation block', () => {
    expect(styles).toMatch(/\.session-row\s*\{[^}]*margin-left:\s*calc\(var\(--history-depth\) \* 3px\);/s)
    expect(styles).toMatch(/\.session-row \.nb-sidebar-menu-button\[data-active="true"\]\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s)
    expect(styles).toContain('.session-row[data-history-depth="6"] { --history-depth: 6; }')
    expect(styles).not.toMatch(/\.session-row \.nb-sidebar-menu-button\[data-active="true"\][^{]*\{[^}]*background:\s*var\(--main\)/s)
  })
})

/**
 * The contract above reads only styles.css, so a component that paints itself from a
 * hardcoded palette is invisible to it. The first-run onboarding shipped exactly that: a
 * GitHub-Dark theme (`#0d1117`, `#58a6ff`, `#21262d`) in an inline <style> block, while
 * the rest of the product is a light neobrutalist surface built from the tokens. Nothing
 * failed; it simply looked like a different application, on the first screen an operator
 * ever sees. These checks close that gap: colour belongs in the stylesheet, where the
 * contract can see it.
 */
describe('Components stay inside the design system', () => {
  const sources = componentSources

  it('finds component sources to check', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it('hardcodes no colour literals, so every colour resolves from a stylesheet token', () => {
    for (const [path, source] of sources) {
      const hits = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
      expect(hits, `${path} hardcodes ${hits.join(', ')}`).toEqual([])
    }
  })

  it('hardcodes no rgb()/hsl() literals', () => {
    for (const [path, source] of sources) {
      const hits = source.match(/\b(?:rgba?|hsla?)\(/g) ?? []
      expect(hits, `${path} hardcodes ${hits.join(', ')}`).toEqual([])
    }
  })

  it('carries no inline <style> block, which the stylesheet contract cannot see', () => {
    for (const [path, source] of sources) {
      expect(source, `${path} has an inline <style> block`).not.toContain('<style>')
    }
  })
})
