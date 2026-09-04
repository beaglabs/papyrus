import { Fragment, type ReactNode } from 'react'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

interface MarkdownNode {
  type: string
  value?: string
  url?: string
  depth?: number
  ordered?: boolean
  start?: number | null
  checked?: boolean | null
  lang?: string | null
  children?: MarkdownNode[]
}

const parser = unified().use(remarkParse).use(remarkGfm)

export function MarkdownMessage({ children }: { children: string }) {
  const tree = parser.parse(children) as unknown as MarkdownNode
  return <div className="message-markdown">{renderChildren(tree.children ?? [], 'root')}</div>
}

function renderChildren(nodes: MarkdownNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => (
    <Fragment key={`${keyPrefix}-${index}-${node.type}`}>
      {renderNode(node, `${keyPrefix}-${index}`)}
    </Fragment>
  ))
}

function renderNode(node: MarkdownNode, key: string): ReactNode {
  const children = renderChildren(node.children ?? [], key)

  switch (node.type) {
    case 'root':
      return children
    case 'text':
      return node.value ?? ''
    case 'paragraph':
      return <p className={isTaskIdParagraph(node) ? 'task-id-line' : undefined}>{children}</p>
    case 'strong':
      return <strong>{children}</strong>
    case 'emphasis':
      return <em>{children}</em>
    case 'delete':
      return <del>{children}</del>
    case 'inlineCode':
      return <code className="inline-code">{node.value ?? ''}</code>
    case 'code':
      return <pre className="message-code"><code>{node.value ?? ''}</code></pre>
    case 'heading': {
      const depth = Math.min(Math.max(node.depth ?? 3, 1), 6)
      if (depth === 1) return <h1>{children}</h1>
      if (depth === 2) return <h2>{children}</h2>
      if (depth === 3) return <h3>{children}</h3>
      if (depth === 4) return <h4>{children}</h4>
      if (depth === 5) return <h5>{children}</h5>
      return <h6>{children}</h6>
    }
    case 'blockquote':
      return <blockquote>{children}</blockquote>
    case 'thematicBreak':
      return <hr />
    case 'break':
      return <br />
    case 'list':
      return node.ordered
        ? <ol start={node.start ?? undefined}>{children}</ol>
        : <ul>{children}</ul>
    case 'listItem':
      return <li className={node.checked === true ? 'task-checked' : node.checked === false ? 'task-open' : undefined}>{children}</li>
    case 'link': {
      const href = safeHref(node.url)
      return href
        ? <a href={href} target={href.startsWith('http') ? '_blank' : undefined} rel={href.startsWith('http') ? 'noreferrer' : undefined}>{children}</a>
        : <span>{children}</span>
    }
    case 'table':
      return <MarkdownTable node={node} keyPrefix={key} />
    case 'tableRow':
      return <tr>{children}</tr>
    case 'tableCell':
      return <td>{children}</td>
    case 'html':
      return /^<br\s*\/?\s*>$/i.test(node.value ?? '') ? <br /> : (node.value ?? '')
    default:
      return children.length ? children : (node.value ?? null)
  }
}

function MarkdownTable({ node, keyPrefix }: { node: MarkdownNode; keyPrefix: string }) {
  const rows = node.children ?? []
  const [head, ...body] = rows
  return <div className="message-table-wrap">
    <table>
      {head && <thead><tr>{(head.children ?? []).map((cell, index) => <th key={`${keyPrefix}-head-${index}`}>{renderChildren(cell.children ?? [], `${keyPrefix}-head-${index}`)}</th>)}</tr></thead>}
      {body.length > 0 && <tbody>{body.map((row, rowIndex) => <tr key={`${keyPrefix}-row-${rowIndex}`}>{(row.children ?? []).map((cell, cellIndex) => <td key={`${keyPrefix}-cell-${rowIndex}-${cellIndex}`}>{renderChildren(cell.children ?? [], `${keyPrefix}-cell-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>}
    </table>
  </div>
}

function isTaskIdParagraph(node: MarkdownNode): boolean {
  const text = flattenText(node).trim()
  return /^Task ID:\s*[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
}

function flattenText(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? ''
  return (node.children ?? []).map(flattenText).join('')
}

function safeHref(value: string | undefined): string | undefined {
  const href = value?.trim()
  if (!href) return undefined
  if (href.startsWith('/') || href.startsWith('#')) return href
  if (/^(https?:|mailto:)/i.test(href)) return href
  return undefined
}
