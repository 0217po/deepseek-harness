/** Koffi resolution checks for freshly generated Desktop lockfiles. */

import { dump } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { verifyKoffiLockfile } from './koffi-policy.ts'

function lockfile(...packages: string[]): string {
  return dump({ lockfileVersion: '9.0', packages: Object.fromEntries(packages.map(name => [name, {}])) })
}

describe('Desktop Koffi lockfile', () => {
  it('accepts the qualified JavaScript and platform packages alongside unrelated dependencies', () => {
    expect(() => {
      verifyKoffiLockfile(lockfile(
        'koffi@3.1.1', '@koromix/koffi-darwin-arm64@3.1.1', '@koromix/koffi-win32-x64@3.1.1', 'unrelated@3.3.2',
      ))
    }).not.toThrow()
    expect(() => { verifyKoffiLockfile(lockfile('koffi@3.1.1')) }).not.toThrow()
  })

  it.each(['koffi@3.3.2', '@koromix/koffi-darwin-arm64@3.3.2', '@koromix/koffi-win32-x64@3.3.2'])(
    'rejects an additional divergent resolution: %s', (entry) => {
      expect(() => { verifyKoffiLockfile(lockfile('koffi@3.1.1', entry)) })
        .toThrow(`lockfile resolved ${entry}; all Koffi packages must use 3.1.1`)
    },
  )

  it.each([lockfile(), lockfile('koffi@3.3.2'), lockfile('@koromix/koffi-linux-x64@3.1.1')])(
    'requires the qualified JavaScript package: %s', (text) => {
      expect(() => { verifyKoffiLockfile(text) }).toThrow('lockfile must resolve koffi@3.1.1')
    },
  )

  it.each(['', '{}', 'packages: []', 'packages: null', 'packages: invalid'])(
    'rejects a missing or invalid package mapping: %s', (text) => {
      expect(() => { verifyKoffiLockfile(text) }).toThrow('lockfile must contain a packages mapping')
    },
  )
})
