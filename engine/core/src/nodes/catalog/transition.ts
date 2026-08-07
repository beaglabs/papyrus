import type { NodeTypeSpec } from '../types.js'

/**
 * Transition nodes — the *exit* of the canvas. Each carries downloadable
 * deployment/acquisition artifacts. In a classified profile these are the
 * documents that would transit a Cross Domain Solution (CDS).
 */
const FIELDS = [
  { key: 'manifest', label: 'Manifest', type: 'blob' },
  { key: 'version', label: 'Version', type: 'text' },
] as const

const TRANSITION_TYPES: Array<{ type: string; title: string; icon: string; description: string }> =
  [
    {
      type: 'acquisition-package',
      title: 'Acquisition Package',
      icon: 'briefcase',
      description: 'Full acquisition package.',
    },
    {
      type: 'transition-plan',
      title: 'Transition Plan',
      icon: 'route',
      description: 'Plan for transitioning to operations.',
    },
    {
      type: 'ip-record',
      title: 'IP Record',
      icon: 'copyright',
      description: 'Intellectual property record.',
    },
    {
      type: 'deployment-package',
      title: 'Deployment Package',
      icon: 'box-seal',
      description: 'Shippable deployment package.',
    },
    { type: 'training', title: 'Training', icon: 'graduation', description: 'Training materials.' },
    { type: 'sop', title: 'SOP', icon: 'clipboard', description: 'Standard Operating Procedure.' },
    {
      type: 'sustainment-plan',
      title: 'Sustainment Plan',
      icon: 'infinity',
      description: 'Long-term sustainment plan.',
    },
    {
      type: 'knowledge-transfer',
      title: 'Knowledge Transfer',
      icon: 'swap',
      description: 'Knowledge-transfer plan.',
    },
  ]

export const TRANSITION_NODES: NodeTypeSpec[] = TRANSITION_TYPES.map((t) => ({
  type: t.type,
  category: 'transition' as const,
  flowRole: 'exit' as const,
  icon: t.icon,
  title: t.title,
  description: t.description,
  fields: [...FIELDS],
}))
