// Loads the WASM engines (OpenCascade, planegcs, Manifold) and fonts in Node,
// for tests and scripts that run the kernel outside the browser.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { GcsWrapper, init_planegcs_module } from '@salusoft89/planegcs'
import * as R from 'replicad'
import init from 'replicad-opencascadejs'
import Manifold from 'manifold-3d'

import { FONT_FILES, registerFont } from '../src/engine/fonts'
import { setManifoldLib } from '../src/engine/mesh-body'
import { setGcs } from '../src/engine/sketch'

const require = createRequire(import.meta.url)

export async function setupNode() {
  const [oc, gcs, manifold] = await Promise.all([
    init({ wasmBinary: readFileSync(require.resolve('replicad-opencascadejs/wasm')) }),
    init_planegcs_module(),
    Manifold(),
  ])
  R.setOC(oc)
  manifold.setup()
  setManifoldLib(manifold)
  setGcs(new GcsWrapper(new gcs.GcsSystem()))
  for (const [name, file] of Object.entries(FONT_FILES)) {
    const b = readFileSync(require.resolve(file))
    await registerFont(name as keyof typeof FONT_FILES, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
  }
}
