import { describe, expect, it } from 'vitest'
import { createTextPdf, normalizePdfFilename } from '../src/pdf.js'

describe('deterministic PDF renderer', () => {
  it('creates a valid xref table whose object offsets point at object headers', () => {
    const pdf = createTextPdf({
      title: 'Papyrus PDF',
      body: 'A deterministic PDF generated without shell access.\n\nSecond paragraph.',
    })
    const text = pdf.toString('ascii')
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text.endsWith('%%EOF\n')).toBe(true)
    expect(text).toContain('(Papyrus PDF) Tj')

    const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF/)?.[1])
    expect(Number.isFinite(startxref)).toBe(true)
    expect(text.slice(startxref, startxref + 4)).toBe('xref')

    const xref = text.slice(startxref).split('\n')
    const [, range, free, ...entries] = xref
    expect(range).toMatch(/^0 \d+$/)
    expect(free).toBe('0000000000 65535 f ')
    const count = Number(range?.split(' ')[1])
    for (let id = 1; id < count; id += 1) {
      const offset = Number(entries[id - 1]?.slice(0, 10))
      expect(text.slice(offset, offset + String(id).length + 6)).toBe(`${id} 0 obj`)
    }
  })

  it('paginates long content and sanitizes filenames', () => {
    const pdf = createTextPdf({ title: 'Long', body: Array.from({ length: 120 }, (_, i) => `Line ${i + 1} content`).join('\n') })
    const text = pdf.toString('ascii')
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1)
    expect(normalizePdfFilename('../../Quarterly report')).toBe('Quarterly_report.pdf')
    expect(normalizePdfFilename('safe.pdf')).toBe('safe.pdf')
  })
})
