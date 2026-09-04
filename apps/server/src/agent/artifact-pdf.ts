function stripMarkdown(value: string): string {
  return value.replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?|```$/g, '')).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_~`>#]/g, '').replace(/\r/g, '')
}

export function createPdf(title: string, markdown: string): Buffer {
  const source = [title, '', ...stripMarkdown(markdown).split('\n')].join('\n')
  const lines: string[] = []
  for (const raw of source.split('\n')) {
    const words = raw.trim().split(/\s+/).filter(Boolean)
    if (!words.length) { lines.push(''); continue }
    let line = ''
    for (const word of words) {
      if ((line + ' ' + word).trim().length > 92) { lines.push(line); line = word }
      else line = line ? `${line} ${word}` : word
    }
    if (line) lines.push(line)
  }
  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += 48) pages.push(lines.slice(i, i + 48))
  if (!pages.length) pages.push([''])

  const objects: string[] = []
  const add = (value: string) => { objects.push(value); return objects.length }
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pageIds: number[] = []
  const contentIds: number[] = []
  const pagesId = 2
  for (const page of pages) {
    const body = page.map((line, index) => {
      const escaped = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
      return `BT /F1 ${index === 0 ? 18 : 10} Tf 54 ${738 - index * 14} Td (${escaped}) Tj ET`
    }).join('\n')
    const contentId = add(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`)
    contentIds.push(contentId)
    const pageId = add('PENDING_PAGE')
    pageIds.push(pageId)
  }
  const pagesObject = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id + 1} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  objects.splice(1, 0, pagesObject)
  for (let i = 0; i < pageIds.length; i++) {
    const shiftedPageId = pageIds[i]! + 1
    const shiftedContentId = contentIds[i]! + 1
    objects[shiftedPageId - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${shiftedContentId} 0 R >>`
  }
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(output))
    output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) output += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(output, 'binary')
}

