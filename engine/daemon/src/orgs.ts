import { createHash } from 'node:crypto'
import { type NetworkProfile, resolveProfile } from '@papyrus/core/profiles'
import { getDb } from './database.js'

export type OrgProfile = NetworkProfile
export type OrgRole = 'admin' | 'member'

export interface Organization {
  id: string
  name: string
  domain: string
  profile: OrgProfile
  createdBy: string
  createdAt: string
}

export interface OrgMember {
  id: number
  orgId: string
  memberKey: string
  email: string
  displayName: string | null
  avatarUrl: string | null
  role: OrgRole
  joinedAt: string
}

export interface OrgWithMembers extends Organization {
  members: OrgMember[]
}

export interface OrgMembership {
  org: Organization
  role: OrgRole
  member: OrgMember
}

interface OrgRow {
  id: string
  name: string
  domain: string
  profile: string
  created_by: string
  created_at: string
}

interface OrgMemberRow {
  id: number
  org_id: string
  member_key: string
  email: string
  display_name: string | null
  avatar_url: string | null
  role: string
  joined_at: string
}

const FREE_PROVIDERS = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'aol.com',
  'icloud.com',
  'protonmail.com',
  'proton.me',
  'mail.com',
  'gmx.com',
  'zoho.com',
  'live.com',
  'msn.com',
  'yandex.com',
])

export interface EmailValidation {
  valid: boolean
  reason?: string
}

function mapOrg(row: OrgRow): Organization {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    profile: row.profile as OrgProfile,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

function mapMember(row: OrgMemberRow): OrgMember {
  return {
    id: row.id,
    orgId: row.org_id,
    memberKey: row.member_key,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role as OrgRole,
    joinedAt: row.joined_at,
  }
}

export function currentProfile(): OrgProfile {
  return resolveProfile(process.env)
}

export function validateEmailForProfile(email: string, profile: OrgProfile): EmailValidation {
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf('@')
  if (at < 1 || at === trimmed.length - 1) {
    return { valid: false, reason: 'Invalid email address' }
  }
  const domain = trimmed.slice(at + 1)

  switch (profile) {
    case 'siprnet-il6': {
      if (domain.endsWith('.mil') || domain.endsWith('.gov')) return { valid: true }
      return { valid: false, reason: 'SIPRNet/IL6 requires a .mil or .gov email address' }
    }
    case 'niprnet-il4': {
      if (domain.endsWith('.mil') || domain.endsWith('.gov')) return { valid: true }
      if (!FREE_PROVIDERS.has(domain)) return { valid: true }
      return {
        valid: false,
        reason: 'NIPRNet/IL4 requires a .mil, .gov, or business email address',
      }
    }
    case 'commercial': {
      if (!FREE_PROVIDERS.has(domain)) return { valid: true }
      return { valid: false, reason: 'A business email address is required' }
    }
  }
}

function gravatarUrl(email: string): string {
  const hash = createHash('md5').update(email.trim().toLowerCase()).digest('hex')
  return `https://www.gravatar.com/avatar/${hash}?d=identicon&s=128`
}

export function generateAvatarUrl(email: string | null, displayName: string | null): string {
  if (email) return gravatarUrl(email)
  const seed = encodeURIComponent(displayName ?? 'user')
  return `https://api.dicebear.com/7.x/initials/svg?seed=${seed}`
}

export function createOrg(
  name: string,
  domain: string,
  profile: OrgProfile,
  createdBy: string,
): OrgWithMembers {
  const d = getDb()
  const id = `org-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const normalizedDomain = domain.trim().toLowerCase()

  d.prepare(
    'INSERT INTO organizations (id, name, domain, profile, created_by) VALUES (?, ?, ?, ?, ?)',
  ).run(id, name.trim(), normalizedDomain, profile, createdBy)

  d.prepare(
    `INSERT INTO org_members (org_id, member_key, email, display_name, avatar_url, role)
     VALUES (?, ?, ?, ?, NULL, 'admin')`,
  ).run(id, createdBy, '', null)

  const created = getOrg(id)
  return created as OrgWithMembers
}

export function getOrg(id: string): OrgWithMembers | null {
  const d = getDb()
  const orgRow = d.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as OrgRow | undefined
  if (!orgRow) return null

  const memberRows = d
    .prepare('SELECT * FROM org_members WHERE org_id = ? ORDER BY joined_at ASC')
    .all(id) as OrgMemberRow[]

  return { ...mapOrg(orgRow), members: memberRows.map(mapMember) }
}

export function listOrgs(): Organization[] {
  const d = getDb()
  const rows = d.prepare('SELECT * FROM organizations ORDER BY created_at DESC').all() as OrgRow[]
  return rows.map(mapOrg)
}

export function findOrgByDomain(domain: string): Organization | null {
  const d = getDb()
  const row = d
    .prepare('SELECT * FROM organizations WHERE domain = ?')
    .get(domain.trim().toLowerCase()) as OrgRow | undefined
  return row ? mapOrg(row) : null
}

export function getMembership(orgId: string, memberKey: string): OrgMembership | null {
  const d = getDb()
  const memberRow = d
    .prepare('SELECT * FROM org_members WHERE org_id = ? AND member_key = ?')
    .get(orgId, memberKey) as OrgMemberRow | undefined
  if (!memberRow) return null

  const orgRow = d.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId) as
    | OrgRow
    | undefined
  if (!orgRow) return null

  return { org: mapOrg(orgRow), role: memberRow.role as OrgRole, member: mapMember(memberRow) }
}

export function joinOrg(
  orgId: string,
  memberKey: string,
  email: string,
  displayName: string | null,
): OrgMembership | null {
  const d = getDb()

  d.prepare(
    `INSERT INTO org_members (org_id, member_key, email, display_name, avatar_url, role)
     VALUES (?, ?, ?, ?, NULL, 'member')
     ON CONFLICT(org_id, member_key) DO UPDATE SET
       email = excluded.email,
       display_name = COALESCE(excluded.display_name, org_members.display_name)`,
  ).run(orgId, memberKey, email.trim(), displayName)

  return getMembership(orgId, memberKey)
}

export function getOrgForMember(memberKey: string): OrgMembership | null {
  const d = getDb()
  const memberRow = d
    .prepare('SELECT * FROM org_members WHERE member_key = ? ORDER BY joined_at DESC LIMIT 1')
    .get(memberKey) as OrgMemberRow | undefined
  if (!memberRow) return null
  return getMembership(memberRow.org_id, memberRow.member_key)
}

export function updateProfile(memberKey: string, displayName: string, avatarUrl: string): boolean {
  const d = getDb()
  const result = d
    .prepare('UPDATE org_members SET display_name = ?, avatar_url = ? WHERE member_key = ?')
    .run(displayName, avatarUrl, memberKey)
  return result.changes > 0
}
