import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { logger } from '../util/logger'
import { Directive, parseShellCheckDirectiveCommands } from './directive'

const RC_FILE_NAMES = ['.shellcheckrc', 'shellcheckrc']

const rcFileCache = new Map<string, { mtimeMs: number; directives: Directive[] }>()

/**
 * Returns the directives from the ShellCheck rc file that applies to files in
 * the given directory, honoring --norc and --rcfile in the ShellCheck arguments.
 */
export function getShellCheckRcDirectives(
  directory: string,
  shellcheckArguments: string[] = [],
): Directive[] {
  const rcFile = findShellCheckRc(directory, shellcheckArguments)
  return rcFile ? readShellCheckRc(rcFile) : []
}

function findShellCheckRc(
  directory: string,
  shellcheckArguments: string[],
): string | null {
  let rcFile: string | undefined
  for (const [index, arg] of shellcheckArguments.entries()) {
    if (arg === '--norc') {
      return null
    } else if (arg === '--rcfile') {
      rcFile = shellcheckArguments[index + 1]
    } else if (arg.startsWith('--rcfile=')) {
      rcFile = arg.slice('--rcfile='.length)
    }
  }
  // ShellCheck is run from the document's directory
  if (rcFile) {
    return path.resolve(directory, rcFile)
  }

  // Like ShellCheck, use the first rc file in the directory or its parents,
  // or else in the home or XDG configuration directory
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    for (const name of RC_FILE_NAMES) {
      const candidate = path.join(current, name)
      if (isFile(candidate)) {
        return candidate
      }
    }
    if (path.dirname(current) === current) {
      break
    }
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  for (const candidate of [
    path.join(os.homedir(), '.shellcheckrc'),
    path.join(configHome, 'shellcheckrc'),
  ]) {
    if (isFile(candidate)) {
      return candidate
    }
  }
  return null
}

function readShellCheckRc(rcFile: string): Directive[] {
  try {
    const { mtimeMs } = fs.statSync(rcFile)
    const cached = rcFileCache.get(rcFile)
    if (cached?.mtimeMs === mtimeMs) {
      return cached.directives
    }
    const directives = parseShellCheckRc(fs.readFileSync(rcFile, 'utf8'))
    rcFileCache.set(rcFile, { mtimeMs, directives })
    return directives
  } catch (error) {
    logger.warn(`ShellCheck: failed to read ${rcFile}: ${String(error)}`)
    return []
  }
}

/**
 * Parses the contents of a ShellCheck rc file.
 */
export function parseShellCheckRc(contents: string): Directive[] {
  // A comment starts with a # at the start of the line or after whitespace
  return contents
    .split('\n')
    .flatMap((line) => parseShellCheckDirectiveCommands(line.replace(/(^|\s)#.*$/, '')))
}

function isFile(filePath: string): boolean {
  return fs.statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false
}
