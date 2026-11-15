import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { getShellCheckRcDirectives, parseShellCheckRc } from '../rc'

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
}))

describe('parseShellCheckRc', () => {
  it('parses directives and skips comments', () => {
    expect(
      parseShellCheckRc(
        [
          '# A comment',
          '# shellcheck disable=SC1000',
          'disable=SC2001 # Another comment',
          '',
          'source-path=SCRIPTDIR assume-sourced=SCRIPTDIR/../lib.sh',
          'source=lib#1.sh',
        ].join('\n'),
      ),
    ).toEqual([
      { type: 'disable', rules: ['SC2001'] },
      { type: 'source-path', path: 'SCRIPTDIR' },
      { type: 'assume-sourced', path: 'SCRIPTDIR/../lib.sh' },
      { type: 'source', path: 'lib#1.sh' },
    ])
  })
})

describe('getShellCheckRcDirectives', () => {
  let rootPath: string
  let directory: string

  beforeEach(() => {
    rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-language-server-rc-'))
    directory = path.join(rootPath, 'project', 'lib')
    fs.mkdirSync(directory, { recursive: true })
    fs.mkdirSync(path.join(rootPath, 'home'))
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(rootPath, 'home'))
    vi.stubEnv('XDG_CONFIG_HOME', path.join(rootPath, 'config'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(rootPath, { recursive: true, force: true })
  })

  const writeRc = (rcPath: string, contents: string) => {
    fs.mkdirSync(path.dirname(rcPath), { recursive: true })
    fs.writeFileSync(rcPath, contents)
  }

  it('returns nothing without an rc file', () => {
    expect(getShellCheckRcDirectives(directory)).toEqual([])
  })

  it('uses the nearest rc file in the directory or its parents', () => {
    writeRc(path.join(rootPath, '.shellcheckrc'), 'shell=sh')
    writeRc(path.join(rootPath, 'project', 'shellcheckrc'), 'shell=bash')

    expect(getShellCheckRcDirectives(directory)).toEqual([
      { type: 'shell', shell: 'bash' },
    ])
  })

  it.each([
    ['home', '.shellcheckrc'],
    ['config', 'shellcheckrc'],
  ])('falls back to %s/%s', (...rcPath) => {
    writeRc(path.join(rootPath, ...rcPath), 'shell=bash')

    expect(getShellCheckRcDirectives(directory)).toEqual([
      { type: 'shell', shell: 'bash' },
    ])
  })

  it('honors --norc and --rcfile', () => {
    writeRc(path.join(rootPath, '.shellcheckrc'), 'shell=sh')
    writeRc(path.join(directory, 'custom.rc'), 'shell=bash')

    expect(getShellCheckRcDirectives(directory, ['--norc'])).toEqual([])
    expect(getShellCheckRcDirectives(directory, ['--rcfile=custom.rc'])).toEqual([
      { type: 'shell', shell: 'bash' },
    ])
    expect(getShellCheckRcDirectives(directory, ['--rcfile', 'custom.rc'])).toEqual([
      { type: 'shell', shell: 'bash' },
    ])
    expect(
      getShellCheckRcDirectives(directory, ['--rcfile=custom.rc', '--norc']),
    ).toEqual([])
  })

  it('rereads a modified rc file', () => {
    const rcPath = path.join(rootPath, '.shellcheckrc')
    writeRc(rcPath, 'shell=sh')
    expect(getShellCheckRcDirectives(directory)).toEqual([{ type: 'shell', shell: 'sh' }])

    writeRc(rcPath, 'shell=bash')
    const later = new Date(Date.now() + 10000)
    fs.utimesSync(rcPath, later, later)
    expect(getShellCheckRcDirectives(directory)).toEqual([
      { type: 'shell', shell: 'bash' },
    ])
  })
})
