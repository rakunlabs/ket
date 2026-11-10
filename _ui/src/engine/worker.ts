// The kernel worker: OpenCascade runs here so the UI stays responsive.
// Messages are {id, type, ...}; answers are {id, ok, result | error}.

import * as R from 'replicad'
import { GcsWrapper, init_planegcs_module } from '@salusoft89/planegcs'
import gcsWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url'
import init from 'replicad-opencascadejs'
import wasmUrl from 'replicad-opencascadejs/wasm?url'

import type { Doc, Selector } from './doc'
import { type BuildResult, Kernel } from './kernel'
import { meshTransfer } from './mesh-transfer'
import { setGcs } from './sketch'

let kernel: Kernel | undefined
let doc: Doc | undefined
let last: BuildResult | undefined

const ready = (async () => {
  const [oc, gcs] = await Promise.all([init({ locateFile: () => wasmUrl }), init_planegcs_module({ locateFile: () => gcsWasmUrl })])
  R.setOC(oc)
  setGcs(new GcsWrapper(new gcs.GcsSystem()))
  kernel = new Kernel()
})()

export type WorkerRequest =
  | { id: number; type: 'build'; doc: Doc }
  | { id: number; type: 'faces'; name: string; selector?: Selector }
  | { id: number; type: 'edges'; name: string; selector?: Selector }
  | { id: number; type: 'measure'; name: string; other?: string }
  | { id: number; type: 'checks' }
  | { id: number; type: 'between'; a: string | [number, number, number]; b: string | [number, number, number] }
  | { id: number; type: 'sketch'; name: string }
  | { id: number; type: 'board'; drc?: boolean }
  | { id: number; type: 'export'; format: 'step' | 'stl'; names: string[]; models?: Record<string, string> }

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
        last = k.build(doc)
        const { meshes: out, transfer: meshBuffers } = meshTransfer(k.meshes(last))
        transfer.push(...meshBuffers)
        const sketches = k.sketchLines(doc)
        for (const s of sketches) transfer.push(s.lines.buffer, s.construction.buffer)
        result = { build: last, meshes: out, sketches, board: k.boardState(doc) }
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
      case 'export':
        result = k.export(req.format, req.names, req.models)
        break
    }
    ;(self as unknown as Worker).postMessage({ id: req.id, ok: true, result }, transfer)
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
