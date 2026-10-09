import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'lib/types/index.js', commands: 'lib/types/commands.js' },
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
})
