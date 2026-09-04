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
      return <p>{children}</p>
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
      return <div className="message-table-wrap"><table>{children}</table></div>
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

function safeHref(value: string | undefined): string | undefined {
  const href = value?.trim()
  if (!href) return undefined
  if (href.startsWith('/') || href.startsWith('#')) return href
  if (/^(https?:|mailto:)/i.test(href)) return href
  return undefined
}
