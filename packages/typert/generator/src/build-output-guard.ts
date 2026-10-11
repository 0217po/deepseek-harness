/**
 * Detection of workspace build outputs loaded into an analyzed face program.
 * Typert reads workspace packages only from source when a caller rejects
 * build outputs, so its result cannot depend on whether, or when, package
 * compilation ran.
 * @module @deepseek-ai/dsh-typert-generator/build-output-guard
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

/** One program file that a workspace package's `lib/` holds, with the imports that load it. */
export interface BuildOutputLoad {
  /** Absolute path of the build output. */
  readonly file: string
  /** Program files outside build outputs whose import specifier resolves to {@link file}. */
  readonly importers: readonly BuildOutputImporter[]
  /** Absolute path of the workspace source compiled to {@link file}, when one exists. */
  readonly source: string | undefined
}

/** One import of a build output from a program file outside build outputs. */
export interface BuildOutputImporter {
  /** Absolute path of the importing file. */
  readonly file: string
  /** Import specifier as written. */
  readonly specifier: string
}

/**
 * List the program files that a workspace package holds under its `lib/`
 * directory. A package is the nearest directory with a `package.json` at or
 * below `root`; files under `node_modules` are external. Importers are found
 * by resolving each program file's import specifiers again, so this pass
 * costs extra only when an output is present.
 * @param program - the analyzed face program.
 * @param root - workspace root.
 * @param host - module resolution host of the program.
 * @returns loads in file-path order; empty when every workspace file comes from source.
 */
export function findBuildOutputLoads(
  program: ts.Program,
  root: string,
  host: ts.ModuleResolutionHost,
): BuildOutputLoad[] {
  const classifier = new BuildOutputClassifier(root)
  const outputs = new Map<string, BuildOutputImporter[]>()
  for (const sourceFile of program.getSourceFiles()) {
    if (classifier.isBuildOutput(sourceFile.fileName)) outputs.set(resolve(sourceFile.fileName), [])
  }
  if (outputs.size === 0) return []
  const options = program.getCompilerOptions()
  for (const sourceFile of program.getSourceFiles()) {
    if (!classifier.isWorkspaceFile(sourceFile.fileName) || classifier.isBuildOutput(sourceFile.fileName)) continue
    for (const { fileName: specifier } of ts.preProcessFile(sourceFile.text, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(specifier, sourceFile.fileName, options, host).resolvedModule
      const importers = resolved === undefined ? undefined : outputs.get(resolve(resolved.resolvedFileName))
      importers?.push({ file: resolve(sourceFile.fileName), specifier })
    }
  }
  return [...outputs]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, importers]) => ({ file, importers, source: classifier.sourceFor(file) }))
}

class BuildOutputClassifier {
  private readonly packageRoots = new Map<string, string | undefined>()

  constructor(private readonly root: string) {}

  isWorkspaceFile(file: string): boolean {
    const path = relative(this.root, resolve(file))
    return path !== '' && !path.startsWith('..') && !isAbsolute(path) && !path.split(sep).includes('node_modules')
  }

  isBuildOutput(file: string): boolean {
    if (!this.isWorkspaceFile(file)) return false
    const packageRoot = this.packageRoot(dirname(resolve(file)))
    return packageRoot !== undefined && relative(packageRoot, resolve(file)).split(sep)[0] === 'lib'
  }

  sourceFor(file: string): string | undefined {
    const packageRoot = this.packageRoot(dirname(file))
    if (packageRoot === undefined) return undefined
    const [lib, types, ...rest] = relative(packageRoot, file).split(sep)
    const last = rest.at(-1)
    if (lib !== 'lib' || types !== 'types' || last === undefined) return undefined
    const stem = join(packageRoot, 'src', ...rest.slice(0, -1), last.replace(/\.d\.([cm]?)ts$/u, '.$1ts'))
    return [stem, `${stem}x`].find(candidate => existsSync(candidate))
  }

  private packageRoot(directory: string): string | undefined {
    if (this.packageRoots.has(directory)) return this.packageRoots.get(directory)
    const found = existsSync(join(directory, 'package.json'))
      ? directory
      : directory === this.root || dirname(directory) === directory
        ? undefined
        : this.packageRoot(dirname(directory))
    this.packageRoots.set(directory, found)
    return found
  }
}
