import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type SkillTrust = 'papyrus_builtin' | 'organization_approved' | 'workspace_draft'
export type SkillState = 'enabled' | 'draft' | 'disabled'

export interface SkillRecord {
  kind: 'skill'
  id: string
  name: string
  version: string
  description: string
  instructions: string
  requestedCapabilities: string[]
  trust: SkillTrust
  state: SkillState
  createdByOid: string
  createdAt: string
  updatedAt: string
}

export interface SkillSummary {
  id: string
  name: string
  version: string
  description: string
  requestedCapabilities: string[]
  trust: SkillTrust
  state: SkillState
}

const BUILT_INS: SkillRecord[] = [
  builtin('pdf', '1.0.0', 'Create polished PDF artifacts or publish a PDF produced in the sandbox.', [
    'Use createArtifact with format=pdf for ordinary reports, briefs, memos, and text-forward PDFs.',
    'Structure content clearly with headings and concise paragraphs before creating the artifact.',
    'For advanced PDF composition that needs external tooling, work only inside the sandbox and call publishArtifact after the file exists.',
    'Returning a PDF is a workspace capability, not an operational action. Never call listActionExecutors just to create a PDF.',
  ], ['createArtifact', 'publishArtifact']),
  builtin('docx', '1.0.0', 'Create Word-compatible DOCX artifacts and publish richer DOCX files produced in the sandbox.', [
    'Use createArtifact with format=docx for normal reports, memos, letters, and document deliverables.',
    'Use semantic Markdown-style headings in content; the artifact runtime maps them into Word heading styles.',
    'For advanced templates, tables, tracked changes, or layout work, create the file in the sandbox and use publishArtifact.',
    'Document generation does not require action approval unless the user asks to send or publish the document to an external system.',
  ], ['createArtifact', 'publishArtifact']),
  builtin('xlsx', '1.0.0', 'Create spreadsheet artifacts with one or more typed sheets and inline workbook preview.', [
    'Use createArtifact with format=xlsx and provide sheets as arrays of rows.',
    'Put column labels in the first row. Preserve numbers and booleans as typed values instead of converting everything to strings.',
    'Keep the workbook understandable: concise sheet names, explicit units, clear column headings, and no hidden assumptions.',
    'For formulas, charts, macros, or complex workbook editing, work inside the sandbox with approved local tooling and publish the result with publishArtifact.',
  ], ['createArtifact', 'publishArtifact']),
  builtin('remotion', '1.0.0', 'Create video or animation artifacts with Remotion when the customer runtime has the required local toolchain.', [
    'Use this only when the user asks for a rendered video, animation, or Remotion composition.',
    'Build and render exclusively inside the sandbox workspace. Network access stays denied unless deployment policy explicitly provides an approved source.',
    'After rendering MP4 or WebM, call publishArtifact with the output path so Agent Chat receives a typed inline video artifact.',
    'If Remotion is not installed in the customer runtime, explain the missing local dependency instead of downloading packages implicitly.',
  ], ['workspace', 'publishArtifact']),
  builtin('skill-creator', '1.0.0', 'Draft reusable Papyrus skills from a workflow or procedure without granting the draft any new authority.', [
    'Capture when the skill should trigger, what procedure it teaches, its expected outputs, and the minimum capabilities it needs.',
    'Call draftSkill to persist the proposed skill. A draft is inert and cannot grant tools, network access, or external authority.',
    'Requested capabilities are requests only. Papyrus intersects them with deployment policy and the tools already available to the agent.',
    'An Entra-authorized Papyrus.System.Owner must approve and enable the draft before it becomes loadable in normal sessions.',
  ], ['draftSkill']),
]

export class SkillRegistry {
  private readonly root: string

  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'skills')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  list(): SkillSummary[] {
    return [...BUILT_INS, ...this.custom()].map(summary)
  }

  load(name: string): SkillRecord {
    const skill = [...BUILT_INS, ...this.custom()].find((candidate) => candidate.name === name)
    if (!skill || skill.state !== 'enabled') throw new Error(`Skill ${name} is not enabled`)
    return skill
  }

  draft(input: { name: string; description: string; instructions: string; requestedCapabilities?: string[] }, actorOid = 'agent'): SkillRecord {
    const name = input.name.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) throw new Error('Skill name must use lowercase letters, numbers, and hyphens')
    if (BUILT_INS.some((skill) => skill.name === name)) throw new Error('Built-in skill names cannot be replaced')
    const existing = this.custom().find((skill) => skill.name === name && skill.state !== 'disabled')
    if (existing) throw new Error(`Skill ${name} already exists`)
    const now = new Date().toISOString()
    const record: SkillRecord = {
      kind: 'skill',
      id: randomUUID(),
      name,
      version: '0.1.0',
      description: input.description.trim().slice(0, 1200),
      instructions: input.instructions.trim().slice(0, 30_000),
      requestedCapabilities: [...new Set((input.requestedCapabilities ?? []).filter(validCapability))].slice(0, 32),
      trust: 'workspace_draft',
      state: 'draft',
      createdByOid: actorOid,
      createdAt: now,
      updatedAt: now,
    }
    this.write(record)
    return record
  }

  approveAndEnable(id: string, actorOid: string): SkillRecord {
    const record = this.custom().find((skill) => skill.id === id)
    if (!record) throw new Error('Skill draft not found')
    if (record.state !== 'draft') throw new Error('Only draft skills can be approved')
    const approved: SkillRecord = {
      ...record,
      trust: 'organization_approved',
      state: 'enabled',
      updatedAt: new Date().toISOString(),
      createdByOid: record.createdByOid || actorOid,
    }
    this.write(approved)
    return approved
  }

  private custom(): SkillRecord[] {
    const index = join(this.root, 'index.json')
    if (!existsSync(index)) return []
    try {
      const parsed = JSON.parse(readFileSync(index, 'utf8')) as SkillRecord[]
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }

  private write(record: SkillRecord): void {
    const skills = this.custom().filter((skill) => skill.id !== record.id)
    skills.push(record)
    writeFileSync(join(this.root, 'index.json'), JSON.stringify(skills, null, 2), { mode: 0o600 })
  }
}

function builtin(name: string, version: string, description: string, instructions: string[], requestedCapabilities: string[]): SkillRecord {
  return {
    kind: 'skill',
    id: `builtin:${name}`,
    name,
    version,
    description,
    instructions: instructions.join('\n'),
    requestedCapabilities,
    trust: 'papyrus_builtin',
    state: 'enabled',
    createdByOid: 'papyrus',
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
  }
}

function summary(skill: SkillRecord): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    description: skill.description,
    requestedCapabilities: skill.requestedCapabilities,
    trust: skill.trust,
    state: skill.state,
  }
}

function validCapability(value: string): boolean {
  return ['createArtifact', 'publishArtifact', 'listArtifacts', 'workspace', 'terrainQuery', 'listInvestigations', 'listProposals', 'fetchUrlPreview'].includes(value)
}
