import { zip } from './artifact-zip.js'

export interface ArtifactSheetInput { name?: string; rows: Array<Array<string | number | boolean | null>> }
function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&apos;') }

export function createXlsx(inputSheets: ArtifactSheetInput[]): Buffer {
  const sheets = inputSheets.slice(0, 32).map((sheet, index) => ({
    name: safeSheetName(sheet.name ?? `Sheet${index + 1}`),
    rows: sheet.rows.slice(0, 10_000).map((row) => row.slice(0, 100)),
  }))
  const workbookSheets = sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
  const rels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
  const overrides = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
  const entries: Array<[string, Buffer]> = [
    ['[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`) ],
    ['_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) ],
    ['xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`) ],
    ['xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) ],
    ['xl/styles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`) ],
  ]
  sheets.forEach((sheet, sheetIndex) => {
    const rows = sheet.rows.map((row, rowIndex) => {
      const cells = row.map((value, colIndex) => cellXml(value, rowIndex + 1, colIndex + 1, rowIndex === 0)).join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    }).join('')
    entries.push([`xl/worksheets/sheet${sheetIndex + 1}.xml`, Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`)])
  })
  return zip(entries)
}

function cellXml(value: string | number | boolean | null, row: number, column: number, header: boolean): string {
  const reference = `${columnName(column)}${row}`
  const style = header ? ' s="1"' : ''
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"${style}><v>${value}</v></c>`
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"${style}><v>${value ? 1 : 0}</v></c>`
  return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(value == null ? '' : String(value))}</t></is></c>`
}

function columnName(value: number): string {
  let current = value
  let result = ''
  while (current > 0) { current--; result = String.fromCharCode(65 + (current % 26)) + result; current = Math.floor(current / 26) }
  return result
}

function safeSheetName(value: string): string {
  return value.replace(/[\\/*?:\[\]]/g, '-').slice(0, 31) || 'Sheet'
}

