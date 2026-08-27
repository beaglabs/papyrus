import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { LocalSandbox } from '@mastra/core/workspace'

export function detectCommandIsolation(): ReturnType<typeof LocalSandbox.detectIsolation> {
  const detected = LocalSandbox.detectIsolation()
  if (!detected.available) return detected
  try {
    // Mastra checks only whether the binary exists. Containers may disallow
    // namespaces even when bwrap is installed. Probe with fixed trusted code.
    if (detected.backend === 'bwrap') execFileSync('bwrap', [
      '--unshare-all', '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
      '--', '/usr/bin/true',
    ], { timeout: 3000, stdio: 'ignore' })
    else if (detected.backend === 'seatbelt') execFileSync('sandbox-exec', [
      '-p', '(version 1)(deny default)(allow process-exec)(allow file-read*)(deny network*)', '/usr/bin/true',
    ], { timeout: 3000, stdio: 'ignore' })
    else return { available: false, backend: 'none', message: 'No supported command isolation backend' }
    return detected
  } catch {
    return { available: false, backend: 'none', message: `${detected.backend} is installed but cannot start an isolated process` }
  }
}

// Do not inherit Mastra's default seatbelt profile (all host reads) or its
// broad /opt bind on Linux. Runtime executables/libraries are the only host
// content available to commands; data and credentials stay outside.
export function seatbeltProfile(root: string): string {
  const path = realpathSync(root)
  const reads = ['/usr', '/bin', '/sbin', '/System', '/Library/Apple', '/Library/Frameworks', '/Library/Developer/CommandLineTools',
    '/opt/homebrew/bin', '/opt/homebrew/lib', '/opt/homebrew/Cellar', dirname(realpathSync(process.execPath)), path]
  const quote = (value: string) => JSON.stringify(value)
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)', '(allow process-fork)',
    '(allow process-info* (target same-sandbox))', '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    // Metadata is needed to resolve ancestors, but does not expose file bytes.
    '(allow file-read-metadata)',
    ...reads.map((value) => `(allow file-read* (subpath ${quote(value)}))`),
    '(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/localtime"))',
    `(allow file-write* (subpath ${quote(path)}))`,
    '(allow file-write-data (literal "/dev/null"))',
    '(allow file-ioctl (literal "/dev/null"))',
    '(deny network*)',
  ].join('\n')
}

export function bubblewrapArgs(root: string): string[] {
  const path = realpathSync(root)
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']
  for (const readonly of ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc/alternatives', '/etc/ld.so.cache', '/etc/localtime', dirname(realpathSync(process.execPath))]) {
    args.push('--ro-bind-try', readonly, readonly)
  }
  args.push('--bind', path, path, '--chdir', path)
  return args
}

export function sandboxEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(realpathSync(process.execPath))}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: join(root, '.tmp'),
  }
}
