import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

export function hostStatePath(hostHome: string, override?: string): string {
  return resolve(override || join(hostHome, '.ai-cc'))
}

/**
 * Give Claude Code a stable, anonymous project path while preserving the
 * host-home-relative hierarchy it uses to distinguish projects.
 *
 * Example: /Users/alice/progetto/agent -> /workspace/progetto/agent
 */
export function containerWorkspacePath(cwd: string, hostHome: string): string {
  const absoluteCwd = resolve(cwd)
  const absoluteHome = resolve(hostHome)
  const homeRelative = relative(absoluteHome, absoluteCwd)
  const isInsideHome = homeRelative === '' || (
    homeRelative !== '..' &&
    !homeRelative.startsWith(`..${sep}`) &&
    !isAbsolute(homeRelative)
  )

  if (isInsideHome) {
    if (!homeRelative) return '/workspace'
    return `/workspace/${homeRelative.split(sep).join('/')}`
  }

  const label = basename(absoluteCwd).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'project'
  const digest = createHash('sha256').update(absoluteCwd).digest('hex').slice(0, 10)
  return `/workspace/_external/${label}-${digest}`
}
