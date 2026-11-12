// Small helpers on built bodies: boxes, volumes, distances, overlaps, vector math.

import * as R from 'replicad'
import type { AnyShape, Shape3D } from 'replicad'

import type { Doc } from '../doc'
import { MeshBody, meshFromTriangles } from '../mesh-body'
import type { TriMesh } from '../model-files'
import type { BBox, V3 } from './types'

export function meshCenter(m: { vertices: Float32Array }): [number, number, number] {
  let x = 0
  let y = 0
  let z = 0
  const n = m.vertices.length / 3
  for (let i = 0; i < n; i++) {
    x += m.vertices[i * 3]
    y += m.vertices[i * 3 + 1]
    z += m.vertices[i * 3 + 2]
  }
  return [x / n, y / n, z / n]
}
/** A built feature: an OpenCascade solid, or a triangle-mesh solid (imported STL / 3MF and what is built from it). */
export type Body = Shape3D | MeshBody

export const isMesh = (b: Body): b is MeshBody => b instanceof MeshBody

/** STL files up to this size also become OpenCascade solids (faces to select, part models). */
export const SOLID_STL_TRIANGLES = 20_000

/** A downloaded model file, by URL (with #fragment). */
export type Loaded = { shape: Shape3D } | { tri: TriMesh; solid?: Shape3D | Error; mesh?: MeshBody }

/** Every model URL a document imports (import features and board part models). */
export function importUrls(doc: Doc): Set<string> {
  return new Set([...doc.features.flatMap((f) => (f.type === 'import' ? [f.url] : [])), ...(doc.pcb?.components ?? []).flatMap((c) => (c.model ? [c.model.url] : []))])
}

/** The triangles of a B-rep solid as a mesh body (fine tessellation: booleans with meshes, mesh checks). */
export function brepToMesh(s: Shape3D, what: string): MeshBody {
  const m = s.mesh({ tolerance: 0.01, angularTolerance: 0.1 })
  return meshFromTriangles(m.vertices, m.triangles, what)
}

/** True when two boxes are more than tol apart on some axis. */
export function boxesApart(a: BBox, b: BBox, tol = 0): boolean {
  return a[0].some((lo, k) => lo > b[1][k] + tol || b[0][k] > a[1][k] + tol)
}

/** The gap between two boxes (0 when they touch or overlap). */
export function boxGap(a: BBox, b: BBox): number {
  let gap = 0
  for (let k = 0; k < 3; k++) gap = Math.max(gap, a[0][k] - b[1][k], b[0][k] - a[1][k])
  return gap
}

export function bodyBox(b: Body): BBox {
  if (isMesh(b)) {
    const [lo, hi] = b.bbox()
    return [r3(lo), r3(hi)]
  }
  return bboxOf(b)
}

export function bodyVolume(b: Body): number {
  return isMesh(b) ? b.volume() : volumeOf(b)
}
export const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d
export const r3 = (v: V3): V3 => [round(v[0]), round(v[1]), round(v[2])]

/** Number of distinct faces or edges, without building wrapper objects for each. */
export function countTopo(s: AnyShape, kind: 'face' | 'edge'): number {
  let n = 0
  for (const e of R.iterTopo(s.wrapped, kind)) {
    n++
    ;(e as { delete?: () => void }).delete?.()
  }
  return n
}

/** Boxes of big shapes, by the TopoDS_Shape they wrap (cleared when shapes are rebuilt). */
export const bigBoxes = new WeakMap<object, BBox>()

/** Faces met by a topology walk, stopping after limit (no dedupe, no wrappers: fast). */
export function faceCount(s: AnyShape, limit = Infinity): number {
  const oc = R.getOC()
  let n = 0
  const ex = new oc.TopExp_Explorer(s.wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
  for (; ex.More() && n <= limit; ex.Next()) n++
  ex.delete()
  return n
}

export function bboxOf(s: AnyShape): BBox {
  const hit = bigBoxes.get(s.wrapped)
  if (hit) return hit
  // The exact box (AddOptimal) walks every surface: seconds for a vendor
  // STEP model. The box from its triangulation is as good for checks.
  const oc = R.getOC()
  if (faceCount(s, 200) > 200) {
    const box = new oc.Bnd_Box()
    oc.BRepBndLib.Add(s.wrapped, box, true)
    const lo = box.CornerMin()
    const hi = box.CornerMax()
    const out: BBox = [r3([lo.X(), lo.Y(), lo.Z()]), r3([hi.X(), hi.Y(), hi.Z()])]
    lo.delete()
    hi.delete()
    box.delete()
    bigBoxes.set(s.wrapped, out)
    return out
  }
  const [a, b] = s.boundingBox.bounds as [V3, V3]
  return [r3(a), r3(b)]
}

export function volumeOf(s: Shape3D): number {
  try {
    return R.measureVolume(s)
  } catch {
    return 0
  }
}

/** OpenCascade throws WebAssembly exceptions without a message. */
export function kernelMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string') return e
  return 'OpenCascade could not compute this operation'
}
export const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
export const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2])
export const norm3 = (a: V3): V3 => mul3(a, 1 / (len3(a) || 1))
/** Drops points within tol of the outline (Ramer–Douglas–Peucker on a closed ring). */
export function simplifyRing(ring: [number, number][], tol: number): [number, number][] {
  const n = ring.length
  if (n <= 4 || tol <= 0) return ring
  // Anchor the ring at its two far-apart points (corners, not a point mid-edge); simplify both open runs.
  const cx = ring.reduce((s, p) => s + p[0], 0) / n
  const cy = ring.reduce((s, p) => s + p[1], 0) / n
  let first = 0
  for (let i = 1; i < n; i++) if (Math.hypot(ring[i][0] - cx, ring[i][1] - cy) > Math.hypot(ring[first][0] - cx, ring[first][1] - cy)) first = i
  ring = [...ring.slice(first), ...ring.slice(0, first)]
  let split = 1
  const d0 = (i: number) => Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1])
  for (let i = 2; i < n; i++) if (d0(i) > d0(split)) split = i
  const keep = new Uint8Array(n)
  keep[0] = keep[split] = 1
  const pt = (i: number) => ring[i % n]
  const stack: [number, number][] = [[0, split], [split, n]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const [ax, ay] = pt(a)
    const [bx, by] = pt(b)
    const len = Math.hypot(bx - ax, by - ay)
    let best = -1
    let far = tol
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pt(i)
      const e = len > 1e-12 ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len : Math.hypot(px - ax, py - ay)
      if (e > far) {
        far = e
        best = i
      }
    }
    if (best < 0) continue
    keep[best % n] = 1
    stack.push([a, best], [best, b])
  }
  return ring.filter((_, i) => keep[i])
}
export function safeDistance(a: Shape3D, b: Shape3D): number {
  try {
    return R.measureDistanceBetween(a, b)
  } catch {
    return Infinity
  }
}

/** The overlap of two solids: its volume and each separate piece's box and volume. */
export function overlapRegions(a: Shape3D, b: Shape3D): { volume: number; regions: { box: [V3, V3]; volume: number }[] } {
  try {
    const i = (a.clone() as Shape3D).intersect(b.clone() as Shape3D) as Shape3D
    const volume = volumeOf(i)
    const regions: { box: [V3, V3]; volume: number }[] = []
    if (volume > 1e-6) {
      const solids = (i as unknown as { solids?: Shape3D[] }).solids ?? [i]
      for (const s of solids as Shape3D[]) {
        const v = volumeOf(s)
        if (v < 1e-6) continue
        const [lo, hi] = bboxOf(s)
        regions.push({ box: [r3(lo), r3(hi)], volume: round(v, 4) })
      }
      regions.sort((x, y) => y.volume - x.volume)
    }
    i.delete()
    return { volume, regions }
  } catch {
    return { volume: 0, regions: [] }
  }
}

export function overlapVolume(a: Shape3D, b: Shape3D): number {
  try {
    const i = (a.clone() as Shape3D).intersect(b.clone() as Shape3D) as Shape3D
    const v = volumeOf(i)
    i.delete()
    return v
  } catch {
    return 0
  }
}

/** Axis and angle (degrees) of a unit quaternion x, y, z, w. */
export function quatAxisAngle(q: [number, number, number, number]): { axis: V3; angle: number } {
  const w = Math.max(-1, Math.min(1, q[3]))
  const s = Math.sqrt(1 - w * w)
  if (s < 1e-12) return { axis: [0, 0, 1], angle: 0 }
  return { axis: [q[0] / s, q[1] / s, q[2] / s], angle: (2 * Math.acos(w) * 180) / Math.PI }
}
