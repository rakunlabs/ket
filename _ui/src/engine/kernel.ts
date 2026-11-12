// The kernel turns a Doc into solids with OpenCascade (through replicad).
// It runs in a Web Worker in the browser and directly in Node for tests.
//
// Every feature is rebuilt only when its resolved definition or one of its
// inputs changed. replicad operations consume their inputs, so the cache
// keeps a master copy of each shape and every use works on a clone.

//
// Helpers live in ./kernel/: result types, shape helpers, selectors,
// placement, drawings, feature building, checks and motion runs.

import * as R from 'replicad'
import type { Edge, Face, Shape3D } from 'replicad'

import { type Check, type Doc, type Feature, type Profile, type Plane, type Selector, type Sketch, type Expr, type Track, type Via, bodies, dependsOn, effectiveParameters, inputsOf, sketchesOf } from './doc'
import { namesIn, num, resolveParameters } from './expr'
import { explodeOffset } from './explode'
import { boardStyle } from './pcb/artwork'
import { boardDrills } from './pcb/drills'
import { type GearState, GearError, describeGear, gearLocalShape, gearOptions, gearStates, localKey, placeGear } from './gears'
import { type MotionPlan, motionPlan } from './motion'
import { type Mechanisms, mechanismReport, mechanismStates } from './mechanisms'
import { autorouteBoard } from './pcb/autoroute'
import { type ResolvedBoard, resolveBoard } from './pcb/board'
import type { AutorouteOptions, AutorouteResult, ProfileSource, SweepOptions } from './registry'
import { type View, boxOf, pathsToLines } from './drawing'
import { drc, ratsnest } from './pcb/drc'
import { type ZoneFill, fillZones } from './pcb/zones'
import type { BoardState } from './pcb/state'
import { type SolvedSketch, solveSketch } from './sketch'
import { drawSection } from './section-draw'
import { MeshBody, displayMesh, forgetPaint, meshBody, meshCube, composeBodies } from './mesh-body'
import { type ThreeMF, type TriMesh, fetchKey, isZip, paintFilament, parseSTL, pickObject, read3MF, update3MF, urlFile, urlFragment, write3MF, writeSTL } from './model-files'
import { runCheck } from './kernel/checks'
import { polyDrawing, profileDrawing, resolveDecal, sketchDrawing } from './kernel/drawings'
import { makeFeature, makeMeshFeature } from './kernel/features'
import { simulateMotion, sweepMotion } from './kernel/motion-run'
import { meshShape } from './kernel/part-models'
import { place, vec } from './kernel/placement'
import { centerOf, directionOf, friendlyType, selectIndexed } from './kernel/selectors'
import { type Body, SOLID_STL_TRIANGLES, type Loaded, bboxOf, bodyBox, bodyVolume, boxGap, brepToMesh, countTopo, faceCount, importUrls, isMesh, kernelMessage, overlapRegions, r3, round, safeDistance, simplifyRing, volumeOf } from './kernel/shapes'
import type { BBox, BuildResult, CheckResult, EdgeInfo, FaceInfo, FeatureStatus, MeshData, ResolvedDecal, SketchFrame, SketchLines, SketchStatus, V3 } from './kernel/types'
import { BOARD, PART_PREFIX } from './kernel/types'

export type { Body } from './kernel/shapes'
export { boxesApart } from './kernel/shapes'
export * from './kernel/types'
interface CacheEntry {
  key: string
  shape: Body
  status: FeatureStatus
  /** The B-rep solid as a mesh body, made once when a mesh operation or check needs it. */
  meshed?: MeshBody
}

export class Kernel {
  /** @internal */
  cache = new Map<string, CacheEntry>()
  private meshCache = new Map<string, MeshData>()
  private params = new Map<string, number>()
  /** @internal */
  doc: Doc | undefined
  /** STEP/STL/3MF files by URL, read before a build (import features). */
  private imported = new Map<string, Loaded | Error>()
  /** Opened 3MF files by fetch URL: each #object is read from it on demand. */
  private threeMF = new Map<string, ThreeMF | Error>()

  /** URLs to fetch before building doc: 3MF files once, whatever objects are taken from them. */
  missingImports(doc: Doc): string[] {
    const urls = importUrls(doc)
    this.forgetImports(urls)
    // A failed download is tried again on the next build (the network may be back).
    for (const key of this.importErrors) {
      this.imported.delete(key)
      this.threeMF.delete(key)
      // Objects of a 3MF whose download failed carry its error too.
      for (const u of [...this.imported.keys()]) if (fetchKey(u) === key) this.imported.delete(u)
    }
    this.importErrors.clear()
    const want = [...urls].filter((u) => !this.imported.has(u) && !this.threeMF.has(fetchKey(u)))
    return [...new Set(want.map(fetchKey))]
  }

  /** URLs whose download failed for a passing reason (network, server busy): retried on the next build. */
  private importErrors = new Set<string>()

  /** Builds since each import URL was last used (dry runs and undo build other documents in between). */
  private importAge = new Map<string, number>()

  /** Frees files no import has used for a while (so a preview or an undo does not reload a big 3MF). */
  private forgetImports(used: Set<string>) {
    const keep = 8
    const now = new Set([...used, ...[...used].map(fetchKey)])
    for (const [u, age] of this.importAge) if (!now.has(u)) this.importAge.set(u, age + 1)
    for (const u of now) this.importAge.set(u, 0)
    const stale = (u: string) => (this.importAge.get(u) ?? keep + 1) > keep
    const keys = new Set([...this.importAge.keys()].filter((u) => !stale(u)))
    for (const [u, e] of this.imported) {
      if (!stale(u)) continue
      if (!(e instanceof Error)) {
        if ('shape' in e) e.shape.delete()
        else {
          if (e.solid && !(e.solid instanceof Error)) e.solid.delete()
          forgetPaint(e.mesh?.paintId)
          e.mesh?.delete()
        }
      }
      this.imported.delete(u)
      this.importErrors.delete(u)
    }
    for (const k of this.threeMF.keys()) {
      if (!keys.has(k)) {
        this.threeMF.delete(k)
        this.importErrors.delete(k)
      }
    }
    for (const u of [...this.importAge.keys()]) if (stale(u)) this.importAge.delete(u)
  }

  /**
   * Reads a downloaded STEP, STL or 3MF file for the import features with
   * this URL. A 3MF URL (without #) opens the file: its objects are read
   * when a feature asks for them by #id or #name.
   */
  async loadImport(url: string, data: ArrayBuffer | Error, retry = false): Promise<void> {
    const is3MF = /\.3mf$/i.test(fetchKey(url))
    if (data instanceof Error) {
      // Network trouble is tried again on the next build; a refusal (host, type, size) stays until the URL changes.
      if (retry) this.importErrors.add(is3MF ? fetchKey(url) : url)
      if (is3MF) this.threeMF.set(fetchKey(url), data)
      else this.imported.set(url, data)
      return
    }
    this.importErrors.delete(is3MF ? fetchKey(url) : url)
    try {
      if (is3MF) {
        if (!isZip(data)) throw new Error('it is not a 3MF file (a 3MF is a zip archive); upload the .3mf the slicer saved')
        this.threeMF.set(fetchKey(url), await read3MF(data))
        return
      }
      const head = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(512, data.byteLength)))
      if (head.includes('ISO-10303-21')) {
        this.imported.set(url, { shape: (await R.importSTEP(new Blob([data]))) as Shape3D })
        return
      }
      const tri = parseSTL(data)
      const entry: Loaded = { tri }
      // A small STL also becomes a B-rep solid: faces to select, and it can be a board part model.
      if (tri.triangles.length / 3 <= SOLID_STL_TRIANGLES) {
        try {
          entry.solid = (await R.importSTL(new Blob([data]))) as Shape3D
        } catch (e) {
          entry.solid = new Error(kernelMessage(e))
        }
      }
      this.imported.set(url, entry)
    } catch (e) {
      const err = new Error(`could not read ${urlFile(url) || url}: ${kernelMessage(e)}`)
      if (is3MF) this.threeMF.set(fetchKey(url), err)
      else this.imported.set(url, err)
    }
  }

  /** Reads the #objects of opened 3MF files that doc uses (synchronous builds need them ready). */
  async prepareImports(doc: Doc): Promise<void> {
    const urls = importUrls(doc)
    for (const url of urls) {
      if (this.imported.has(url)) continue
      const file = this.threeMF.get(fetchKey(url))
      if (!file) continue
      if (file instanceof Error) {
        this.imported.set(url, file)
        continue
      }
      const name = urlFile(url) || '3MF file'
      try {
        const obj = pickObject(file, urlFragment(url), name)
        this.imported.set(url, { tri: await file.mesh(obj.id) })
      } catch (e) {
        this.imported.set(url, new Error(kernelMessage(e)))
      }
    }
  }

  /** The loaded body of an import URL: a B-rep solid (STEP, small STL) unless mesh is preferred. */
  /** @internal */
  importedBody(url: string, what: string, solidOnly = false): Body {
    const s = this.imported.get(url)
    if (!s) {
      if (this.threeMF.has(fetchKey(url))) throw new Error(`${url} is not read yet; build again`)
      throw new Error(`${url} is not loaded yet; it is downloaded before the build (check the URL and the server log)`)
    }
    if (s instanceof Error) throw s
    if ('shape' in s) return s.shape.clone() as Shape3D
    if (solidOnly) {
      if (s.solid instanceof Error) throw new Error(`${what}: OpenCascade cannot make a solid of this STL (${s.solid.message})`)
      if (!s.solid) throw new Error(`${what}: the model has ${s.tri.triangles.length / 3} triangles; a part model needs a STEP file or an STL with at most ${SOLID_STL_TRIANGLES} triangles`)
      return s.solid.clone() as Shape3D
    }
    if (s.solid && !(s.solid instanceof Error)) return s.solid.clone() as Shape3D
    s.mesh ??= meshBody(s.tri, what)
    return s.mesh.clone()
  }

  private solved = new Map<string, { key: string; sketch: SolvedSketch; error?: string }>()

  /** Solves (or reuses) a sketch by name. */
  sketch(name: string): SolvedSketch {
    const s = this.doc?.sketches.find((x) => x.name === name)
    if (!s) {
      const known = this.doc?.sketches.map((x) => x.name) ?? []
      throw new Error(`no sketch "${name}"; sketches are: ${known.join(', ') || '(none; create one with sketch)'}`)
    }
    const key = JSON.stringify([s, Object.fromEntries(this.params)])
    const hit = this.solved.get(name)
    if (hit && hit.key === key) {
      if (hit.error) throw new Error(hit.error)
      return hit.sketch
    }
    try {
      const sk = solveSketch(s, this.params)
      this.solved.set(name, { key, sketch: sk })
      return sk
    } catch (e) {
      const msg = (e as Error).message
      this.solved.set(name, { key, sketch: undefined as never, error: msg })
      throw e
    }
  }

  /** A solved sketch, with where it lies when it is on a face. */
  sketchReport(name: string): SolvedSketch & { frame?: SketchFrame; frame_error?: string } {
    const sk = this.sketch(name)
    const s = this.doc!.sketches.find((x) => x.name === name)!
    if (!s.on) return sk
    try {
      return { ...sk, frame: this.sketchFrame(s) }
    } catch (e) {
      return { ...sk, frame_error: (e as Error).message }
    }
  }

  /** @internal */
  outline(f: { name: string; sketch?: string; profile?: Profile; plane?: Plane; offset?: Expr }): { drawing: R.Drawing; plane: Plane; offset: number; frame?: SketchFrame } {
    const p = this.params
    if (f.sketch) {
      if (f.profile) throw new Error('use either sketch or profile, not both')
      const s = this.doc!.sketches.find((x) => x.name === f.sketch) as Sketch | undefined
      const sk = this.sketch(f.sketch)
      const offset = num(s!.offset, p, `sketch ${s!.name}.offset`, 0)
      return { drawing: sketchDrawing(sk, f.name), plane: s!.plane, offset, ...(s!.on ? { frame: this.sketchFrame(s!) } : {}) }
    }
    if (!f.profile) throw new Error('needs a sketch (name of a sketch) or a profile (rect, circle, slot, polygon)')
    if (!f.plane) throw new Error('a profile needs a plane: XY, XZ or YZ')
    return { drawing: profileDrawing(f.profile, p, f.name), plane: f.plane, offset: num(f.offset, p, `${f.name}.offset`, 0) }
  }

  /**
   * Where a sketch on a face lies: the face (by selector) of a built
   * feature, which must be one flat face. Origin at its center plus offset
   * along the outward normal; u along the face's own X (world X or Y,
   * whichever lies most in the face), v = normal × u.
   */
  sketchFrame(s: Sketch): SketchFrame {
    return this.faceFrame(s.on!.feature, s.on!.face, num(s.offset, this.params, `sketch ${s.name}.offset`, 0), `sketch ${s.name}`)
  }

  /**
   * The frame of one flat face of a built feature, picked by selector:
   * origin at the face center plus offset along the outward normal, u the
   * world axis lying most in the face (X, else Y), v = normal × u.
   */
  faceFrame(feature: string, face: Selector, offset: number, what: string): SketchFrame {
    if (!this.cache.has(feature)) throw new Error(`${what}: "${feature}" is not built (it is missing, failed or comes later); a face of it is needed`)
    const body = this.body(feature)
    try {
      if (isMesh(body)) throw new Error(`${what}: "${feature}" is a triangle mesh and has no faces to pick; use a plane (XY, XZ, YZ with offset) instead`)
      const { all, picked } = selectIndexed(body, face, true, this.params, `${what}.face`)
      if (picked.length !== 1)
        throw new Error(`${what}: the face selector matches ${picked.length} faces of "${feature}" (it has ${all.length}); make it pick exactly one (e.g. ">Z", or add near / inBox; list_faces shows them)`)
      const f = all[picked[0]] as R.Face
      if (f.geomType !== 'PLANE') throw new Error(`${what}: the face of "${feature}" is ${friendlyType(f.geomType)}, not flat; pick a flat face`)
      const n = directionOf(f, true)
      if (!n) throw new Error(`${what}: the face of "${feature}" has no normal`)
      const c = centerOf(f)
      const origin: V3 = [c[0] + n[0] * offset, c[1] + n[1] * offset, c[2] + n[2] * offset]
      const pick = Math.abs(n[0]) < 0.9 ? ([1, 0, 0] as V3) : ([0, 1, 0] as V3)
      const d = pick[0] * n[0] + pick[1] * n[1] + pick[2] * n[2]
      const u0: V3 = [pick[0] - d * n[0], pick[1] - d * n[1], pick[2] - d * n[2]]
      const ul = Math.hypot(...u0)
      const u: V3 = [u0[0] / ul, u0[1] / ul, u0[2] / ul]
      const v: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]
      const r = (x: V3) => x.map((a) => Math.round(a * 1e6) / 1e6 + 0) as V3
      return { origin: r(origin), normal: r(n), u: r(u), v: r(v) }
    } finally {
      body.delete()
    }
  }

  /** Solves every sketch for the build result. */
  private sketchStatus(doc: Doc): SketchStatus[] {
    return doc.sketches.map((s) => {
      try {
        const sk = this.sketch(s.name)
        return {
          name: s.name,
          plane: s.plane,
          ok: sk.ok,
          status: sk.status,
          dof: sk.dof,
          loops: sk.loops.length,
          message: sk.message,
        }
      } catch (e) {
        return { name: s.name, plane: s.plane, ok: false, status: 'failed', dof: 0, loops: 0, message: (e as Error).message }
      }
    })
  }

  /** Rebuilds the document, reusing unchanged features. */
  build(doc: Doc): BuildResult {
    this.doc = doc
    const result: BuildResult = { ok: true, parameters: {}, features: [], bodies: [], sketches: [] }

    try {
      this.params = resolveParameters(effectiveParameters(doc))
    } catch (e) {
      this.params = new Map()
      result.ok = false
      result.parameterError = (e as Error).message
    }
    for (const [k, v] of this.params) result.parameters[k] = round(v, 6)

    result.sketches = this.sketchStatus(doc)
    for (const name of [...this.solved.keys()]) if (!doc.sketches.some((s) => s.name === name)) this.solved.delete(name)
    this.gears = doc.features.some((f) => f.type === 'gear') ? gearStates(doc, this.params) : new Map()
    this.mechanisms = mechanismStates(doc, this.params)

    const keys = new Map<string, string>()
    const seen = new Set<string>()

    for (const f of doc.features) {
      if (seen.has(f.name)) {
        result.ok = false
        result.features.push({ name: f.name, type: f.type, ok: false, error: `duplicate feature name "${f.name}"` })
        continue
      }
      seen.add(f.name)

      const inputs = dependsOn(f, doc)
      const missing = inputs.filter((i) => !keys.has(i))
      if (missing.length) {
        const st: FeatureStatus = {
          name: f.name,
          type: f.type,
          ok: false,
          error: `uses ${missing.map((m) => `"${m}"`).join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} missing, defined later or failed`,
        }
        result.ok = false
        result.features.push(st)
        this.drop(f.name)
        continue
      }

      // The key covers the definition with parameters substituted and the
      // keys of the inputs, so any upstream change rebuilds this feature.
      let key: string
      try {
        const sk = sketchesOf(f).map((n) => doc.sketches.find((x) => x.name === n))
        // A gear's place depends on the gears it follows: key on its solved state.
        const gs = f.type === 'gear' ? this.gears.get(f.name) : undefined
        const gk = gs instanceof GearError ? gs.message : gs ? [gs.center, gs.frame, gs.rotation, gs.travel, gs.helix, gs.rp] : undefined
        // A geneva wheel is built from its drive's fields.
        const mk = f.type === 'geneva' && f.part === 'wheel' ? doc.features.find((x) => x.name === f.drive) : undefined
        key = JSON.stringify([f, this.usedParams(f), sk, gk, mk]) + '|' + inputs.map((i) => keys.get(i)).join('|')
      } catch (e) {
        key = String(Math.random())
      }

      const cached = this.cache.get(f.name)
      if (cached && cached.key === key) {
        keys.set(f.name, key)
        result.features.push(cached.status)
        if (!cached.status.ok) result.ok = false
        continue
      }

      this.drop(f.name)
      let shape: Body | undefined
      let status: FeatureStatus
      const t0 = Date.now()
      try {
        const warnings: string[] = []
        shape = this.make(f, warnings)
        status = this.describe(f, shape, warnings)
        const ms = Date.now() - t0
        // Slow features are worth knowing about (fillets on big bodies, imports).
        if (ms >= 300) status.ms = ms
      } catch (e) {
        status = { name: f.name, type: f.type, ok: false, error: `${f.name} (${f.type}): ${kernelMessage(e)}${this.hint(f, e)}` }
      }

      if (shape && status.ok) {
        this.cache.set(f.name, { key, shape, status })
        keys.set(f.name, key)
      } else {
        result.ok = false
        shape?.delete()
      }
      result.features.push(status)
    }

    // Forget features that no longer exist.
    for (const name of [...this.cache.keys()]) {
      if (!seen.has(name) && name !== BOARD && !name.startsWith(PART_PREFIX)) this.drop(name)
    }

    result.bodies = bodies(doc)
      .map((f) => f.name)
      .filter((n) => this.cache.has(n))

    this.buildBoard(doc, result)
    const appearance = this.appearanceStatus(doc)
    if (appearance.length) result.appearance = appearance

    return result
  }

  private board: ResolvedBoard | undefined
  private boardKey = ''

  /** The PCB as solids: "board" (FR4 with holes) and one block per part. */
  private buildBoard(doc: Doc, result: BuildResult) {
    if (!doc.pcb) {
      this.board = undefined
      for (const n of [...this.cache.keys()]) if (n === BOARD || n.startsWith(PART_PREFIX)) this.drop(n)
      return
    }
    const b = resolveBoard(doc, this.params, (n) => this.sketch(n))
    this.board = b
    const drills = boardDrills(doc.pcb, b)
    const key = JSON.stringify([
      b.outline,
      b.cutouts,
      b.thickness,
      b.z,
      b.holes,
      drills,
      b.components.map((c) => [c.ref, c.at, c.rotation, c.side, c.courtyard, c.height, c.model, c.model && this.imported.get(c.model.url) instanceof Error]),
      [...new Set(b.components.flatMap((c) => (c.model ? [c.model.url] : [])))].map((u) => this.imported.has(u)),
    ])
    if (key !== this.boardKey) {
      this.boardKey = key
      for (const n of [...this.cache.keys()]) if (n === BOARD || n.startsWith(PART_PREFIX)) this.drop(n)
      if (b.outline.length >= 3) {
        try {
          let d = polyDrawing(b.outline)
          for (const c of b.cutouts) d = d.cut(polyDrawing(c))
          for (const h of drills) {
            const length = Math.hypot(h.to.x - h.from.x, h.to.y - h.from.y)
            const hole = length < 1e-9 ? R.drawCircle(h.d / 2) : R.drawRoundedRectangle(length + h.d, h.d, h.d / 2 - 1e-6).rotate(Math.atan2(h.to.y - h.from.y, h.to.x - h.from.x) * 180 / Math.PI)
            d = d.cut(hole.translate((h.from.x + h.to.x) / 2, (h.from.y + h.to.y) / 2))
          }
          const solid = (d.sketchOnPlane('XY', b.z) as R.Sketch).extrude(b.thickness) as Shape3D
          this.cache.set(BOARD, { key, shape: solid, status: this.describe({ name: BOARD, type: 'extrude' } as Feature, solid, []) })
        } catch (e) {
          result.ok = false
          result.features.push({ name: BOARD, type: 'extrude', ok: false, error: `board: ${kernelMessage(e)}` })
        }
        for (const c of b.components) {
          const name = PART_PREFIX + c.ref
          if (c.model) {
            try {
              const solid = this.partModel(c, b)
              this.cache.set(name, { key, shape: solid, status: this.describe({ name, type: 'import' } as Feature, solid, []) })
              continue
            } catch (e) {
              result.ok = false
              result.features.push({ name, type: 'import', ok: false, error: `${c.ref} model: ${kernelMessage(e)}; the part shows as its courtyard block` })
            }
          }
          try {
            const top = c.side === 'top'
            const z0 = top ? b.z + b.thickness : b.z - c.height
            const solid = (polyDrawing(c.courtyard).sketchOnPlane('XY', z0) as R.Sketch).extrude(c.height) as Shape3D
            this.cache.set(name, { key, shape: solid, status: this.describe({ name, type: 'extrude' } as Feature, solid, []) })
          } catch {
            // A degenerate courtyard only costs the 3D block.
          }
        }
      }
    }
    for (const n of [BOARD, ...b.components.map((c) => PART_PREFIX + c.ref)]) {
      const c = this.cache.get(n)
      if (c) {
        result.features.push(c.status)
        result.bodies.push(n)
      }
    }
  }

  /**
   * A part's real model on the board: placed in footprint space (rotate,
   * translate, z up from the face the part sits on), then mirrored for the
   * bottom side, turned by the part rotation and moved to the part.
   */
  private partModel(c: ResolvedBoard['components'][number], b: ResolvedBoard): Shape3D {
    const m = c.model!
    let shape = this.importedBody(m.url, `${c.ref} model`, true) as Shape3D
    const k = num(m.scale, this.params, `${c.ref}.model.scale`, 1)
    if (k !== 1) shape = shape.scale(k, [0, 0, 0]) as Shape3D
    shape = place(shape, m, this.params, `${c.ref}.model`)
    if (c.side === 'bottom') shape = shape.mirror('XY', [0, 0, 0]).mirror('YZ', [0, 0, 0]) as Shape3D
    if (c.rotation) shape = shape.rotate(c.rotation, [0, 0, 0], [0, 0, 1])
    const z = c.side === 'bottom' ? b.z : b.z + b.thickness
    return shape.translate(c.at.x, c.at.y, z)
  }

  private zoneCache: { key: string; fills: ZoneFill[] } | undefined

  boardState(doc: Doc, opts?: { drc?: boolean }): BoardState | undefined {
    if (!doc.pcb || !this.board) return undefined
    const key = JSON.stringify([doc.pcb.zones, doc.pcb.tracks, doc.pcb.vias, this.boardKey, doc.pcb.nets, doc.pcb.classes])
    if (this.zoneCache?.key !== key) this.zoneCache = { key, fills: fillZones(doc.pcb, this.board) }
    const zones = this.zoneCache.fills
    return {
      board: this.board,
      zones,
      ratsnest: ratsnest(doc.pcb, this.board, zones),
      drc: opts?.drc ? drc(doc.pcb, this.board, zones) : undefined,
    }
  }

  private drop(name: string) {
    const c = this.cache.get(name)
    if (c) {
      if (isMesh(c.shape)) for (const id of c.shape.ownPaint ?? []) forgetPaint(id)
      c.shape.delete()
      c.meshed?.delete()
      this.cache.delete(name)
    }
  }

  /** Cache primitives against their actual resolved dimensions; keep the
   * conservative full key for features with indirect dependencies. */
  private usedParams(f: Feature): Record<string, number> {
    if (f.type !== 'box' && f.type !== 'cylinder' && f.type !== 'sphere') return Object.fromEntries(this.params)
    const expressions: unknown[] = [f.translate, f.rotate]
    if (f.type === 'box') expressions.push(f.size)
    else if (f.type === 'cylinder') expressions.push(f.r, f.h)
    else expressions.push(f.r)
    const names = new Set<string>()
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect)
      else if (typeof value === 'string') for (const name of namesIn(value)) names.add(name)
    }
    expressions.forEach(collect)
    return Object.fromEntries([...names].sort().map((name) => [name, this.params.get(name)])) as Record<string, number>
  }

  /** Gear placements of the last build. */
  gears = new Map<string, GearState | GearError>()
  /** Gear solids in their own frame, by shape key: turning a train only re-places them. */
  private gearLocal = new Map<string, Shape3D>()

  /** Gear facts of the last build, for get_gears. */
  gearReport(): Record<string, unknown>[] {
    return [...this.gears].map(([name, g]) => (g instanceof GearError ? { name, error: g.message } : describeGear(g)))
  }

  /** Cams, geneva drives and belts of the last build. */
  mechanisms: Mechanisms = { cams: new Map(), genevas: new Map(), belts: new Map() }

  mechanismReport(): Record<string, unknown>[] {
    return mechanismReport(this.mechanisms)
  }

  /** Routes the board of the last build with the built-in autorouter. */
  async autoroute(doc: Doc, opts: AutorouteOptions): Promise<AutorouteResult> {
    const st = this.boardState(doc)
    if (!st || !doc.pcb) throw new Error('the project has no board yet; start with set_board')
    if (st.board.errors.length) throw new Error(`fix the board first: ${st.board.errors.join('; ')}`)
    const board = st.board
    const only = opts.nets ? new Set(opts.nets) : undefined
    // Rerouting some nets: their old copper goes, everything else stays as an obstacle.
    const pcb = only ? { ...doc.pcb, tracks: doc.pcb.tracks.filter((t) => !only.has(t.net)), vias: doc.pcb.vias.filter((v) => !only.has(v.net)) } : doc.pcb
    const rules = new Set(['clearance', 'short', 'hole_to_hole', 'copper_to_edge', 'outside_board', 'track_width', 'via'])
    const before = new Set(drc(pcb, board, fillZones(pcb, board)).map((v) => v.message))
    // Only problems the new copper brings in, and only copper rules (silk, placement are not the router's).
    const check = (r: { tracks: Track[]; vias: Via[] }) => {
      const next = { ...pcb, tracks: [...pcb.tracks, ...r.tracks], vias: [...pcb.vias, ...r.vias] }
      return drc(next, board, fillZones(next, board)).filter((v) => !before.has(v.message) && rules.has(v.rule))
    }
    return autorouteBoard(pcb, board, { skip: new Set(opts.skip ?? []), only, timeout: opts.timeout, check })
  }

  motion(doc: Doc): MotionPlan {
    return motionPlan(doc, this.params)
  }

  /** Headless physics: loose bodies' centers over time. */
  simulate(doc: Doc, seconds: number, samples: number): Promise<Record<string, unknown>> {
    return simulateMotion(this, doc, seconds, samples)
  }

  /** Interference sweep of the moving bodies over the driven parameter. */
  sweep(doc: Doc, opts: SweepOptions): Promise<Record<string, unknown>> {
    return sweepMotion(this, doc, opts)
  }

  /** The still solid a point lies inside, if any (driven bodies move, so they are not checked). */
  /** @internal */
  insideOf(p: [number, number, number], self: string): string | undefined {
    const plan = this.doc ? this.motion(this.doc) : undefined
    const moving = new Set([...(plan?.moves.map((m) => m.body) ?? []), ...(plan?.physics.map((x) => x.name) ?? [])])
    for (const f of this.doc ? bodies(this.doc) : []) {
      if (f.name === self || moving.has(f.name) || !this.cache.has(f.name)) continue
      const s = this.cache.get(f.name)!
      const [lo, hi] = bodyBox(s.shape)
      if (p.some((v, i) => v < lo[i] || v > hi[i])) continue
      const r = this.between(p, f.name) as { distance?: number }
      if (r.distance === 0) return f.name
    }
    return undefined
  }

  /** @internal */
  gearShape(f: Extract<Feature, { type: 'gear' }>, warnings: string[]): Shape3D {
    const g = this.gears.get(f.name)
    if (!g) throw new Error('gear was not solved')
    if (g instanceof GearError) throw g
    warnings.push(...g.warnings)
    const o = gearOptions(f, this.params)
    const key = localKey(g, o)
    let local = this.gearLocal.get(key)
    if (!local) {
      local = gearLocalShape(g, o, f.name)
      this.gearLocal.set(key, local)
      // Keep the cache small: a few shapes per gear is plenty.
      if (this.gearLocal.size > 64) {
        const first = this.gearLocal.keys().next().value!
        this.gearLocal.get(first)?.delete()
        this.gearLocal.delete(first)
      }
    }
    return placeGear(local.clone() as Shape3D, g)
  }

  /** A fresh copy of a built feature; the caller owns it. */
  body(name: string): Body {
    const c = this.cache.get(name)
    if (!c) {
      const known = [...this.cache.keys()]
      throw new Error(`no feature "${name}"${known.length ? `; features are: ${known.join(', ')}` : ' (the model is empty)'}`)
    }
    return c.shape.clone() as Body
  }

  /** A fresh copy of a built feature as a mesh body (B-rep solids are tessellated once and kept). */
  meshOf(name: string): MeshBody {
    const c = this.cache.get(name)
    // Not built: body() says which features there are.
    if (!c) return this.body(name) as never
    if (isMesh(c.shape)) return c.shape.clone()
    c.meshed ??= brepToMesh(c.shape, name)
    return c.meshed.clone()
  }

  /** A fresh copy of a built B-rep feature; says what to do when it is a mesh body. */
  shape(name: string): Shape3D {
    const b = this.body(name)
    if (isMesh(b)) {
      b.delete()
      throw new Error(`"${name}" is a triangle mesh (imported STL / 3MF), and this operation needs a B-rep solid with faces and edges; use boolean, transform, pattern or mirror on it, or model this part as a B-rep (box, extrude, ...) and combine it with the mesh`)
    }
    return b
  }

  /** @internal */
  isMeshBody(name: string): boolean {
    const c = this.cache.get(name)
    return !!c && isMesh(c.shape)
  }

  has(name: string): boolean {
    return this.cache.has(name)
  }

  private make(f: Feature, warnings: string[]): Body {
    return makeFeature(this, f, warnings)
  }

  makeMesh(f: Feature, warnings: string[]): MeshBody {
    return makeMeshFeature(this, f, warnings)
  }

  /** The move that puts the align anchor of box at align.to, plus translate. */
  /** @internal */
  alignOffset(f: Extract<Feature, { type: 'transform' }>, box: BBox): V3 {
    const p = this.params
    const to = vec(f.align!.to, p, `${f.name}.align.to`)
    const extra = vec(f.translate, p, `${f.name}.translate`)
    const anchor = f.align!.anchor ?? ['center', 'center', 'min']
    return [0, 1, 2].map((k) => {
      const a = anchor[k] === 'min' ? box[0][k] : anchor[k] === 'max' ? box[1][k] : (box[0][k] + box[1][k]) / 2
      return to[k] - a + extra[k]
    }) as V3
  }

  /** The separate solids of a body, with what list_solids reports. */
  private solidsOf(name: string): { body: Body; box: BBox; volume: number; center: V3 }[] {
    const b = this.body(name)
    let parts: Body[]
    if (isMesh(b)) {
      parts = b.parts()
      b.delete()
    } else {
      const s = (b as unknown as { solids?: Shape3D[] }).solids
      if (s && s.length > 1) {
        parts = s.map((x) => x.clone() as Shape3D)
        for (const x of s) x.delete()
        b.delete()
      } else {
        for (const x of s ?? []) x.delete()
        parts = [b]
      }
    }
    return parts.map((body) => {
      const box = bodyBox(body)
      return { body, box, volume: bodyVolume(body), center: r3([(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2, (box[0][2] + box[1][2]) / 2]) }
    })
  }

  /** list_solids: each separate solid of a body. */
  listSolids(name: string): { index: number; bbox: BBox; size: V3; center: V3; volume: number }[] {
    const list = this.solidsOf(name)
    try {
      return list.map((s, index) => ({ index, bbox: s.box, size: r3([s.box[1][0] - s.box[0][0], s.box[1][1] - s.box[0][1], s.box[1][2] - s.box[0][2]]), center: s.center, volume: round(s.volume, 3) }))
    } finally {
      for (const s of list) s.body.delete()
    }
  }

  /** @internal */
  pickSolids(f: Extract<Feature, { type: 'solids' }>): Body {
    const p = this.params
    const all = this.solidsOf(f.source).map((s, index) => ({ ...s, index }))
    let chosen = all
    const pick = f.pick ?? {}
    if (pick.index) {
      const bad = pick.index.filter((i) => i >= all.length)
      if (bad.length) throw new Error(`"${f.source}" has ${all.length} solids (index 0..${all.length - 1}); there is no ${bad.join(', ')}; see list_solids`)
      chosen = chosen.filter((s) => pick.index!.includes(s.index))
    }
    if (pick.inBox) {
      const a = vec(pick.inBox[0], p, `${f.name}.pick.inBox[0]`)
      const b = vec(pick.inBox[1], p, `${f.name}.pick.inBox[1]`)
      chosen = chosen.filter((s) => s.center.every((v, k) => v >= Math.min(a[k], b[k]) - 1e-6 && v <= Math.max(a[k], b[k]) + 1e-6))
    }
    if (pick.near) {
      const q = vec(pick.near, p, `${f.name}.pick.near`)
      // Nearest by box first (cheap), then the exact distance for solids whose box is that close.
      const boxGap = (bx: BBox) => Math.hypot(...[0, 1, 2].map((k) => Math.max(bx[0][k] - q[k], 0, q[k] - bx[1][k])))
      const ranked = chosen.map((s) => ({ s, gap: boxGap(s.box) })).sort((x, y) => x.gap - y.gap)
      if (ranked.length) {
        const exact = (s: (typeof all)[number]) => {
          if (isMesh(s.body)) {
            const probe = meshCube([q[0] - 1e-4, q[1] - 1e-4, q[2] - 1e-4], [q[0] + 1e-4, q[1] + 1e-4, q[2] + 1e-4])
            try {
              return s.body.overlap(probe).volume > 0 ? 0 : s.body.distance(probe)
            } finally {
              probe.delete()
            }
          }
          const probe = R.makeSphere(1e-4).translate(q[0], q[1], q[2]) as Shape3D
          try {
            return safeDistance(s.body as Shape3D, probe)
          } finally {
            probe.delete()
          }
        }
        let best = ranked[0].s
        let bestD = Infinity
        for (const { s, gap } of ranked) {
          if (gap > bestD) break
          const d = exact(s)
          if (d < bestD) {
            bestD = d
            best = s
          }
        }
        chosen = [best]
      }
    }
    if (pick.largest) chosen = [...chosen].sort((x, y) => y.volume - x.volume).slice(0, pick.largest)
    for (const s of all) if (!chosen.includes(s)) s.body.delete()
    if (!chosen.length) throw new Error(`no solid of "${f.source}" matches the pick; list_solids shows its ${all.length} solids with their boxes and centers`)
    if (chosen.length === 1) return chosen[0].body
    const bodies = chosen.map((s) => s.body)
    if (bodies.some(isMesh)) {
      const meshes = bodies.map((b) => (isMesh(b) ? b : brepToMesh(b, f.name)))
      bodies.forEach((b, i) => b !== meshes[i] && b.delete())
      return composeBodies(meshes)
    }
    return R.makeCompound(bodies as Shape3D[]) as unknown as Shape3D
  }

  /**
   * Cross-sections of bodies by a plane normal to axis at a coordinate: per
   * body, its closed outlines (in the plane's (u, v): X → (y, z), Y → (x, z),
   * Z → (x, y)), their boxes and the cut area. B-rep bodies are cut on a fine
   * tessellation (within 0.01 mm).
   */
  section(names: string[], axis: 'X' | 'Y' | 'Z', at: number, simplify = 0.05, outlines?: Map<string, [number, number][][]>): Record<string, unknown>[] {
    const k = { X: 0, Y: 1, Z: 2 }[axis]
    const [u, v] = { X: ['y', 'z'], Y: ['x', 'z'], Z: ['x', 'y'] }[axis]
    return names.map((name) => {
      const box = this.cache.get(name)?.status.bbox
      if (box && (at < box[0][k] || at > box[1][k])) return { name, cut: false, note: `the plane ${axis}=${at} misses ${name} (it spans ${box[0][k]}..${box[1][k]})` }
      const m = this.meshOf(name)
      try {
        const cut = m.section(axis, at)
        const area = cut.area
        outlines?.set(name, cut.outlines.map((r) => simplifyRing(r, simplify / 2)))
        const loops = cut.outlines
          .map((ring) => {
            const pts = simplifyRing(ring, simplify)
            let a = 0
            for (let i = 0; i < pts.length; i++) {
              const [x0, y0] = pts[i]
              const [x1, y1] = pts[(i + 1) % pts.length]
              a += x0 * y1 - x1 * y0
            }
            const us = pts.map((p) => p[0])
            const vs = pts.map((p) => p[1])
            return {
              kind: a >= 0 ? 'material' : 'hole',
              area: round(Math.abs(a) / 2, 2),
              box: [[round(Math.min(...us), 2), round(Math.min(...vs), 2)], [round(Math.max(...us), 2), round(Math.max(...vs), 2)]],
              points: pts.length <= 64 ? pts.map((p) => [round(p[0], 2), round(p[1], 2)]) : undefined,
              point_count: pts.length,
            }
          })
          .sort((x, y) => y.area - x.area)
        return { name, cut: true, axes: [u, v], area: round(area, 2), loops: loops.slice(0, 40), ...(loops.length > 40 ? { more_loops: loops.length - 40 } : {}) }
      } finally {
        m.delete()
      }
    })
  }

  /**
   * The 3MF project a body comes from and the object in it, following
   * inputs back to the import (the first input of a boolean, the source of
   * solids): its filament colors show the body's paint.
   */
  private sourceOf(name: string, depth = 0): { file: ThreeMF; object?: ThreeMF['objects'][number] } | undefined {
    const f = this.doc?.features.find((x) => x.name === name)
    if (!f || depth > 64) return undefined
    if (f.type === 'import') {
      const file = this.threeMF.get(fetchKey(f.url))
      if (!file || file instanceof Error) return undefined
      try {
        return { file, object: pickObject(file, urlFragment(f.url), urlFile(f.url)) }
      } catch {
        return { file }
      }
    }
    // The first input that leads to a 3MF (a B-rep target with a painted 3MF tool still shows the paint).
    const srcs = f.type === 'solids' ? [f.source] : inputsOf(f)
    for (const src of srcs) {
      const found = this.sourceOf(src, depth + 1)
      if (found) return found
    }
    return undefined
  }

  /** Paint state → RGB for a body: its 3MF's filament colors (state 0, "the object's own", is left to the body color). */
  private paintColors(name: string): ((attrs: string) => [number, number, number] | undefined) | undefined {
    const filaments = this.sourceOf(name)?.file.filaments
    if (!filaments?.length) return undefined
    const rgb = filaments.map((c) => {
      const m = /^#?([0-9a-f]{6})/i.exec(c)
      if (!m) return undefined
      const n = parseInt(m[1], 16)
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] as [number, number, number]
    })
    const memo = new Map<string, [number, number, number] | undefined>()
    return (attrs) => {
      if (memo.has(attrs)) return memo.get(attrs)
      const f = paintFilament(attrs)
      const c = f ? rgb[f - 1] : undefined
      memo.set(attrs, c)
      return c
    }
  }

  /** The color of the filament a 3MF object prints with where it is not painted. */
  private filamentOf(name: string): string | undefined {
    const src = this.sourceOf(name)
    return src?.object?.filament ? src.file.filaments[src.object.filament - 1] : undefined
  }

  /** section with a picture of the cut (PNG base64) when a canvas is available. */
  async sectionImage(names: string[], axis: 'X' | 'Y' | 'Z', at: number): Promise<{ bodies: Record<string, unknown>[]; image?: string }> {
    const outlines = new Map<string, [number, number][][]>()
    const bodies = this.section(names, axis, at, 0.05, outlines)
    const colorOf = (n: string) => {
      const f = this.doc?.features.find((x) => x.name === n)
      const material = f?.material ? this.doc?.materials?.find((x) => x.name === f.material) : undefined
      return material?.color ?? f?.color
    }
    const axes = ({ X: ['Y', 'Z'], Y: ['X', 'Z'], Z: ['X', 'Y'] } as const)[axis]
    const image = await drawSection([...outlines].map(([name, loops]) => ({ name, loops, color: colorOf(name) })), [axes[0], axes[1]], `section ${axis} = ${Math.round(at * 1000) / 1000} mm`)
    return { bodies, image }
  }

  private hint(f: Feature, e: unknown): string {
    if (e instanceof Error && e.message && !(e instanceof WebAssembly.Exception)) return ''
    switch (f.type) {
      case 'fillet':
      case 'chamfer':
        return '. Usually the size is too large for the selected edges (keep it below half the thinnest adjacent wall), or the selector picks edges that cannot be rounded together. Try a smaller value, or select fewer edges (list_edges shows them).'
      case 'shell':
        return '. Usually the thickness is larger than a wall, a fillet radius or a small feature of the solid. Shell before filleting, or use a smaller thickness.'
      case 'boolean':
        return '. The tools may touch the target only on a face or an edge; overlap them a little (e.g. 0.01 mm) or move them apart.'
      default:
        return ''
    }
  }

  private describe(f: Feature, s: Body, warnings: string[]): FeatureStatus {
    const st: FeatureStatus = { name: f.name, type: f.type, ok: true }
    if (isMesh(s)) {
      st.bbox = bodyBox(s)
      st.volume = round(s.volume(), 3)
      st.solids = s.solids()
      st.triangles = s.triangles
      if (st.solids > 1 && f.type !== 'pattern' && f.type !== 'mirror' && f.type !== 'import' && f.type !== 'solids' && f.type !== 'instance' && !(f.type === 'boolean' && (f.separate || warnings.some((w) => w.includes('separate solids'))))) warnings.push(`the result has ${st.solids} separate solids`)
      if (st.volume <= 0) warnings.push('the result has no volume')
      if (warnings.length) st.warnings = warnings
      return st
    }
    try {
      st.bbox = bboxOf(s)
      st.volume = round(volumeOf(s), 3)
      st.solids = s.solids?.length ?? 1
      const quick = faceCount(s, 200)
      // Counting distinct faces and edges of a vendor model takes seconds; walk them only for normal bodies.
      if (quick > 200) st.faces = faceCount(s)
      else {
        st.faces = countTopo(s, 'face')
        st.edges = countTopo(s, 'edge')
      }
    } catch {
      // A shape without a bounding box is still valid (empty intersect).
    }
    if ((st.solids ?? 1) > 1 && f.type !== 'pattern' && f.type !== 'mirror' && f.type !== 'solids' && f.type !== 'instance' && !(f.type === 'boolean' && (f.separate || warnings.some((w) => w.includes('separate solids'))))) warnings.push(`the result has ${st.solids} separate solids`)
    if (st.volume !== undefined && st.volume <= 0) warnings.push('the result has no volume')
    if (warnings.length) st.warnings = warnings
    return st
  }

  /**
   * Solved sketches as 3D polylines for display: each entity becomes a run
   * of points on its plane.
   */
  sketchLines(doc: Doc): SketchLines[] {
    const out: SketchLines[] = []
    for (const s of doc.sketches) {
      let sk: SolvedSketch
      try {
        sk = this.sketch(s.name)
      } catch {
        continue
      }
      const off = (() => {
        try {
          return num(s.offset, this.params, 'offset', 0)
        } catch {
          return 0
        }
      })()
      let frame: SketchFrame | undefined
      if (s.on) {
        try {
          frame = this.sketchFrame(s)
        } catch {
          continue
        }
      }
      const to3 = (u: number, v: number): V3 =>
        frame
          ? [frame.origin[0] + frame.u[0] * u + frame.v[0] * v, frame.origin[1] + frame.u[1] * u + frame.v[1] * v, frame.origin[2] + frame.u[2] * u + frame.v[2] * v]
          : s.plane === 'XY' ? [u, v, off] : s.plane === 'XZ' ? [u, off, v] : [off, u, v]
      const lines: number[] = []
      const construction: number[] = []
      const seg = (dst: number[], a: V3, b: V3) => dst.push(...a, ...b)
      for (const e of sk.entities) {
        const dst = e.construction ? construction : lines
        if (e.kind === 'line') seg(dst, to3(...e.a), to3(...e.b))
        else {
          const [a0, a1] =
            e.kind === 'circle'
              ? [0, 2 * Math.PI]
              : (() => {
                  const s0 = Math.atan2(e.start[1] - e.c[1], e.start[0] - e.c[0])
                  let s1 = Math.atan2(e.end[1] - e.c[1], e.end[0] - e.c[0])
                  if (s1 <= s0) s1 += 2 * Math.PI
                  return [s0, s1]
                })()
          const n = Math.max(8, Math.ceil(((a1 - a0) / (2 * Math.PI)) * 64))
          for (let i = 0; i < n; i++) {
            const t0 = a0 + ((a1 - a0) * i) / n
            const t1 = a0 + ((a1 - a0) * (i + 1)) / n
            seg(dst, to3(e.c[0] + e.r * Math.cos(t0), e.c[1] + e.r * Math.sin(t0)), to3(e.c[0] + e.r * Math.cos(t1), e.c[1] + e.r * Math.sin(t1)))
          }
        }
      }
      const used = doc.features.some((f) => sketchesOf(f).includes(s.name))
      out.push({ name: s.name, ok: sk.ok, dof: sk.dof, used, lines: new Float32Array(lines), construction: new Float32Array(construction) })
    }
    return out
  }

  /** Triangle meshes of the visible bodies; unchanged bodies are reused. */
  meshes(result: BuildResult, tolerance = 0.05): MeshData[] {
    const out: MeshData[] = []
    const live = new Set<string>()
    for (const name of result.bodies) {
      const c = this.cache.get(name)
      if (!c) continue
      // Paint shows in the source project's filament colors: they are part of the key.
      const palette = isMesh(c.shape) ? this.sourceOf(name)?.file.filaments.join(',') ?? '' : ''
      const key = c.key + '#' + name + '#' + palette
      live.add(key)
      let m = this.meshCache.get(key)
      if (!m && isMesh(c.shape)) {
        const d = displayMesh(c.shape, 30, this.paintColors(name))
        m = { name, key, vertices: d.vertices, normals: d.normals, triangles: d.triangles, edges: d.edges, edgeGroups: new Uint32Array(0), faceGroups: new Uint32Array([0, d.triangles.length / 3]), ...(d.colors ? { colors: d.colors } : {}) }
        this.meshCache.set(key, m)
      }
      if (!m) {
        const shape = c.shape as Shape3D
        // Vendor models (imports, part models) carry tiny fillets and text:
        // a looser tolerance keeps them light (a few thousand triangles, not
        // hundreds of thousands) and still looks right at viewing scale.
        const vendor = c.status.type === 'import'
        const tol = vendor ? Math.max(tolerance, 0.03 * Math.cbrt(Math.max(c.status.volume ?? 1, 1))) : tolerance
        const ang = vendor ? 0.5 : 0.2
        const mesh = shape.mesh({ tolerance: tol, angularTolerance: ang })
        const edges = vendor ? { lines: [] as number[], edgeGroups: [] as { start: number; count: number }[] } : shape.meshEdges({ tolerance, angularTolerance: 0.2 })
        const egroups = new Uint32Array(edges.edgeGroups.length * 2)
        edges.edgeGroups.forEach((g, i) => {
          egroups[i * 2] = g.start
          egroups[i * 2 + 1] = g.count
        })
        const groups = new Uint32Array(mesh.faceGroups.length * 2)
        mesh.faceGroups.forEach((g, i) => {
          groups[i * 2] = g.start
          groups[i * 2 + 1] = g.count
        })
        m = {
          name,
          key,
          vertices: new Float32Array(mesh.vertices),
          normals: new Float32Array(mesh.normals),
          triangles: new Uint32Array(mesh.triangles),
          edges: new Float32Array(edges.lines),
          edgeGroups: egroups,
          faceGroups: groups,
        }
        this.meshCache.set(key, m)
      }
      const f = this.doc?.features.find((x) => x.name === name)
      const color = f?.color ?? (name === BOARD && this.doc?.pcb ? boardStyle(this.doc.pcb).maskColor : name.startsWith(PART_PREFIX) ? '#30343b' : m.colors ? this.filamentOf(name) : undefined)
      const material = f?.material ? this.doc?.materials?.find((x) => x.name === f.material) : undefined
      const decals = this.resolvedDecals(name)
      const explode = this.doc ? explodeOffset(this.doc, this.params, name) : undefined
      out.push({ ...m, name, color, opacity: f?.opacity, ...(material ? { material } : {}), ...(decals.length ? { decals } : {}), ...(explode ? { explode } : {}) })
    }
    for (const k of [...this.meshCache.keys()]) if (!live.has(k)) this.meshCache.delete(k)
    return out
  }

  /** Decals on a body with their expressions resolved; bad ones are skipped (build reports them). */
  private resolvedDecals(target: string): ResolvedDecal[] {
    const out: ResolvedDecal[] = []
    for (const d of this.doc?.decals ?? []) {
      if (d.target !== target) continue
      try {
        out.push(resolveDecal(d, this.params))
      } catch {
        // reported by appearanceStatus
      }
    }
    return out
  }

  /** Problems with materials and decals, for the build result and the model. */
  appearanceStatus(doc: Doc): string[] {
    const problems: string[] = []
    const names = new Set(doc.features.map((f) => f.name))
    const bodySet = new Set(bodies(doc).map((f) => f.name))
    for (const f of doc.features) {
      if (f.material && !doc.materials?.some((m) => m.name === f.material)) problems.push(`feature "${f.name}" uses material "${f.material}", which does not exist`)
    }
    for (const d of doc.decals ?? []) {
      if (!names.has(d.target)) problems.push(`decal "${d.name}": target "${d.target}" does not exist`)
      else if (!bodySet.has(d.target)) problems.push(`decal "${d.name}": "${d.target}" is not a visible body (it is used by a later feature); put the decal on the final body`)
      try {
        resolveDecal(d, this.params)
      } catch (e) {
        problems.push(`decal "${d.name}": ${(e as Error).message}`)
      }
    }
    return problems
  }

  faces(name: string, sel?: Selector): FaceInfo[] {
    const s = this.shape(name)
    try {
      const { all, picked } = selectIndexed(s, sel, true, this.params)
      return picked.map((i) => {
        const f = all[i] as Face
        return {
        index: i,
        type: friendlyType(f.geomType),
        center: r3(centerOf(f)),
        normal: (() => {
          const d = directionOf(f, true)
          return d ? r3(d) : undefined
        })(),
        area: round(R.measureArea(f), 3),
        }
      })
    } finally {
      s.delete()
    }
  }

  edges(name: string, sel?: Selector): EdgeInfo[] {
    const s = this.shape(name)
    try {
      const { all, picked } = selectIndexed(s, sel, false, this.params)
      return picked.map((i) => {
        const e = all[i] as Edge
        return {
          index: i,
          type: friendlyType(e.geomType),
          start: r3(e.startPoint.toTuple() as V3),
          end: r3(e.endPoint.toTuple() as V3),
          length: round(e.length, 3),
        }
      })
    } finally {
      s.delete()
    }
  }

  /** Distance between two built features: OpenCascade for two B-rep solids, meshes when either is a mesh. */
  /** @internal */
  distanceOf(a: string, b: string): number {
    if (this.isMeshBody(a) || this.isMeshBody(b)) {
      const [ma, mb] = [this.meshOf(a), this.meshOf(b)]
      try {
        return ma.distance(mb)
      } finally {
        ma.delete()
        mb.delete()
      }
    }
    const [sa, sb] = [this.shape(a), this.shape(b)]
    try {
      return safeDistance(sa, sb)
    } finally {
      sa.delete()
      sb.delete()
    }
  }

  /** @internal */
  overlapOf(a: string, b: string): { volume: number; regions: { box: [V3, V3]; volume: number }[] } {
    if (this.isMeshBody(a) || this.isMeshBody(b)) {
      const [ma, mb] = [this.meshOf(a), this.meshOf(b)]
      try {
        const o = ma.overlap(mb)
        return { volume: o.volume, regions: o.regions.map((r) => ({ box: [r3(r.box[0]), r3(r.box[1])] as [V3, V3], volume: round(r.volume, 4) })) }
      } finally {
        ma.delete()
        mb.delete()
      }
    }
    const [sa, sb] = [this.shape(a), this.shape(b)]
    try {
      return overlapRegions(sa, sb)
    } finally {
      sa.delete()
      sb.delete()
    }
  }

  measure(a: string, b?: string): Record<string, unknown> {
    if (this.isMeshBody(a)) {
      const m = this.meshOf(a)
      try {
        const [lo, hi] = bodyBox(m)
        const out: Record<string, unknown> = {
          name: a,
          bbox: [lo, hi],
          size: r3([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]),
          volume: round(m.volume(), 3),
          area: round(m.area(), 3),
          center_of_mass: r3(m.centerOfMass()),
          triangles: m.triangles,
        }
        if (b) {
          out.other = b
          out.distance = round(this.distanceOf(a, b), 4)
          out.overlap_volume = round(this.overlapOf(a, b).volume, 4)
        }
        return out
      } finally {
        m.delete()
      }
    }
    const sa = this.shape(a)
    try {
      const out: Record<string, unknown> = {
        name: a,
        bbox: bboxOf(sa),
        size: (() => {
          const [lo, hi] = bboxOf(sa)
          return r3([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]])
        })(),
        volume: round(volumeOf(sa), 3),
        area: round(R.measureArea(sa), 3),
      }
      try {
        const props = R.measureShapeVolumeProperties(sa)
        out.center_of_mass = r3(props.centerOfMass as V3)
      } catch {
        // not a solid
      }
      if (b) {
        out.other = b
        out.distance = round(this.distanceOf(a, b), 4)
        out.overlap_volume = round(this.overlapOf(a, b).volume, 4)
      }
      return out
    } finally {
      sa.delete()
    }
  }

  /**
   * Distance between two things, each a feature name or a point [x, y, z]:
   * the minimum distance, and for two points the vector between them.
   */
  between(a: string | V3, b: string | V3): Record<string, unknown> {
    const isPt = (v: string | V3): v is V3 => Array.isArray(v)
    if (isPt(a) && isPt(b)) {
      const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      return { distance: round(Math.hypot(...d), 4), delta: r3(d), from: a, to: b }
    }
    const meshy = (!isPt(a) && this.isMeshBody(a)) || (!isPt(b) && this.isMeshBody(b))
    if (meshy) {
      if (!isPt(a) && !isPt(b)) {
        const ov = this.overlapOf(a, b)
        const out: Record<string, unknown> = { a, b, distance: round(this.distanceOf(a, b), 4), overlap_volume: round(ov.volume, 4) }
        if (ov.volume > 1e-6) out.overlap = ov.regions.slice(0, 8)
        return out
      }
      const pt = (isPt(a) ? a : b) as V3
      const name = (isPt(a) ? b : a) as string
      const probe = meshCube([pt[0] - 1e-4, pt[1] - 1e-4, pt[2] - 1e-4], [pt[0] + 1e-4, pt[1] + 1e-4, pt[2] + 1e-4])
      const m = this.meshOf(name)
      try {
        const inside = m.overlap(probe).volume > 0
        const out: Record<string, unknown> = { a, b, distance: inside ? 0 : round(Math.max(0, m.distance(probe) - 1e-4), 4) }
        if (out.distance === 0) out.note = 'the point is on or inside the feature'
        return out
      } finally {
        m.delete()
        probe.delete()
      }
    }
    const shape = (v: string | V3) => (isPt(v) ? (R.makeSphere(1e-4).translate(v[0], v[1], v[2]) as Shape3D) : this.shape(v))
    const sa = shape(a)
    const sb = shape(b)
    try {
      const out: Record<string, unknown> = { a, b, distance: round(Math.max(0, safeDistance(sa, sb) - (isPt(a) || isPt(b) ? 1e-4 : 0)), 4) }
      if (!isPt(a) && !isPt(b)) {
        const ov = overlapRegions(sa, sb)
        out.overlap_volume = round(ov.volume, 4)
        // Where they clash: one box per separate piece of the overlap (largest first).
        if (ov.volume > 1e-6) out.overlap = ov.regions.slice(0, 8)
      }
      if (out.distance === 0 && (isPt(a) || isPt(b))) out.note = 'the point is on or inside the feature'
      return out
    } finally {
      sa.delete()
      sb.delete()
    }
  }

  /** Results of pairwise body checks by the bodies' build keys: unchanged pairs are not intersected again. */
  private pairCache = new Map<string, number>()

  /** Cached pairwise measure (overlap volume or distance); boxes that are apart skip OpenCascade. */
  /** @internal */
  pair(kind: 'overlap' | 'distance', a: string, b: string, compute: () => number, min = 0): number {
    const ca = this.cache.get(a)
    const cb = this.cache.get(b)
    if (!ca || !cb) return compute()
    // Board bodies share one build key: the names make the pair unique.
    const key = `${kind}|${a}|${ca.key}|${b}|${cb.key}|${min}`
    const hit = this.pairCache.get(key)
    if (hit !== undefined) return hit
    let v: number | undefined
    const ba = ca.status.bbox
    const bb = cb.status.bbox
    if (ba && bb) {
      // Gap between the boxes: > 0 means they cannot touch.
      const gap = boxGap(ba, bb)
      if (kind === 'overlap' && gap > 1e-3) v = 0
      // A distance check only needs the exact value when the boxes are closer than the limit.
      if (kind === 'distance' && gap > min + 1e-3) v = gap
    }
    if (v === undefined) v = compute()
    if (this.pairCache.size > 4000) this.pairCache.clear()
    this.pairCache.set(key, v)
    return v
  }

  /** @internal */
  boxApart(a: string, b: string, min: number): boolean {
    const ba = this.cache.get(a)?.status.bbox
    const bb = this.cache.get(b)?.status.bbox
    if (!ba || !bb) return false
    return boxGap(ba, bb) > min + 1e-3
  }

  checks(doc: Doc): CheckResult[] {
    return doc.checks.map((c) => {
      const t = Date.now()
      const r = this.check(c)
      const ms = Date.now() - t
      return ms >= 200 ? { ...r, ms } : r
    })
  }

  private check(c: Check): CheckResult {
    return runCheck(this, c)
  }

  /**
   * STEP or STL of the named features (default: all bodies) in one file.
   * models replaces part_* blocks with the vendor meshes (OBJ text by
   * part ref), sewn into faces.
   */
  async export(format: 'step' | 'stl' | '3mf', names: string[], models: Record<string, string> = {}): Promise<Blob> {
    if (!names.length) throw new Error('nothing to export: the model has no bodies')
    if (format !== 'step') {
      // Triangles: mesh bodies as they are, B-rep bodies tessellated finely.
      const objects = names.map((n) => {
        const c = this.cache.get(n)
        if (!c) throw new Error(`no feature "${n}"`)
        let mesh: TriMesh
        if (isMesh(c.shape)) mesh = c.shape.triMesh()
        else {
          const m = (c.shape as Shape3D).mesh({ tolerance: 0.01, angularTolerance: 0.1 })
          mesh = { positions: Float32Array.from(m.vertices), triangles: Uint32Array.from(m.triangles) }
        }
        const f = this.doc?.features.find((x) => x.name === n)
        const material = f?.material ? this.doc?.materials?.find((x) => x.name === f.material) : undefined
        return { name: n, mesh, color: material?.color ?? f?.color }
      })
      return format === 'stl' ? writeSTL(objects.map((o) => o.mesh)) : write3MF(objects)
    }
    const meshy = names.filter((n) => this.isMeshBody(n))
    if (meshy.length) throw new Error(`${meshy.join(', ')} ${meshy.length === 1 ? 'is a triangle mesh' : 'are triangle meshes'} (imported STL / 3MF): STEP holds B-rep solids; export them as STL or 3MF, or leave them out with names`)
    const shapes = names.map((n) => {
      const ref = n.startsWith(PART_PREFIX) ? n.slice(PART_PREFIX.length) : undefined
      const obj = ref ? models[ref] : undefined
      const c = ref ? this.board?.components.find((x) => x.ref === ref) : undefined
      if (obj && c?.footprint.model && this.board) {
        try {
          return meshShape(obj, c.footprint.model, c, this.board)
        } catch {
          // fall back to the block
        }
      }
      return this.shape(n)
    })
    // One named product per body (instances included), with its color, so an assembly opens as parts in other CAD tools.
    try {
      return R.exportSTEP(
        shapes.map((shape, i) => {
          const f = this.doc?.features.find((x) => x.name === names[i])
          const material = f?.material ? this.doc?.materials?.find((x) => x.name === f.material) : undefined
          const color = material?.color ?? f?.color
          return { shape, name: names[i], ...(color && /^#[0-9a-f]{6}$/i.test(color) ? { color } : {}) }
        }),
      )
    } finally {
      for (const s of shapes) s.delete()
    }
  }

  /**
   * The slicer project a 3MF import came from, with some of its objects'
   * meshes replaced by built bodies: for each pair, the body's triangles
   * (with the paint that followed them) take the place of the 3MF object
   * that the import names. Everything else in the file stays.
   */
  async update3MF(doc: Doc, pairs: { body: string; object: string }[]): Promise<{ blob: Blob; file: string; replaced: string[]; also_changed: string[] }> {
    const urls = new Set<string>()
    const replace: { id: string; mesh: TriMesh }[] = []
    let file: ThreeMF | undefined
    const objectNames = new Map<string, string>()
    for (const pr of pairs) {
      const f = doc.features.find((x) => x.name === pr.object)
      if (!f || f.type !== 'import') throw new Error(`"${pr.object}" is not an import feature; give the import of the 3MF object to replace (e.g. "cover")`)
      const key = fetchKey(f.url)
      if (!/\.3mf$/i.test(key)) throw new Error(`"${pr.object}" imports ${f.url}, not a 3MF; write back works only into a 3MF (use export for STL)`)
      urls.add(key)
      if (urls.size > 1) throw new Error('all objects must come from the same 3MF file')
      const opened = this.threeMF.get(key)
      if (!opened || opened instanceof Error) throw new Error(`${key} is not open: build the design first`)
      file = opened
      const obj = pickObject(opened, urlFragment(f.url), urlFile(f.url))
      const c = this.cache.get(pr.body)
      if (!c) throw new Error(`no body "${pr.body}"`)
      let mesh: TriMesh
      if (isMesh(c.shape)) mesh = c.shape.triMesh()
      else {
        const m = this.meshOf(pr.body)
        mesh = m.triMesh()
        m.delete()
      }
      replace.push({ id: obj.id, mesh })
      objectNames.set(obj.id, obj.name)
    }
    if (!file) throw new Error('nothing to write: give body/object pairs')
    const { blob, touched } = await update3MF(file.raw, replace)
    const asked = new Set(replace.map((r) => r.id))
    const name = (id: string) => `#${id} (${file!.objects.find((o) => o.id === id)?.name ?? '?'})`
    return { blob, file: [...urls][0], replaced: [...asked].map(name), also_changed: touched.filter((t) => !asked.has(t)).map(name) }
  }

  /**
   * Hidden-line views of bodies, in view coordinates (mm, y up): front looks
   * along +Y, top down -Z, right along -X (third-angle), iso from (1, -1, 1).
   */
  views(names: string[], views: string[]): View[] {
    if (!names.length) throw new Error('nothing to draw: the model has no bodies')
    const meshy = names.filter((n) => this.isMeshBody(n))
    if (meshy.length) throw new Error(`${meshy.join(', ')} ${meshy.length === 1 ? 'is a triangle mesh' : 'are triangle meshes'}: drawings need B-rep edges; leave ${meshy.length === 1 ? 'it' : 'them'} out with names, or use section`)
    const shapes = names.map((n) => this.shape(n))
    const all = shapes.length === 1 ? shapes[0] : (R.makeCompound(shapes) as Shape3D)
    try {
      const planes: Record<string, R.ProjectionPlane> = { front: 'front', back: 'back', top: 'top', bottom: 'bottom', left: 'left', right: 'right' }
      return views.map((name) => {
        let cam: R.ProjectionPlane | R.ProjectionCamera
        if (name === 'iso') {
          const [lo, hi] = bboxOf(all)
          const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
          const far = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 2 + 10
          cam = new R.ProjectionCamera([c[0] + far, c[1] - far, c[2] + far], [-1, 1, -1], [1, 1, 0])
        } else if (planes[name]) cam = planes[name]
        else throw new Error(`unknown view "${name}"; use front, back, top, bottom, left, right or iso`)
        const { visible, hidden } = R.drawProjection(all, cam)
        const vis = pathsToLines(visible.toSVGPaths().flat())
        const hid = pathsToLines(hidden.toSVGPaths().flat())
        return { name, visible: vis, hidden: hid, box: boxOf(vis.length ? vis : hid) }
      })
    } finally {
      all.delete()
    }
  }

  /** A flat outline as closed loops in its own (u, v): a solved sketch, or one flat face of a built B-rep body. */
  profile(source: ProfileSource): { loops: [number, number][][]; frame?: SketchFrame } {
    if ('sketch' in source) {
      const sk = this.sketch(source.sketch)
      const d = sketchDrawing(sk, `sketch ${source.sketch}`)
      return { loops: pathsToLines(d.toSVGPaths().flat()) as [number, number][][] }
    }
    const frame = this.faceFrame(source.feature, source.face, 0, 'export_dxf')
    const s = this.shape(source.feature)
    try {
      const { all, picked } = selectIndexed(s, source.face, true, this.params, 'export_dxf.face')
      const face = all[picked[0]] as R.Face
      // Project the face's edges on its own plane: (u, v) as in the frame.
      const loops: [number, number][][] = []
      // outerWire and innerWires consume the face they are called on: give each a copy.
      const wires = [(face.clone() as R.Face).outerWire(), ...(face.clone() as R.Face).innerWires()]
      for (const w of wires) {
        // Edges come in wire order but each with its own direction: walk each from the end that meets the previous one.
        const pts: [number, number][] = []
        const uv = (q: V3): [number, number] => {
          const d: V3 = [q[0] - frame.origin[0], q[1] - frame.origin[1], q[2] - frame.origin[2]]
          return [d[0] * frame.u[0] + d[1] * frame.u[1] + d[2] * frame.u[2], d[0] * frame.v[0] + d[1] * frame.v[1] + d[2] * frame.v[2]]
        }
        // Chain the edges by their ends (an edge's direction need not follow the wire).
        const runs = w.edges.map((e) => {
          const n = e.geomType === 'LINE' ? 1 : Math.max(8, Math.ceil(e.length / 0.25))
          const run: [number, number][] = []
          for (let i = 0; i <= n; i++) run.push(uv(e.pointAt(i / n).toTuple() as V3))
          return run
        })
        const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])
        const left = runs.slice(1)
        let chain = runs[0] ? [...runs[0]] : []
        // Start the first edge in the direction that meets one of the others.
        if (left.length && !left.some((r) => dist(r[0], chain[chain.length - 1]) < 1e-3 || dist(r[r.length - 1], chain[chain.length - 1]) < 1e-3)) chain.reverse()
        while (left.length) {
          const end = chain[chain.length - 1]
          let best = 0
          let flip = false
          let bd = Infinity
          left.forEach((r, i) => {
            const a = dist(r[0], end)
            const b = dist(r[r.length - 1], end)
            if (a < bd) [bd, best, flip] = [a, i, false]
            if (b < bd) [bd, best, flip] = [b, i, true]
          })
          const r = left.splice(best, 1)[0]
          chain = chain.concat((flip ? [...r].reverse() : r).slice(1))
        }
        pts.push(...chain)
        if (pts.length) {
          const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-4
          loops.push((closed ? pts : [...pts, pts[0]]).map(([a, b]) => [Math.round(a * 1e4) / 1e4 + 0, Math.round(b * 1e4) / 1e4 + 0]))
        }
      }
      return { loops, frame }
    } finally {
      s.delete()
    }
  }

  get parameters(): Map<string, number> {
    return this.params
  }
}


