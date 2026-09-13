/**
 * Vendored from papyrus-viewer-3d (packages/viewer-3d: src/index.ts + src/ui.tsx).
 *
 * Bridges the out-of-core viewer_3d UI provider into the hardened core until the
 * papyrus-extension-sdk / papyrus-viewer-3d packs are consumed as workspace
 * dependencies (which needs a pnpm-lock.yaml regeneration). Kept faithful to the
 * packs so the future swap to package imports is a mechanical delete. The scene is
 * read-only, deterministic input; nothing here reaches outside the browser.
 */
import type { CSSProperties, FC } from 'react'
import type { ExtensionUiProvider } from './extension-sdk.js'

export const VIEWER3D_KIND = 'viewer_3d' as const
export type Viewer3DKind = typeof VIEWER3D_KIND

export interface Viewer3DVector {
  x: number
  y: number
  z: number
}

export type Viewer3DObject =
  | { type: 'points'; id: string; label?: string; color?: string; points: Viewer3DVector[] }
  | { type: 'path'; id: string; label?: string; color?: string; points: Viewer3DVector[] }
  | { type: 'sphere'; id: string; label?: string; color?: string; center: Viewer3DVector; radiusKm: number }

export interface Viewer3DScene {
  units: 'km' | 'm' | 'normalized'
  frame?: string
  objects: Viewer3DObject[]
  camera?: { target?: Viewer3DVector; distanceKm?: number }
}

export interface Viewer3DView {
  kind: Viewer3DKind
  renderer: string
  title: string
  scene: Viewer3DScene
  source?: { extension?: string; tool?: string }
}

const shell: CSSProperties = {
  border: '1px solid hsl(var(--border))',
  borderRadius: 10,
  padding: 12,
  margin: '8px 0',
  background: 'hsl(var(--card))',
  color: 'hsl(var(--card-foreground))',
}
const eyebrow: CSSProperties = {
  fontSize: 11,
  letterSpacing: '0.08em',
  color: 'hsl(var(--muted-foreground))',
}
const note: CSSProperties = { marginTop: 8, fontSize: 12, color: 'hsl(var(--muted-foreground))' }

const Viewer3DCard: FC<{ output: Viewer3DView }> = ({ output }) => {
  const objects = output.scene?.objects ?? []
  const counts = objects.reduce<Record<string, number>>((acc, o) => {
    acc[o.type] = (acc[o.type] ?? 0) + 1
    return acc
  }, {})
  const summary = Object.entries(counts).map(([type, n]) => `${n} ${type}`).join(' · ') || 'empty scene'
  return (
    <div style={shell}>
      <div style={eyebrow}>3D VIEWER · {output.renderer}</div>
      <h3 style={{ margin: '4px 0 8px' }}>{output.title}</h3>
      <p style={{ margin: 0, fontSize: 13 }}>
        Scene: {summary}
        {output.scene?.frame ? ` · frame ${output.scene.frame}` : ''} · units {output.scene?.units ?? 'unknown'}.
      </p>
      <p style={note}>
        Interactive rendering is provided by the shared, supply-chain-reviewed 3D engine (added in a
        follow-up). Until then this card summarizes the deterministic scene the pack produced.
      </p>
    </div>
  )
}

export const viewer3dUiProvider: ExtensionUiProvider<FC<{ output: Viewer3DView }>> = {
  name: 'papyrus-viewer-3d',
  version: '0.1.0',
  cards: [{ kind: 'viewer_3d', component: Viewer3DCard }],
}
