import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'node',
  fixedExtension: false,
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
