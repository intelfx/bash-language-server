import { fileURLToPath, pathToFileURL } from 'node:url'

import * as fastGlob from 'fast-glob'
import * as fs from 'fs'
import * as path from 'path'
import * as LSP from 'vscode-languageserver'
import { Node as SyntaxNode, Tree } from 'web-tree-sitter'

import { Directive, parseShellCheckDirective } from '../shellcheck/directive'
import { discriminate } from './discriminate'
import { untildify } from './fs'
import * as TreeSitterUtil from './tree-sitter'

const SOURCING_COMMANDS = ['source', '.']

// Bats (https://bats-core.readthedocs.io) test files pull in helper files using
// `load`, which behaves like `source` but resolves relative to the directory of
// the test file and appends ".bash" if the given path does not exist. It is only
// treated as a sourcing command in .bats files, as `load` is a common enough
// name for an unrelated command or function elsewhere.
const BATS_SOURCING_COMMANDS = ['load']
const BATS_SOURCED_EXTENSION = '.bash'

// ShellCheck's special source paths. Each file is analyzed on its own, so the
// toplevel script is approximated by the file itself.
const SCRIPT_DIRECTORY_PATHS = ['SCRIPTDIR', 'TOPLEVELDIR']

export type SourceCommand = {
  range: LSP.Range
  uri: string | null // resolved URIs
  error: string | null
}

/**
 * Analysis the given tree for source commands.
 */
export function getSourceCommands({
  fileUri,
  rootPath,
  tree,
}: {
  fileUri: string
  rootPath: string | null
  tree: Tree
}): SourceCommand[] {
  const sourceCommands: SourceCommand[] = []

  const filePath = fileUri.startsWith('file://') ? fileURLToPath(fileUri) : fileUri
  const workspacePath = rootPath?.startsWith('file://')
    ? fileURLToPath(rootPath)
    : rootPath
  const rootPaths = [path.dirname(filePath), workspacePath].filter(Boolean) as string[]
  const isBatsFile = fileUri.endsWith('.bats')
  const scriptDirectory = path.dirname(filePath)

  const addSourceCommands = (
    range: LSP.Range,
    sourcedPath: string | undefined,
    {
      allowGlob,
      parseError,
      sourcePaths = [],
    }: { allowGlob: boolean; parseError?: string; sourcePaths?: string[] },
  ) => {
    // As in ShellCheck, source paths are searched after the default locations.
    // Relative source paths are relative to the default locations.
    const searchPaths = [
      ...rootPaths,
      ...sourcePaths.flatMap((sourcePath) =>
        path.isAbsolute(sourcePath)
          ? [sourcePath]
          : rootPaths.map((rootPath) => path.join(rootPath, sourcePath)),
      ),
    ]

    // Like ShellCheck, only expand globs from directives: the shell would
    // source just the first match of a glob in the command itself
    if (sourcedPath && allowGlob && isGlob(sourcedPath)) {
      const uris = resolveSourcedGlob({
        rootPaths: searchPaths,
        pattern: sourcedPath,
        filePath,
      })
      if (uris.length === 0) {
        sourceCommands.push({ range, uri: null, error: 'no files match glob' })
      }
      for (const uri of uris) {
        sourceCommands.push({ range, uri, error: null })
      }
      return
    }

    const uri = sourcedPath
      ? resolveSourcedUri({ rootPaths: searchPaths, sourcedPath, isBatsFile })
      : null

    sourceCommands.push({
      range,
      uri,
      error: uri ? null : parseError || 'failed to resolve path',
    })
  }

  // As in ShellCheck, directives before the first command apply to the whole file
  const headerComments: SyntaxNode[] = []
  for (const node of tree.rootNode.namedChildren) {
    if (node?.type !== 'comment') {
      break
    }
    headerComments.push(node)
  }
  const fileWideDirectives = headerComments.flatMap((node) =>
    parseShellCheckDirective(node.text),
  )
  const fileWideSourcePaths = getSourcePaths(fileWideDirectives, scriptDirectory)

  // File-wide assume-sourced directives, treated as if sourced at the top
  for (const node of headerComments) {
    for (const directive of parseShellCheckDirective(node.text)) {
      if (directive.type === 'assume-sourced') {
        addSourceCommands(
          TreeSitterUtil.range(node),
          expandScriptDirectory(directive.path, scriptDirectory),
          { allowGlob: true, sourcePaths: fileWideSourcePaths },
        )
      }
    }
  }

  TreeSitterUtil.forEach(tree.rootNode, (node) => {
    const sourcedPathInfo = getSourcedPathInfoFromNode({
      node,
      isBatsFile,
      scriptDirectory,
      fileWideDirectives,
    })

    if (sourcedPathInfo) {
      const { sourcedPath, parseError, isDirective, sourcePaths } = sourcedPathInfo
      addSourceCommands(TreeSitterUtil.range(node), sourcedPath, {
        allowGlob: !!isDirective,
        parseError,
        sourcePaths,
      })
    }

    return true
  })

  return sourceCommands
}

function getSourcedPathInfoFromNode({
  node,
  isBatsFile,
  scriptDirectory,
  fileWideDirectives,
}: {
  node: SyntaxNode
  isBatsFile: boolean
  scriptDirectory: string
  fileWideDirectives: Directive[]
}): null | {
  sourcedPath?: string
  parseError?: string
  isDirective?: boolean
  sourcePaths?: string[]
} {
  const sourcingCommands = isBatsFile
    ? [...SOURCING_COMMANDS, ...BATS_SOURCING_COMMANDS]
    : SOURCING_COMMANDS

  if (node.type === 'command') {
    const [commandNameNode, argumentNode] = node.namedChildren

    if (!commandNameNode || !argumentNode) {
      return null
    }

    if (
      commandNameNode.type === 'command_name' &&
      sourcingCommands.includes(commandNameNode.text)
    ) {
      // As in ShellCheck, a directive also applies to commands nested in the
      // command after it, and the innermost directive takes precedence.
      // && and || wrap the command in (potentially nested) lists. A directive
      // before the list only belongs to its first command.
      const directives: Directive[] = []
      for (
        let target: SyntaxNode | null = node;
        target && target.type !== 'program';
        target = target.parent
      ) {
        const previous = target.previousSibling
        if (previous?.type === 'comment' && previous.text.includes('shellcheck')) {
          directives.push(...parseShellCheckDirective(previous.text))
        }
        if (
          target.parent?.type === 'list' &&
          target.parent.firstNamedChild?.id !== target.id
        ) {
          break
        }
      }
      directives.push(...fileWideDirectives)
      const sourcePaths = getSourcePaths(directives, scriptDirectory)

      if (directives.length > 0) {
        const sourcedPath = directives.find(discriminate('type', 'source'))?.path

        if (sourcedPath === '/dev/null') {
          return null
        }

        if (sourcedPath) {
          return {
            sourcedPath: expandScriptDirectory(sourcedPath, scriptDirectory),
            isDirective: true,
            sourcePaths,
          }
        }

        const isNotFollowErrorDisabled = !!directives
          .filter(discriminate('type', 'disable'))
          .flatMap(({ rules }) => rules)
          .find((rule) => rule === 'SC1091')

        if (isNotFollowErrorDisabled) {
          return null
        }
      }

      const strValue = TreeSitterUtil.resolveStaticString(argumentNode)
      if (strValue !== null) {
        return {
          sourcedPath: strValue,
          sourcePaths,
        }
      }

      // Strip one leading dynamic section.
      if (argumentNode.type === 'string') {
        const [variableNode, ...suffixNodes] = argumentNode.namedChildren
        if (
          variableNode &&
          TreeSitterUtil.isExpansion(variableNode) &&
          suffixNodes.every((child) => child.type === 'string_content')
        ) {
          const stringContents = argumentNode.text.slice(1, -1)
          if (stringContents.startsWith(`${variableNode.text}/`)) {
            return {
              sourcedPath: `.${stringContents.slice(variableNode.text.length)}`,
              sourcePaths,
            }
          }
        }
      }

      if (argumentNode.type === 'concatenation') {
        // Strip one leading dynamic section from a concatenation node.
        const sourcedPath = resolveSourceFromConcatenation(argumentNode)
        if (sourcedPath) {
          return {
            sourcedPath,
            sourcePaths,
          }
        }
      }

      // TODO: we could try to parse any ShellCheck "source "directive
      // # shellcheck source=src/examples/config.sh
      return {
        parseError: `non-constant source not supported`,
      }
    }
  }

  return null
}

/**
 * Returns the directories from the given source-path directives.
 */
function getSourcePaths(directives: Directive[], scriptDirectory: string): string[] {
  return directives
    .filter(discriminate('type', 'source-path'))
    .map((directive) => expandScriptDirectory(directive.path, scriptDirectory))
}

/**
 * Replaces a leading ShellCheck script directory path (e.g. `SCRIPTDIR/../lib`)
 * with the directory of the analyzed file.
 */
function expandScriptDirectory(sourcedPath: string, scriptDirectory: string): string {
  const [first, ...rest] = sourcedPath.split('/')
  return SCRIPT_DIRECTORY_PATHS.includes(first)
    ? path.join(scriptDirectory, ...rest)
    : sourcedPath
}

/**
 * Tries to resolve the given sourced path and returns a URI if possible.
 * - Converts a relative paths to absolute paths
 * - Converts a tilde path to an absolute path
 * - Resolves the path
 * - For bats files, retries with a ".bash" suffix, like bats' own `load` does
 *
 * NOTE: for future improvements:
 * "If filename does not contain a slash, file names in PATH are used to find
 *  the directory containing filename." (see https://ss64.com/osx/source.html)
 */
function resolveSourcedUri({
  rootPaths,
  sourcedPath,
  isBatsFile,
}: {
  rootPaths: string[]
  sourcedPath: string
  isBatsFile: boolean
}): string | null {
  if (sourcedPath.startsWith('~')) {
    sourcedPath = untildify(sourcedPath)
  }

  // bats' `load` falls back to appending ".bash" when the given path is not a file
  const sourcedPaths = isBatsFile
    ? [sourcedPath, `${sourcedPath}${BATS_SOURCED_EXTENSION}`]
    : [sourcedPath]

  if (sourcedPath.startsWith('/')) {
    for (const candidate of sourcedPaths) {
      if (fs.existsSync(candidate)) {
        return pathToFileURL(candidate).href
      }
    }
    return null
  }

  // resolve  relative path
  for (const rootPath of rootPaths) {
    for (const candidate of sourcedPaths) {
      const potentialPath = path.join(rootPath, candidate)

      // check if path is a file
      if (fs.existsSync(potentialPath)) {
        return pathToFileURL(potentialPath).href
      }
    }
  }

  return null
}

function isGlob(sourcedPath: string): boolean {
  return /[*?[]/.test(sourcedPath)
}

/**
 * Expands a glob from a ShellCheck source directive and returns the URIs of
 * the matching files in sorted order, using the first root path with matches.
 * The analyzed file itself is left out.
 */
function resolveSourcedGlob({
  rootPaths,
  pattern,
  filePath,
}: {
  rootPaths: string[]
  pattern: string
  filePath: string
}): string[] {
  if (pattern.startsWith('~')) {
    pattern = untildify(pattern)
  }

  // Search from the directory before the first glob segment, so that the
  // static part of the path is never interpreted as a glob
  const segments = pattern.split('/')
  const firstGlob = segments.findIndex(isGlob)
  const directory = segments.slice(0, firstGlob).join('/')
  const glob = segments.slice(firstGlob).join('/')
  const searchDirectories = path.isAbsolute(pattern)
    ? [directory || path.sep]
    : rootPaths.map((rootPath) => path.join(rootPath, directory))

  for (const cwd of searchDirectories) {
    const matches = fastGlob
      .sync(glob, { cwd, absolute: true, onlyFiles: true, dot: false })
      .map((match) => path.normalize(match))
      .sort()
    if (matches.length > 0) {
      return matches
        .filter((match) => match !== path.normalize(filePath))
        .map((match) => pathToFileURL(match).href)
    }
  }

  return []
}

/*
 * Resolves the source path from a concatenation node, stripping a leading dynamic directory segment.
 * Returns null if the source path can't be statically determined after stripping a segment.
 * Note: If a non-concatenation node is passed, null will be returned. This is likely a programmer error.
 */
function resolveSourceFromConcatenation(node: SyntaxNode): string | null {
  if (node.type !== 'concatenation') return null
  const stringValue = TreeSitterUtil.resolveStaticString(node)
  if (stringValue !== null) return stringValue // This string is fully static.

  const values: string[] = []
  // Since the string must begin with the variable, the variable must be in the first child.
  const [firstNode, ...rest] = node.namedChildren
  // The first child is static, this means one of the other children is not!
  if (TreeSitterUtil.resolveStaticString(firstNode) !== null) return null

  // if the string is unquoted, the first child is the variable, so there's no more text in it.
  if (!TreeSitterUtil.isExpansion(firstNode)) {
    const [variableNode, ...suffixNodes] = firstNode.namedChildren
    // Allow static string content after one leading expansion, but no other
    // variables or command substitutions.
    if (
      !variableNode ||
      !TreeSitterUtil.isExpansion(variableNode) ||
      suffixNodes.some((child) => child.type !== 'string_content')
    )
      return null
    const stringContents = firstNode.text.slice(1, -1)
    // The string doesn't start with the variable!
    if (!stringContents.startsWith(variableNode.text)) return null
    // Get the remaining static portion the string
    values.push(stringContents.slice(variableNode.text.length))
  }

  for (const child of rest) {
    const value = TreeSitterUtil.resolveStaticString(child)
    // The other values weren't statically determinable!
    if (value === null) return null
    values.push(value)
  }

  // Join all our found static values together.
  const staticResult = values.join('')
  // The path starts with slash, so trim the leading variable and replace with a dot
  if (staticResult.startsWith('/')) return `.${staticResult}`
  // The path doesn't start with a slash, so it's invalid
  // PERF: can we fail earlier than this?
  return null
}
