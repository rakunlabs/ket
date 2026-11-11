import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { GcsWrapper, init_planegcs_module } from '@salusoft89/planegcs'
import * as R from 'replicad'
import init from 'replicad-opencascadejs'
import { beforeAll } from 'vitest'

import { FONT_FILES, registerFont } from '../src/engine/fonts'
import { setGcs } from '../src/engine/sketch'

const require = createRequire(import.meta.url)

beforeAll(async () => {
  const [oc, gcs] = await Promise.all([
    init({ wasmBinary: readFileSync(require.resolve('replicad-opencascadejs/wasm')) }),
    init_planegcs_module(),
  ])
  R.setOC(oc)
  setGcs(new GcsWrapper(new gcs.GcsSystem()))
  for (const [name, file] of Object.entries(FONT_FILES)) {
    const b = readFileSync(require.resolve(file))
    await registerFont(name as keyof typeof FONT_FILES, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
  }
}, 60_000)
