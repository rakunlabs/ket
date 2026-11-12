// The kernel worker: OpenCascade runs here so the UI stays responsive.
// Messages are {id, type, ...}; answers are {id, ok, result | error}.

import * as R from 'replicad'
import { GcsWrapper, init_planegcs_module } from '@salusoft89/planegcs'
import gcsWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url'
import init from 'replicad-opencascadejs'
import wasmUrl from 'replicad-opencascadejs/wasm?url'
import Manifold from 'manifold-3d'
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url'

import type { Doc, Selector } from './doc'
import type { AutorouteOptions, SweepOptions } from './registry'
import { type BuildResult, Kernel } from './kernel'
import { meshTransfer } from './mesh-transfer'
import { setGcs } from './sketch'
import { setManifoldLib } from './mesh-body'
import { FONT_FILES, registerFont } from './fonts'
import fontRegular from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff?url'
import fontBold from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff?url'

let kernel: Kernel | undefined
let doc: Doc | undefined
let last: BuildResult | undefined

const fontUrls: Record<keyof typeof FONT_FILES, string> = { regular: fontRegular, bold: fontBold }

const ready = (async () => {
  const [oc, gcs, manifold] = await Promise.all([
    init({ locateFile: () => wasmUrl }),
    init_planegcs_module({ locateFile: () => gcsWasmUrl }),
    Manifold({ locateFile: () => manifoldWasmUrl }),
  ])
  R.setOC(oc)
  manifold.setup()
  setManifoldLib(manifold)
  setGcs(new GcsWrapper(new gcs.GcsSystem()))
  // Text features need the fonts; a missing font only fails those features.
  await Promise.all(
    Object.entries(fontUrls).map(async ([name, url]) => {
      try {
        await registerFont(name as keyof typeof FONT_FILES, await (await fetch(url)).arrayBuffer())
      } catch (e) {
        console.warn(`font ${name} failed to load`, e)
      }
    }),
  )
  kernel = new Kernel()
})()

export type WorkerRequest =
  | { id: number; type: 'build'; doc: Doc; assets?: string }
  | { id: number; type: 'faces'; name: string; selector?: Selector }
  | { id: number; type: 'edges'; name: string; selector?: Selector }
  | { id: number; type: 'measure'; name: string; other?: string }
  | { id: number; type: 'checks' }
  | { id: number; type: 'solids'; name: string }
  | { id: number; type: 'section'; names: string[]; axis: 'X' | 'Y' | 'Z'; at: number }
  | { id: number; type: 'between'; a: string | [number, number, number]; b: string | [number, number, number] }
  | { id: number; type: 'sketch'; name: string }
  | { id: number; type: 'board'; drc?: boolean }
  | { id: number; type: 'export'; format: 'step' | 'stl' | '3mf'; names: string[]; models?: Record<string, string> }
  | { id: number; type: 'gears' }
  | { id: number; type: 'motion' }
  | { id: number; type: 'simulate'; seconds: number; samples: number }
  | { id: number; type: 'sweep'; opts: SweepOptions }
  | { id: number; type: 'mechanisms' }
  | { id: number; type: 'autoroute'; opts: AutorouteOptions }

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data
  try {
    await ready
    const k = kernel!
    let result: unknown
    const transfer: Transferable[] = []
    switch (req.type) {
      case 'build': {
        doc = req.doc
        // Import features: download what is not loaded yet (cached by the server).
        const timing: Record<string, number> = {}
        let t0 = performance.now()
        const want = k.missingImports(doc)
        if (want.length && req.assets) {
          await Promise.all(
            want.map(async (url) => {
              try {
                const r = await fetch(`${req.assets}?url=${encodeURIComponent(url)}`)
                if (!r.ok) {
                  const msg = ((await r.json().catch(() => ({}))) as { message?: string }).message ?? r.statusText
                  await k.loadImport(url, new Error(`download ${url}: ${msg}`))
                } else await k.loadImport(url, await r.arrayBuffer())
              } catch (e) {
                await k.loadImport(url, new Error(`download ${url}: ${(e as Error).message}`))
              }
            }),
          )
        }
        if (want.length) timing.imports = Math.round(performance.now() - t0)
        await k.prepareImports(doc)
        t0 = performance.now()
        last = k.build(doc)
        timing.build = Math.round(performance.now() - t0)
        t0 = performance.now()
        const { meshes: out, transfer: meshBuffers } = meshTransfer(k.meshes(last))
        timing.mesh = Math.round(performance.now() - t0)
        transfer.push(...meshBuffers)
        const sketches = k.sketchLines(doc)
        for (const s of sketches) transfer.push(s.lines.buffer, s.construction.buffer)
        t0 = performance.now()
        const board = k.boardState(doc)
        timing.board = Math.round(performance.now() - t0)
        last.timing = timing
        result = { build: last, meshes: out, sketches, board }
        break
      }
      case 'faces':
        result = k.faces(req.name, req.selector)
        break
      case 'edges':
        result = k.edges(req.name, req.selector)
        break
      case 'measure':
        result = k.measure(req.name, req.other)
        break
      case 'sketch':
        result = k.sketch(req.name)
        break
      case 'board':
        result = doc ? k.boardState(doc, { drc: req.drc }) : undefined
        break
      case 'between':
        result = k.between(req.a, req.b)
        break
      case 'checks':
        result = doc ? k.checks(doc) : []
        break
      case 'solids':
        result = k.listSolids(req.name)
        break
      case 'section':
        result = k.section(req.names, req.axis, req.at)
        break
      case 'export':
        result = await k.export(req.format, req.names, req.models)
        break
      case 'gears':
        result = k.gearReport()
        break
      case 'motion':
        result = doc ? k.motion(doc) : undefined
        break
      case 'simulate':
        result = doc ? await k.simulate(doc, req.seconds, req.samples) : undefined
        break
      case 'sweep':
        result = doc ? await k.sweep(doc, req.opts) : undefined
        break
      case 'mechanisms':
        result = k.mechanismReport()
        break
      case 'autoroute':
        if (!doc) throw new Error('nothing is built yet')
        result = await k.autoroute(doc, req.opts)
        break
    }
    ;(self as unknown as Worker).postMessage({ id: req.id, ok: true, result }, transfer)
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
