/** Read plugin display text and images through exported resources without evaluating plugin code. */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import type { BilingualPreview, LocalizedText, PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'
import { barePackageName } from './profile-resolution/resolver.ts'
import { realModuleFile } from './profile-resolution/legacy-links.ts'

const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

type DisplayFields = Record<'title' | 'description', string | undefined>

/** Raw image limits keep plugin metadata bounded before base64 encoding. */
const IMAGE_LIMIT_KIB = { icon: 256, preview: 1024 } as const
type ImageField = keyof typeof IMAGE_LIMIT_KIB
const IMAGE_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
])

// A declared image resolves or throws; only an absent optional export returns undefined.
function imageOf(
  field: ImageField, specifier: string, packageName: string, parentURL: string, manifestPath: string, value: string,
): string
function imageOf(
  field: ImageField, specifier: string, packageName: string, parentURL: string, manifestPath: string | undefined, value: unknown,
): string | undefined
function imageOf(
  field: ImageField, specifier: string, packageName: string, parentURL: string, manifestPath: string | undefined, value: unknown,
): string | undefined {
  const image = manifestPath === undefined ? undefined : textOf(value, `${manifestPath}: ${field}`)
  let target: string
  // Diagnostics name the file the author edits: the declaring manifest or the exported image.
  let label: string
  if (manifestPath !== undefined && image !== undefined) {
    if (isAbsolute(image) || win32.isAbsolute(image) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(image)) {
      throw new Error(`${manifestPath}: ${field} must be a relative file path`)
    }
    label = manifestPath
    const root = realpathSync(dirname(manifestPath))
    target = resolve(root, image)
    const local = relative(root, realModuleFile(target))
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      throw new Error(`${label}: ${field} must remain inside its manifest directory`)
    }
  } else {
    const exported = optionalResourcePath(`${specifier}/${field}`, parentURL)
    if (exported === undefined) return undefined
    target = label = exported
    assertPackageOwned(realModuleFile(target), packageName, field)
  }
  const extension = extname(target).toLowerCase()
  if (field === 'preview' && extension !== '.svg') throw new Error(`${label}: preview must be SVG`)
  const mediaType = IMAGE_MEDIA_TYPES.get(extension)
  if (mediaType === undefined) throw new Error(`${label}: ${field} must be SVG, PNG, JPEG, or WebP`)
  const file = realModuleFile(target)
  const stat = statSync(file)
  if (!stat.isFile()) throw new Error(`${label}: ${field} must be a regular file`)
  if (stat.size > IMAGE_LIMIT_KIB[field] * 1024) throw new Error(`${label}: ${field} exceeds ${IMAGE_LIMIT_KIB[field]} KiB`)
  const bytes = readFileSync(file)
  if (bytes.length > IMAGE_LIMIT_KIB[field] * 1024) throw new Error(`${label}: ${field} exceeds ${IMAGE_LIMIT_KIB[field]} KiB`)
  return `data:${mediaType};base64,${bytes.toString('base64')}`
}

/** A single preview has exactly one English and one Chinese SVG resource. */
function previewOf(
  specifier: string, packageName: string, parentURL: string, manifestPath: string | undefined, value: unknown,
): BilingualPreview | undefined {
  if (manifestPath === undefined || value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${manifestPath}: preview must map en and zh to SVG file paths`)
  }
  const translations = new Map<string, string>()
  let bytes = 0
  for (const [language, path] of Object.entries(value)) {
    const id = language.toLowerCase()
    if (id !== 'en' && id !== 'zh') throw new Error(`${manifestPath}: preview keys must be en or zh`)
    if (translations.has(id)) throw new Error(`${manifestPath}: preview duplicates locale ${id}`)
    if (typeof path !== 'string' || path.trim() === '') throw new Error(`${manifestPath}: preview.${language} must be a non-empty string`)
    const image = imageOf('preview', specifier, packageName, parentURL, manifestPath, path)
    bytes += Buffer.byteLength(image.slice(image.indexOf(',') + 1), 'base64')
    if (bytes > IMAGE_LIMIT_KIB.preview * 1024) throw new Error(`${manifestPath}: localized previews exceed 1024 KiB in total`)
    translations.set(id, image)
  }
  const en = translations.get('en')
  if (en === undefined) throw new Error(`${manifestPath}: preview translations require an English (en) image`)
  const zh = translations.get('zh')
  if (zh === undefined) throw new Error(`${manifestPath}: preview translations require a Chinese (zh) image`)
  return { en, zh }
}

/** Require an ancestor of the real file whose package.json names the owning package. */
function assertPackageOwned(file: string, name: string, field: ImageField): void {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest) && readObject(manifest).name === name) return
    if (dirname(directory) === directory) throw new Error(`${file}: ${field} must remain inside its package directory`)
  }
}

/**
 * Resolve a plugin resource through the active Node ESM resolver without evaluating it.
 * @param specifier - plugin module or exported resource specifier.
 * @param parentURL - owning module-resolution base.
 * @returns the local filesystem path selected by Node and the active profile.
 * @throws when the resolver is unavailable or the resource cannot resolve to a local file.
 */
export function resolvePluginResource(specifier: string, parentURL: string): string {
  const loader = ModuleLoader.fromInternal()
  if (loader === undefined) throw new Error('Plugin metadata requires the Node module resolver')
  const result = loader.version === 'v2'
    ? loader.resolveSync(parentURL, { specifier, attributes: {} })
    : loader.resolveSync(specifier, parentURL, {})
  return fileURLToPath(result.url)
}

function missingResource(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'ERR_MODULE_NOT_FOUND'
    || code === 'MODULE_NOT_FOUND' || code === 'ENOENT' || code === 'ENOTDIR'
}

function optionalResourcePath(specifier: string, parentURL: string): string | undefined {
  try {
    return resolvePluginResource(specifier, parentURL)
  } catch (error) {
    if (missingResource(error)) return undefined
    throw error
  }
}

function objectOf(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function textOf(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string`)
  return value
}

function readObject(file: string): Record<string, unknown> {
  let contents: unknown
  try {
    contents = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: ${String(error)}`)
  }
  return objectOf(contents, file)
}

function fallbackText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function dictionariesOf(englishPath: string, specifier: string, parentURL: string): Map<string, DisplayFields> {
  const dictionaries = new Map<string, DisplayFields>()
  for (const entry of readdirSync(dirname(englishPath), { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue
    const resource = `${specifier}/locale/${entry.name}`
    const language = entry.name.slice(0, -5)
    if (!LANGUAGE_ID.test(language)) throw new Error(`${resource} must use a language id as its filename`)
    const id = language.toLowerCase()
    if (dictionaries.has(id)) throw new Error(`${resource} duplicates locale ${id}`)
    const file = resolvePluginResource(resource, parentURL)
    if (dirname(file) !== dirname(englishPath)) {
      throw new Error(`${resource}: ${file} must share the English locale directory ${dirname(englishPath)}`)
    }
    const parsed = readObject(file)
    const meta = parsed.meta === undefined ? undefined : objectOf(parsed.meta, `${file}: meta`)
    dictionaries.set(id, {
      title: textOf(meta?.title, `${file}: meta.title`),
      description: textOf(meta?.description, `${file}: meta.description`),
    })
  }
  return dictionaries
}

function localizedText(
  field: keyof DisplayFields, dictionaries: Map<string, DisplayFields>, fallback: string | undefined, finalFallback: string,
): LocalizedText | undefined {
  const entries = [...dictionaries].flatMap(([language, fields]): [string, string][] => {
    const value = fields[field]
    return value === undefined ? [] : [[language, value]]
  })
  if (entries.length === 0) return fallback
  return { en: fallback ?? finalFallback, ...Object.fromEntries(entries) }
}

/**
 * Read plugin locale JSON display text and images without evaluating JavaScript entries.
 * Only a package-root specifier reads its exported package.json: `name`/`description` fill missing
 * locale fields, and a declared `icon` takes priority over its exported resource.
 * A subpath specifier never reads package.json; its icon comes only from `<specifier>/icon`.
 * Manifest images remain inside their declaring directory; exported images remain inside their
 * owning package after realpath resolution. Icons accept SVG, PNG, JPEG, and WebP, up to 256 KiB;
 * explicitly requested previews accept SVG only, up to 1 MiB total. A manifest preview requires en and zh paths;
 * standalone preview exports are ignored. Each image field failure retains the other fields without falling back.
 * Non-package specifiers are skipped without invoking the resource resolver.
 * Language files share the directory containing the resolved English resource;
 * each file is resolved through the complete plugin specifier before reading.
 * Translation maps retain an English fallback, ultimately the full module specifier
 * for titles and empty for descriptions.
 * @param specifier - configured plugin module name, including any package subpath.
 * @param parentURL - owning Loader tree's module-resolution base.
 * @param includePreview - explicitly read artwork for a distribution-owned bundle detail or authoring validation; omitted for inventories.
 * @returns display fields and any resource diagnostic, or undefined for non-package specifiers or absent metadata.
 */
export function readPluginMeta(specifier: string, parentURL: string, includePreview = false): PluginLocalizedMeta | undefined {
  const packageName = barePackageName(specifier)
  if (packageName === undefined) return undefined
  try {
    const englishPath = optionalResourcePath(`${specifier}/locale/en.json`, parentURL)
    const dictionaries = englishPath === undefined ? new Map<string, DisplayFields>() : dictionariesOf(englishPath, specifier, parentURL)
    const manifestPath = packageName === specifier ? optionalResourcePath(`${specifier}/package.json`, parentURL) : undefined
    const manifest = manifestPath === undefined ? undefined : readObject(manifestPath)
    const title = localizedText('title', dictionaries, fallbackText(manifest?.name), specifier)
    const description = localizedText('description', dictionaries, fallbackText(manifest?.description), '')
    const text = {
      ...title === undefined ? {} : { title },
      ...description === undefined ? {} : { description },
    }
    const images: { icon?: string; preview?: BilingualPreview } = {}
    const errors: string[] = []
    for (const field of ['icon', 'preview'] as const) {
      if (field === 'preview' && !includePreview) continue
      try {
        if (field === 'icon') {
          const image = imageOf(field, specifier, packageName, parentURL, manifestPath, manifest?.icon)
          if (image !== undefined) images.icon = image
        } else {
          const image = previewOf(specifier, packageName, parentURL, manifestPath, manifest?.preview)
          if (image !== undefined) images.preview = image
        }
      } catch (error) {
        errors.push(`Plugin metadata for ${specifier}: ${String(error)}`)
      }
    }
    if (title === undefined && description === undefined && Object.keys(images).length === 0 && errors.length === 0) return undefined
    return { ...text, ...images, ...errors.length === 0 ? {} : { error: errors.join('\n') } }
  } catch (error) {
    return { error: `Plugin metadata for ${specifier}: ${String(error)}` }
  }
}
