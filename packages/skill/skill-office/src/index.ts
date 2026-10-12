/** Bundled Office workflows and filesystem resources for document authoring and checks. */

import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

const SKILL_NAMES = ['office', 'office-docx', 'office-pptx', 'office-xlsx', 'office-render', 'office-recalculate', 'office-export-pdf'] as const

/** Office skill resource location. */
export interface Config {
  /** Absolute assets directory containing skill folders and shared scripts; defaults to carrier resources or packaged assets. */
  assetRoot?: string
}

/** Validated resource configuration. */
export const Config: z<Config> = z.object({
  assetRoot: z.string().min(1),
})

/** Cordis plugin identity. */
export const name = 'skill-office'
/** Registry used by the bundled provider. */
export const inject = ['skills']

function parseSkill(raw: string, path: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`skill-office: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description : undefined
  if (typeof description !== 'string' || description.length === 0) throw new Error(`skill-office: ${path} has no description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

function resolveAssetRoot(config: Config): string {
  const bundled = process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME
  return config.assetRoot ?? process.env.DSH_BUNDLED_OFFICE_SKILLS ?? (bundled ? join(dirname(bundled), 'office-skills') : fileURLToPath(new URL('../assets/', import.meta.url)))
}

/**
 * Register Office skills with resources readable by the script interpreter.
 * @param ctx - Context carrying the skill registry.
 * @param input - Optional packaged resource override.
 */
export function apply(ctx: Context, input: Config = {}): void {
  const assetRoot = resolveAssetRoot(input)
  if (!isAbsolute(assetRoot)) throw new Error('skill-office: assetRoot must be an absolute directory')
  if (!statSync(join(assetRoot, 'scripts', 'check_office.py')).isFile()) {
    throw new Error('skill-office: assets must contain scripts/check_office.py')
  }
  const candidates: SkillCandidate[] = SKILL_NAMES.map((skillName) => {
    const directory = join(assetRoot, skillName)
    const path = join(directory, 'SKILL.md')
    const { description } = parseSkill(readFileSync(path, 'utf8'), path)
    return {
      name: skillName, description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-office', source: 'bundled', rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory.split(sep).join('/') }, locator: path,
    }
  })
  const provider: SkillProvider = {
    name: 'dsh-office',
    list: () => Promise.resolve(candidates),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(locator as string, { encoding: 'utf8', signal: options.signal })
      const content = parseSkill(raw, locator as string).content
      return { ...summary, content }
    },
  }
  ctx.skills.registerProvider(() => provider)
}
