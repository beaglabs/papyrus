/**
 * PersonaCard — neobrutalist agent persona node on the canvas.
 * Shows the persona icon, name, role, and color accent.
 */
import { Handle, type NodeProps, Position } from '@xyflow/react'

interface PersonaData {
  id: string
  name: string
  role: string
  color: string
  icon: string
  description: string
}

export function PersonaCard({ data }: NodeProps) {
  const p = data as unknown as PersonaData
  return (
    <div
      style={{
        background: '#141414',
        border: `2px solid ${p.color}`,
        borderRadius: 10,
        padding: '14px 18px',
        minWidth: 200,
        boxShadow: `0 4px 16px rgba(0,0,0,0.4), 0 0 20px ${p.color}22`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: `${p.color}22`,
            display: 'grid',
            placeItems: 'center',
            fontSize: 18,
            flexShrink: 0,
          }}
        >
          {p.icon}
        </span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#e5e5e5' }}>{p.name}</div>
          <div
            style={{
              fontSize: 10,
              fontFamily: '"JetBrains Mono", monospace',
              color: p.color,
              letterSpacing: '0.08em',
            }}
          >
            {p.role}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: '#888', lineHeight: 1.4 }}>{p.description}</div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          width: 8,
          height: 8,
          background: p.color,
          border: '2px solid #0a0a0a',
        }}
      />
    </div>
  )
}
