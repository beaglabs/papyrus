import { isUIResource } from '@mcp-ui/client'
import type { ReactNode } from 'react'

// Renders an MCP-UI resource embedded inside an ACP session event block.
// Detects UI resources via the package's metadata conventions and surfaces
// them as a sandboxed iframe using the resource URI. Non-UI resources fall
// through to `null` so the caller can render the existing card.
export function McpUiResource({ resource }: { resource: Record<string, unknown> }): ReactNode {
  if (!isUIResource(resource as unknown as { type: string; resource?: { uri?: string } })) return null
  const narrowed = resource as unknown as { resource?: { uri?: string } }
  const uri = narrowed.resource?.uri
  if (typeof uri !== 'string') return null
  return (
    <div className="mcp-ui-frame">
      <iframe
        title={uri}
        src={uri}
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </div>
  )
}