import type { NodeTypeSpec } from '../types.js'

/** Validation nodes — prove the solution. `Approval` is a review gate. */
export const VALIDATION_NODES: NodeTypeSpec[] = [
  {
    type: 'prototype',
    category: 'validation',
    flowRole: 'artifact',
    icon: 'puzzle',
    title: 'Prototype',
    description: 'A prototype artifact.',
    fields: [
      { key: 'artifact', label: 'Artifact', type: 'blob' },
      { key: 'notes', label: 'Notes', type: 'markdown' },
    ],
  },
  {
    type: 'pilot',
    category: 'validation',
    flowRole: 'artifact',
    icon: 'plane',
    title: 'Pilot',
    description: 'A pilot deployment and its outcomes.',
    fields: [{ key: 'notes', label: 'Notes', type: 'markdown' }],
  },
  {
    type: 'demo',
    category: 'validation',
    flowRole: 'artifact',
    icon: 'play',
    title: 'Demo',
    description: 'A demonstration artifact.',
    fields: [
      { key: 'artifact', label: 'Artifact', type: 'blob' },
      { key: 'notes', label: 'Notes', type: 'markdown' },
    ],
  },
  {
    type: 'user-test',
    category: 'validation',
    flowRole: 'artifact',
    icon: 'users',
    title: 'User Test',
    description: 'A user-acceptance test and results.',
    fields: [
      { key: 'design', label: 'Design', type: 'markdown' },
      { key: 'results', label: 'Results', type: 'blob' },
    ],
  },
  {
    type: 'ab-test',
    category: 'validation',
    flowRole: 'artifact',
    icon: 'split',
    title: 'A/B Test',
    description: 'An A/B/n test and its results.',
    fields: [
      { key: 'design', label: 'Design', type: 'markdown' },
      { key: 'results', label: 'Results', type: 'blob' },
    ],
  },
  {
    type: 'validation-report',
    category: 'validation',
    flowRole: 'artifact',
    icon: 'document',
    title: 'Validation Report',
    description: 'Report synthesizing validation findings.',
    fields: [{ key: 'findings', label: 'Findings', type: 'markdown', required: true }],
  },
  {
    type: 'lessons-learned',
    category: 'validation',
    flowRole: 'artifact',
    icon: 'book',
    title: 'Lessons Learned',
    description: 'Captured lessons learned from validation.',
    fields: [{ key: 'findings', label: 'Findings', type: 'markdown', required: true }],
  },
  {
    type: 'approval',
    category: 'validation',
    flowRole: 'review',
    icon: 'stamp',
    title: 'Approval',
    description: 'A stakeholder or authority approval gate (signs the package off).',
    reviewable: true,
    fields: [
      { key: 'approver', label: 'Approver', type: 'ref', refType: 'stakeholder', required: true },
      {
        key: 'decision',
        label: 'Decision',
        type: 'select',
        options: ['pending', 'approved', 'rejected'],
      },
      { key: 'signature', label: 'Signature', type: 'blob' },
    ],
  },
]
