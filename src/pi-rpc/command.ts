import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export function defaultPiCommand(): string {
  return platform() === 'win32' ? 'pi.cmd' : 'pi'
}

export function isExecutable(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false
    const stat = statSync(filePath)
    if (stat.isDirectory()) return false
    if (platform() === 'win32') return true
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findInPath(command: string, envPath: string = process.env.PATH ?? ''): string | null {
  if (!envPath) return null
  const isWin = platform() === 'win32'
  const delimiter = isWin ? ';' : ':'
  const dirs = envPath.split(delimiter).filter(Boolean)
  const extensions = isWin
    ? (process.env.PATHEXT?.split(';').filter(Boolean) ?? ['.CMD', '.BAT', '.EXE'])
    : ['']

  for (const dir of dirs) {
    if (isWin) {
      const hasExt = extensions.some(ext => command.toLowerCase().endsWith(ext.toLowerCase()))
      if (hasExt) {
        const fullPath = join(dir, command)
        if (isExecutable(fullPath)) return fullPath
      } else {
        for (const ext of extensions) {
          const fullPath = join(dir, `${command}${ext}`)
          if (isExecutable(fullPath)) return fullPath
        }
      }
    } else {
      const fullPath = join(dir, command)
      if (isExecutable(fullPath)) return fullPath
    }
  }
  return null
}

export function getStandardPiCandidatePaths(): string[] {
  const isWin = platform() === 'win32'
  const home = homedir()
  const candidates: string[] = []

  if (isWin) {
    const exts = ['.cmd', '.exe', '.bat']
    for (const ext of exts) {
      candidates.push(join(home, '.local', 'bin', `pi${ext}`))
      candidates.push(join(home, '.pi', 'agent', 'bin', `pi${ext}`))
      if (process.env.APPDATA) {
        candidates.push(join(process.env.APPDATA, 'npm', `pi${ext}`))
      }
      if (process.env.LOCALAPPDATA) {
        candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'pi', `pi${ext}`))
      }
    }
  } else {
    candidates.push(
      join(home, '.local', 'bin', 'pi'),
      join(home, '.pi', 'agent', 'bin', 'pi'),
      '/opt/homebrew/bin/pi',
      '/usr/local/bin/pi',
      '/usr/bin/pi',
      '/bin/pi'
    )
  }

  return candidates
}

export function findPiExecutable(): string | null {
  const baseName = defaultPiCommand()
  const fromPath = findInPath(baseName)
  if (fromPath) return fromPath

  for (const candidate of getStandardPiCandidatePaths()) {
    if (isExecutable(candidate)) {
      return candidate
    }
  }

  return null
}

export function getPiCommand(override?: string): string {
  const trimmed = override?.trim()
  if (trimmed) {
    const hasSeparator = trimmed.includes('/') || trimmed.includes('\\')
    if (hasSeparator) {
      if (isExecutable(trimmed)) {
        return trimmed
      }
      // Path was explicitly given but doesn't exist. Attempt to fall back to auto-detected pi.
      const fallback = findPiExecutable()
      if (fallback) {
        console.error(`pi-acp: configured command "${trimmed}" not found, falling back to "${fallback}"`)
        return fallback
      }
      return trimmed
    }

    if (trimmed === 'pi' || trimmed === 'pi.cmd') {
      return findPiExecutable() ?? trimmed
    }

    const fromPath = findInPath(trimmed)
    if (fromPath) return fromPath

    return trimmed
  }

  return findPiExecutable() ?? defaultPiCommand()
}

export function shouldUseShellForPiCommand(cmd: string): boolean {
  if (platform() !== 'win32') return false

  const normalized = cmd.trim().toLowerCase()
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat')
}
