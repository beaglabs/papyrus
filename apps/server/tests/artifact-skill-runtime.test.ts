import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../src/agent/artifact-store.js'
import { SkillRegistry } from '../src/agent/skills.js'

describe('artifact runtime', () => {
  const roots: string[] = []
  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  function root() {
    const value = mkdtempSync(join(tmpdir(), 'papyrus-artifacts-'))
    roots.push(value)
    return value
  }

  it('creates durable PDF, DOCX, and XLSX artifacts with typed previews', () => {
    const dataDir = root()
    const store = new ArtifactStore(dataDir)

    const pdf = store.create({
      format: 'pdf',
      name: 'incident-brief',
      title: 'Incident Brief',
      content: '# Summary\nA customer-hosted report.',
      skill: 'pdf',
      skillVersion: '1.0.0',
    })
    expect(pdf.name).toBe('incident-brief.pdf')
    expect(pdf.kind).toBe('artifact')
    expect(pdf.preview.kind).toBe('pdf')
    expect(pdf.sha256).toHaveLength(64)
    expect(readFileSync(store.contentPath(pdf.id)).subarray(0, 5).toString()).toBe('%PDF-')

    const docx = store.create({
      format: 'docx',
      name: 'memo.docx',
      title: 'Operations Memo',
      content: '## Findings\nNo external action was required.',
      skill: 'docx',
    })
    expect(docx.mediaType).toContain('wordprocessingml')
    expect(readFileSync(store.contentPath(docx.id)).subarray(0, 4).toString('hex')).toBe('504b0304')

    const xlsx = store.create({
      format: 'xlsx',
      name: 'risk-register.xlsx',
      skill: 'xlsx',
      sheets: [{
        name: 'Risks',
        rows: [
          ['Risk', 'Score', 'Open'],
          ['Credential exposure', 9, true],
        ],
      }],
    })
    expect(xlsx.mediaType).toContain('spreadsheetml')
    expect(xlsx.preview).toMatchObject({
      kind: 'spreadsheet',
      sheets: [{ name: 'Risks', rows: [['Risk', 'Score', 'Open'], ['Credential exposure', 9, true]] }],
    })
    expect(readFileSync(store.contentPath(xlsx.id)).subarray(0, 4).toString('hex')).toBe('504b0304')

    expect(new ArtifactStore(dataDir).list().map((artifact) => artifact.id)).toEqual(
      expect.arrayContaining([pdf.id, docx.id, xlsx.id]),
    )
  })

  it('publishes only regular files contained by the sandbox workspace', () => {
    const dataDir = root()
    const workspace = join(dataDir, 'sandbox')
    mkdirSync(workspace, { recursive: true })
    const rendered = join(workspace, 'render.mp4')
    writeFileSync(rendered, Buffer.from('local-render'))

    const store = new ArtifactStore(dataDir)
    const video = store.importWorkspaceFile('render.mp4', workspace, { skill: 'remotion' })
    expect(video.preview.kind).toBe('video')
    expect(video.mediaType).toBe('video/mp4')
    expect(video.provenance).toMatchObject({ producer: 'workspace', skill: 'remotion' })

    const outside = join(dataDir, 'outside.txt')
    writeFileSync(outside, 'must not publish')
    expect(() => store.importWorkspaceFile('../outside.txt', workspace)).toThrow(/inside the sandbox workspace/)
  })
})

describe('skill registry', () => {
  const roots: string[] = []
  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  function registry() {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-skills-'))
    roots.push(dataDir)
    return new SkillRegistry(dataDir)
  }

  it('ships artifact skills as enabled Papyrus built-ins', () => {
    const skills = registry().list()
    for (const name of ['pdf', 'docx', 'xlsx', 'remotion', 'skill-creator']) {
      expect(skills).toContainEqual(expect.objectContaining({
        name,
        trust: 'papyrus_builtin',
        state: 'enabled',
      }))
    }
  })

  it('keeps generated skills inert until an owner approves them', () => {
    const skills = registry()
    const draft = skills.draft({
      name: 'weekly-incident-brief',
      description: 'Create the weekly incident briefing.',
      instructions: 'Query incidents, summarize findings, then create a PDF.',
      requestedCapabilities: ['terrainQuery', 'createArtifact', 'executeAction'],
    }, 'agent')

    expect(draft.state).toBe('draft')
    expect(draft.trust).toBe('workspace_draft')
    expect(draft.requestedCapabilities).toEqual(['terrainQuery', 'createArtifact'])
    expect(() => skills.load(draft.name)).toThrow(/not enabled/)

    const enabled = skills.approveAndEnable(draft.id, 'owner-oid')
    expect(enabled.state).toBe('enabled')
    expect(enabled.trust).toBe('organization_approved')
    expect(skills.load(draft.name).id).toBe(draft.id)
  })

  it('does not allow a generated skill to replace a built-in', () => {
    const skills = registry()
    expect(() => skills.draft({
      name: 'pdf',
      description: 'replace',
      instructions: 'replace the built-in',
    })).toThrow(/cannot be replaced/)
  })
})
