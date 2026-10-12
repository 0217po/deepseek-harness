/** Resolve a manual Windows build version and validate the selected machine preset. */
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { desktopBuildVersionPrefix, validateDesktopBuildVersion } from './desktop-build-version.mjs'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from './desktop-package-environment.mjs'

/**
 * Resolve an explicit version or a UTC date/run/attempt identifier without release storage access.
 * @param {NodeJS.ProcessEnv} environment Manual version and GitHub run identity.
 * @param {string} productVersion Version declared by the selected checkout.
 * @param {Date} now Time used for the UTC date segment.
 * @returns {string} Validated build version.
 */
export function windowsCiVersion(environment, productVersion, now = new Date()) {
  const requested = environment.PACKAGE_BUILD_VERSION?.trim()
  const date = now.toISOString().slice(0, 10).replaceAll('-', '')
  const example = `${desktopBuildVersionPrefix(productVersion)}${date}.1`
  if (!requested) throw new Error(`Build version is required: use auto, ${productVersion}, or e.g. ${example}`)
  let candidate = requested
  if (requested === 'auto') {
    for (const name of ['GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT']) {
      if (!/^[1-9]\d*$/u.test(environment[name] ?? '')) throw new Error(`${name} must be a positive integer`)
    }
    candidate = `${desktopBuildVersionPrefix(productVersion)}${date}.${environment.GITHUB_RUN_NUMBER}.${environment.GITHUB_RUN_ATTEMPT}`
  }
  try {
    return validateDesktopBuildVersion(candidate, productVersion)
  } catch {
    throw new Error(`Invalid build version for this checkout: use auto, ${productVersion}, or e.g. ${example}`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const appRoot = resolve(import.meta.dirname, '..')
  const product = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'))
  const version = windowsCiVersion(process.env, product.version)
  const mode = process.env.PACKAGE_SIGNING
  if (mode !== 'unsigned' && mode !== 'signed') throw new Error('Select unsigned or signed packaging')
  if (!process.env.DSH_PACKAGING_PRESET) throw new Error('Select a machine preset')
  const environment = loadDesktopPackageEnvironment('win32', process.env, appRoot, { unsigned: mode === 'unsigned' })
  // Machine-owned secrets are not automatically known to the Actions log masker.
  for (const [name, value] of Object.entries(environment)) {
    if (/TOKEN|PASSWORD|SECRET/iu.test(name) && value) {
      const escaped = value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
      process.stdout.write(`::add-mask::${escaped}\n`)
    }
  }
  validateDesktopPackageEnvironment(environment, { platform: 'win32', arch: 'x64' }, { unsigned: mode === 'unsigned' })
  if (!process.env.GITHUB_OUTPUT || !process.env.GITHUB_STEP_SUMMARY) throw new Error('Run this adapter from GitHub Actions')
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Windows x64 ${mode} installer\n\nVersion: ${version}\n\nCommit: ${process.env.GITHUB_SHA}\n\nPreset: ${process.env.DSH_PACKAGING_PRESET}\n`)
}
