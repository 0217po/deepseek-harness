import { defineConfig } from 'tsdown'

/** Separate entry bundles keep the private process bootstrap self-contained. */
export default defineConfig([
  { entry: ['lib/types/index.js', 'lib/types/persistent.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false },
  { entry: { process: 'lib/types/process-entry.js', 'persistent-process': 'lib/types/persistent-process-entry.js' }, outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false, noExternal: ['@deepseek-ai/dsh-subprocess/control'] },
])
