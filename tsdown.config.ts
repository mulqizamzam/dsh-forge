import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))

const host: UserConfig = {
  name: 'dsh-forge',
  entry: { index: 'src/host/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: true,
  external: ['schemastery'],
  define: { 'PKG_VERSION': JSON.stringify(pkg.version) },
}

export default [host]
export { PROJECT_ROOT }
