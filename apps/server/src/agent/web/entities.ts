/**
 * HTML and XML character reference decoding.
 *
 * Shared by every read path that turns a response body into text, because a page
 * that says `&amp;lt;` and a page that says `<` must not reach the model looking
 * identical. Only the entities an appliance console actually emits are named; the
 * numeric forms cover the rest, and anything unrecognizable is left exactly as
 * written rather than dropped, so a decoder failure can never silently delete an
 * operator-visible value.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '«', raquo: '»', deg: '°', plusmn: '±', middot: '·', bull: '•',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö',
  auml: 'ä', szlig: 'ß', half: '½', times: '×', divide: '÷', ne: '≠', le: '≤', ge: '≥',
}

const ENTITY = /&(#[xX]?[0-9a-fA-F]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,10});/g

export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(ENTITY, (whole, entity: string) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1] === 'x' || entity[1] === 'X'
      const code = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ff_ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        // Lone surrogates are not representable; keep the source text.
        return whole
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole
  })
}
