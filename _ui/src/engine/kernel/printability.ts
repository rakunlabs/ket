// Printability checks on a body's triangles: overhangs that need support,
// and walls thinner than a printer can make. Both work on B-rep and mesh
// bodies alike (B-rep solids are tessellated finely first).

import type { TriMesh } from '../model-files'
import type { BBox, V3 } from './types'

export type PrintAxis = '+Z' | '-Z' | '+X' | '-X' | '+Y' | '-Y'

const AXIS: Record<PrintAxis, V3> = { '+Z': [0, 0, 1], '-Z': [0, 0, -1], '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0] }

const r2 = (v: number) => Math.round(v * 100) / 100

interface Tri {
  a: V3
  b: V3
  c: V3
  n: V3
  area: number
}

function triangles(m: TriMesh): Tri[] {
  const p = m.positions
  const out: Tri[] = []
  for (let i = 0; i < m.triangles.length; i += 3) {
    const ia = m.triangles[i] * 3
    const ib = m.triangles[i + 1] * 3
    const ic = m.triangles[i + 2] * 3
    const a: V3 = [p[ia], p[ia + 1], p[ia + 2]]
    const b: V3 = [p[ib], p[ib + 1], p[ib + 2]]
    const c: V3 = [p[ic], p[ic + 1], p[ic + 2]]
    const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const x: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const len = Math.hypot(x[0], x[1], x[2])
    if (len < 1e-12) continue
    out.push({ a, b, c, n: [x[0] / len, x[1] / len, x[2] / len], area: len / 2 })
  }
  return out
}

function boxOf(points: V3[]): BBox {
  const lo: V3 = [Infinity, Infinity, Infinity]
  const hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k])
      hi[k] = Math.max(hi[k], p[k])
    }
  return [lo.map(r2) as V3, hi.map(r2) as V3]
}

export interface Region {
  box: BBox
  /** Area (overhang, mm²) or thickness (wall, mm). */
  value: number
}

/**
 * Overhangs: surface facing down from the print direction more steeply
 * than angle (degrees from vertical; 45 is the usual limit without
 * support). Faces on the build plate are not overhangs. Regions are the
 * connected pieces of overhanging surface, largest first.
 */
export function overhangs(m: TriMesh, angle: number, axis: PrintAxis = '+Z'): { area: number; regions: Region[] } {
  const up = AXIS[axis]
  const tris = triangles(m)
  const along = (p: V3) => p[0] * up[0] + p[1] * up[1] + p[2] * up[2]
  let floor = Infinity
  for (const t of tris) floor = Math.min(floor, along(t.a), along(t.b), along(t.c))
  // A surface element overhangs by asin(-n·up) from vertical.
  const limit = Math.sin((angle * Math.PI) / 180)
  const over: number[] = []
  tris.forEach((t, i) => {
    const down = -(t.n[0] * up[0] + t.n[1] * up[1] + t.n[2] * up[2])
    if (down <= limit + 1e-9) return
    if (Math.max(along(t.a), along(t.b), along(t.c)) - floor < 0.01) return
    over.push(i)
  })
  // Connected pieces: triangles that share a vertex (by position).
  const key = (p: V3) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`
  const parent = over.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const owner = new Map<string, number>()
  over.forEach((ti, i) => {
    const t = tris[ti]
    for (const p of [t.a, t.b, t.c]) {
      const k = key(p)
      const j = owner.get(k)
      if (j === undefined) owner.set(k, i)
      else parent[find(i)] = find(j)
    }
  })
  const groups = new Map<number, number[]>()
  over.forEach((ti, i) => {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(ti)
  })
  let area = 0
  const regions: Region[] = []
  for (const list of groups.values()) {
    let a = 0
    const pts: V3[] = []
    for (const ti of list) {
      a += tris[ti].area
      pts.push(tris[ti].a, tris[ti].b, tris[ti].c)
    }
    area += a
    regions.push({ box: boxOf(pts), value: r2(a) })
  }
  regions.sort((x, y) => y.value - x.value)
  return { area, regions }
}

/** Triangles binned in a uniform grid, for rays of bounded length. */
class Grid {
  private cells = new Map<string, number[]>()

  constructor(
    private tris: Tri[],
    private size: number,
  ) {
    tris.forEach((t, i) => {
      const lo = [0, 1, 2].map((k) => Math.floor(Math.min(t.a[k], t.b[k], t.c[k]) / size))
      const hi = [0, 1, 2].map((k) => Math.floor(Math.max(t.a[k], t.b[k], t.c[k]) / size))
      // A huge triangle spans many cells; cap the work and keep it in a shared list.
      if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 4096) {
        this.add('big', i)
        return
      }
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) this.add(`${x},${y},${z}`, i)
    })
  }

  private add(k: string, i: number) {
    let l = this.cells.get(k)
    if (!l) this.cells.set(k, (l = []))
    l.push(i)
  }

  /** Distance along dir from o to the nearest triangle that the ray leaves the material through, up to max. */
  exit(o: V3, dir: V3, max: number, self: number): number | undefined {
    const e: V3 = [o[0] + dir[0] * max, o[1] + dir[1] * max, o[2] + dir[2] * max]
    const lo = [0, 1, 2].map((k) => Math.floor(Math.min(o[k], e[k]) / this.size))
    const hi = [0, 1, 2].map((k) => Math.floor(Math.max(o[k], e[k]) / this.size))
    const seen = new Set<number>()
    let best: number | undefined
    const test = (list: number[] | undefined) => {
      for (const i of list ?? []) {
        if (i === self || seen.has(i)) continue
        seen.add(i)
        const t = this.tris[i]
        // Only a face whose outside the ray reaches leaves the material.
        if (t.n[0] * dir[0] + t.n[1] * dir[1] + t.n[2] * dir[2] <= 1e-6) continue
        const d = hit(o, dir, t)
        if (d !== undefined && d > 1e-5 && d <= max && (best === undefined || d < best)) best = d
      }
    }
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) test(this.cells.get(`${x},${y},${z}`))
    test(this.cells.get('big'))
    return best
  }
}

/** Möller–Trumbore: distance along dir to the triangle, or undefined. */
function hit(o: V3, d: V3, t: Tri): number | undefined {
  const e1: V3 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]]
  const e2: V3 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]]
  const p: V3 = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]]
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2]
  if (Math.abs(det) < 1e-12) return undefined
  const inv = 1 / det
  const s: V3 = [o[0] - t.a[0], o[1] - t.a[1], o[2] - t.a[2]]
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv
  if (u < -1e-9 || u > 1 + 1e-9) return undefined
  const q: V3 = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]]
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv
  if (v < -1e-9 || u + v > 1 + 1e-9) return undefined
  return (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv
}

/**
 * Thin walls: from points spread over the surface, a ray goes straight
 * into the material and measures how far it is to the other side. Points
 * where that is under min are thin. This samples, so a thin spot between
 * samples can be missed: spacing says how far apart they are.
 */
export function thinWalls(m: TriMesh, min: number, maxSamples = 40_000): { samples: number; spacing: number; thinnest?: number; regions: Region[] } {
  const tris = triangles(m)
  const total = tris.reduce((s, t) => s + t.area, 0)
  // Spacing: fine enough to see a wall of width min, coarse enough to stay within maxSamples.
  const spacing = Math.max(min / 2, Math.sqrt(total / maxSamples))
  const reach = min * 1.5
  const grid = new Grid(tris, Math.max(reach, 0.5))
  let samples = 0
  let thinnest: number | undefined
  const thin: { p: V3; d: number }[] = []
  tris.forEach((t, ti) => {
    // Barycentric grid with about one point per spacing²; at least the centroid.
    const k = Math.max(1, Math.min(64, Math.round(Math.sqrt(t.area / (spacing * spacing)))))
    for (let i = 0; i < k; i++)
      for (let j = 0; j < k - i; j++) {
        const u = (i + 1 / 3) / k
        const v = (j + 1 / 3) / k
        const w = 1 - u - v
        const p: V3 = [t.a[0] * w + t.b[0] * u + t.c[0] * v, t.a[1] * w + t.b[1] * u + t.c[1] * v, t.a[2] * w + t.b[2] * u + t.c[2] * v]
        const dir: V3 = [-t.n[0], -t.n[1], -t.n[2]]
        samples++
        const d = grid.exit(p, dir, reach, ti)
        if (d === undefined) continue
        if (thinnest === undefined || d < thinnest) thinnest = d
        if (d < min - 1e-6) thin.push({ p, d })
      }
  })
  // Group thin points that lie within two spacings of each other (cells of that size, union-find).
  const near = spacing * 2
  const cell = (q: V3) => q.map((v) => Math.floor(v / near))
  const bins = new Map<string, number[]>()
  thin.forEach((s, i) => {
    const k = cell(s.p).join(',')
    if (!bins.has(k)) bins.set(k, [])
    bins.get(k)!.push(i)
  })
  const parent = thin.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  thin.forEach((s, i) => {
    const [cx, cy, cz] = cell(s.p)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of bins.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (j >= i) continue
            const q = thin[j].p
            if (Math.hypot(q[0] - s.p[0], q[1] - s.p[1], q[2] - s.p[2]) <= near) parent[find(i)] = find(j)
          }
  })
  const groups = new Map<number, { pts: V3[]; d: number }>()
  thin.forEach((s, i) => {
    const r = find(i)
    const g = groups.get(r)
    if (g) {
      g.pts.push(s.p)
      g.d = Math.min(g.d, s.d)
    } else groups.set(r, { pts: [s.p], d: s.d })
  })
  const regions = [...groups.values()].map((g) => ({ box: boxOf(g.pts), value: r2(g.d) })).sort((x, y) => x.value - y.value)
  return { samples, spacing: r2(spacing), thinnest: thinnest === undefined ? undefined : r2(thinnest), regions }
}
