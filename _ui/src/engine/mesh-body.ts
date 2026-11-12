// Mesh bodies: closed triangle meshes (STL, 3MF) as solids, through
// manifold-3d. They take booleans with each other and with B-rep bodies
// (which are tessellated for it), transforms, patterns, mirrors, checks and
// exports, at a few hundred thousand triangles where OpenCascade would
// stall. They have no faces or edges to select: fillet, chamfer and shell
// need B-rep bodies.

import type { Manifold, ManifoldToplevel } from 'manifold-3d'

import type { TriMesh } from './model-files'

type V3 = [number, number, number]
type BBox = [V3, V3]

let lib: ManifoldToplevel | undefined

/** Registers the loaded manifold-3d module (worker start, test setup). */
export function setManifoldLib(m: ManifoldToplevel) {
  lib = m
}

export function manifoldLib(): ManifoldToplevel {
  if (!lib) throw new Error('the mesh kernel (manifold-3d) is not loaded')
  return lib
}

/**
 * Slicer paint of the meshes bodies were made from, by manifold original ID:
 * a triangle of any later body that comes from that mesh keeps the paint of
 * the source triangle it is part of (faceID is the source triangle index).
 */
const painted = new Map<number, { paint: Uint32Array; paints: string[] }>()

const STATUS: Record<string, string> = {
  NotManifold: 'the triangles do not close into a solid (open edges, holes or edges shared by more than two triangles)',
  NonFiniteVertex: 'some vertices are not finite numbers',
  VertexOutOfBounds: 'a triangle uses a vertex that does not exist',
}

export class MeshBody {
  constructor(readonly m: Manifold) {}

  /** A copy that shares geometry (manifold transforms are lazy). */
  clone(): MeshBody {
    return new MeshBody(this.m.translate([0, 0, 0]))
  }

  delete() {
    this.m.delete()
  }

  get triangles(): number {
    return this.m.numTri()
  }

  bbox(): BBox {
    const b = this.m.boundingBox()
    return [[...b.min] as V3, [...b.max] as V3]
  }

  volume(): number {
    return this.m.volume()
  }

  area(): number {
    return this.m.surfaceArea()
  }

  /** Separate solids (enclosed voids, like magnet pockets, are not counted). */
  solids(): number {
    if (this.m.numTri() > 3_000_000) return 1
    const parts = this.m.decompose()
    let n = 0
    for (const p of parts) {
      if (p.volume() > 0) n++
      p.delete()
    }
    return Math.max(1, n)
  }

  /**
   * The separate solids, each with the voids enclosed in it (a magnet pocket
   * stays in its piece), in decompose order.
   */
  parts(): MeshBody[] {
    const pieces = this.m.decompose()
    const shells = pieces.filter((p) => p.volume() > 0)
    const voids = pieces.filter((p) => p.volume() <= 0)
    if (!voids.length) return shells.map((p) => new MeshBody(p))
    const box = (m: Manifold) => m.boundingBox()
    const within = (inner: Manifold, outer: Manifold) => {
      const a = box(inner)
      const b = box(outer)
      return [0, 1, 2].every((k) => a.min[k] >= b.min[k] - 1e-6 && a.max[k] <= b.max[k] + 1e-6)
    }
    const M = manifoldLib().Manifold
    return shells.map((s) => {
      const mine = voids.filter((v) => within(v, s))
      if (!mine.length) return new MeshBody(s)
      // A void is a shell turned inside out: composing them keeps it a hole.
      const out = M.compose([s, ...mine])
      s.delete()
      return new MeshBody(out)
    })
  }

  /** Volume-weighted center (tetrahedra from the origin). */
  centerOfMass(): V3 {
    const g = this.m.getMesh()
    const p = g.vertProperties
    const k = g.numProp
    const t = g.triVerts
    let v = 0
    let cx = 0
    let cy = 0
    let cz = 0
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * k
      const b = t[i + 1] * k
      const c = t[i + 2] * k
      const d = p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
      v += d
      cx += d * (p[a] + p[b] + p[c])
      cy += d * (p[a + 1] + p[b + 1] + p[c + 1])
      cz += d * (p[a + 2] + p[b + 2] + p[c + 2])
    }
    if (Math.abs(v) < 1e-12) return [0, 0, 0]
    return [cx / (4 * v), cy / (4 * v), cz / (4 * v)]
  }

  /** Rotates (X, then Y, then Z, degrees, about the origin) and translates; consumes this. */
  place(r: V3, t: V3): MeshBody {
    if (!r[0] && !r[1] && !r[2] && !t[0] && !t[1] && !t[2]) return this
    let m = this.m
    // manifold's rotate([x, y, z]) turns about global X, then Y, then Z: the same order as place().
    if (r[0] || r[1] || r[2]) m = m.rotate(r)
    if (t[0] || t[1] || t[2]) m = m.translate(t)
    this.m.delete()
    return new MeshBody(m)
  }

  /** Rotates by angle degrees about an axis through center; consumes this. */
  rotateAbout(angle: number, center: V3, axis: V3): MeshBody {
    const m = this.m.translate([-center[0], -center[1], -center[2]]).transform(rotationMatrix(axis, angle)).translate(center)
    this.m.delete()
    return new MeshBody(m)
  }

  translate(t: V3): MeshBody {
    const m = this.m.translate(t)
    this.m.delete()
    return new MeshBody(m)
  }

  scale(k: number): MeshBody {
    const m = this.m.scale(k)
    this.m.delete()
    return new MeshBody(m)
  }

  /** Mirrors across the plane with this normal through origin; consumes this. */
  mirror(normal: V3, origin: V3): MeshBody {
    const m = this.m.translate([-origin[0], -origin[1], -origin[2]]).mirror(normal).translate(origin)
    this.m.delete()
    return new MeshBody(m)
  }

  /** Boolean with others; consumes this and them. */
  boolean(op: 'union' | 'cut' | 'intersect', others: MeshBody[]): MeshBody {
    const M = manifoldLib().Manifold
    const out = op === 'intersect' ? M.intersection([this.m, ...others.map((o) => o.m)]) : op === 'union' ? M.union([this.m, ...others.map((o) => o.m)]) : undefined
    let result: Manifold
    if (out) result = out
    else {
      const tool = others.length === 1 ? others[0].m : M.union(others.map((o) => o.m))
      result = this.m.subtract(tool)
      if (others.length > 1) tool.delete()
    }
    this.m.delete()
    for (const o of others) o.m.delete()
    const st = result.status()
    if (st !== 'NoError') throw new Error(`the mesh ${op} failed: ${STATUS[st] ?? st}`)
    return new MeshBody(result)
  }

  /** Volume of the overlap with another body. */
  overlap(other: MeshBody): { volume: number; regions: { box: BBox; volume: number }[] } {
    const i = this.m.intersect(other.m)
    try {
      const volume = Math.max(0, i.volume())
      const regions: { box: BBox; volume: number }[] = []
      if (volume > 1e-6 && i.numTri() < 2_000_000) {
        for (const p of i.decompose()) {
          const v = p.volume()
          const b = p.boundingBox()
          if (v > 1e-6) regions.push({ box: [[...b.min] as V3, [...b.max] as V3], volume: v })
          p.delete()
        }
        regions.sort((x, y) => y.volume - x.volume)
      }
      return { volume, regions }
    } finally {
      i.delete()
    }
  }

  /** Smallest distance to another body (0 when they touch or overlap). */
  distance(other: MeshBody): number {
    const [la, ha] = this.bbox()
    const [lb, hb] = other.bbox()
    let gap = 0
    for (let k = 0; k < 3; k++) gap = Math.max(gap, la[k] - hb[k], lb[k] - ha[k])
    // minGap only looks within searchLength: start just past the box gap and widen.
    let search = Math.max(gap * 1.8, 1)
    for (let i = 0; i < 12; i++) {
      const d = this.m.minGap(other.m, search)
      if (d < search - 1e-9) return Math.max(0, d)
      search *= 4
    }
    return gap
  }

  /**
   * The cut of the body by a plane normal to an axis at a coordinate: closed
   * outlines in the plane's own (u, v) coordinates (X: (y, z), Y: (x, z), Z: (x, y)).
   */
  section(axis: 'X' | 'Y' | 'Z', at: number): { outlines: [number, number][][]; area: number } {
    // manifold slices across Z: rotate the axis onto Z (proper rotations, so the solid stays outward), then read u, v back.
    // X: (x, y, z) → (y, z, x); Y: (x, y, z) → (x, -z, y).
    const m = axis === 'Z' ? this.m : axis === 'X' ? this.m.transform([0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]) : this.m.transform([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1])
    const cs = m.slice(at)
    try {
      const polys = cs.toPolygons().map((ring) => ring.map((p) => (axis === 'Y' ? [p[0], -p[1]] : [p[0], p[1]]) as [number, number]))
      return { outlines: polys, area: cs.area() }
    } finally {
      cs.delete()
      if (m !== this.m) m.delete()
    }
  }

  /**
   * Triangles in place (welded), for export; with paint when they come from
   * a painted mesh. Triangles from elsewhere (a cut's new walls and floors)
   * get the paint of the nearest painted triangle around them with a similar
   * facing, so a new pocket wall takes the wall color.
   */
  triMesh(): TriMesh {
    const g = this.m.getMesh()
    const k = g.numProp
    const n = g.vertProperties.length / k
    const positions = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      positions[i * 3] = g.vertProperties[i * k]
      positions[i * 3 + 1] = g.vertProperties[i * k + 1]
      positions[i * 3 + 2] = g.vertProperties[i * k + 2]
    }
    const out: TriMesh = { positions, triangles: new Uint32Array(g.triVerts) }
    const sources = [...g.runOriginalID].map((id) => painted.get(id))
    if (!sources.some(Boolean)) return out
    const paints = ['']
    const index = new Map<string, number>([['', 0]])
    const nt = g.triVerts.length / 3
    const paint = new Uint32Array(nt)
    const known = new Uint8Array(nt)
    const remaps = sources.map((src) =>
      src?.paints.map((p) => {
        let x = index.get(p)
        if (x === undefined) {
          x = paints.length
          paints.push(p)
          index.set(p, x)
        }
        return x
      }),
    )
    for (let r = 0; r < sources.length; r++) {
      const src = sources[r]
      if (!src) continue
      for (let t = g.runIndex[r] / 3; t < g.runIndex[r + 1] / 3; t++) {
        paint[t] = remaps[r]![src.paint[g.faceID[t]]]
        known[t] = 1
      }
    }
    inheritPaint(out, paint, known)
    out.paint = paint
    out.paints = paints
    return out
  }
}

/** Column-major 4x4 rotation about a unit axis (degrees), for Manifold.transform. */
function rotationMatrix(axis: V3, deg: number): [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number] {
  const l = Math.hypot(...axis) || 1
  const [x, y, z] = [axis[0] / l, axis[1] / l, axis[2] / l]
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const t = 1 - c
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1]
}

/**
 * Joins vertices that sit at exactly the same position (an STL repeats every
 * corner for each triangle), with a hash on the float bits.
 */
export function weld(m: TriMesh): TriMesh {
  const p = m.positions
  const n = p.length / 3
  const bits = new Uint32Array(p.buffer, p.byteOffset, p.length)
  let size = 1
  while (size < n * 2) size <<= 1
  const table = new Int32Array(size).fill(-1)
  const map = new Uint32Array(n)
  const out = new Float32Array(p.length)
  const outBits = new Uint32Array(out.buffer)
  let count = 0
  for (let i = 0; i < n; i++) {
    const x = bits[i * 3] === 0x80000000 ? 0 : bits[i * 3]
    const y = bits[i * 3 + 1] === 0x80000000 ? 0 : bits[i * 3 + 1]
    const z = bits[i * 3 + 2] === 0x80000000 ? 0 : bits[i * 3 + 2]
    let h = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d)) >>> 0
    h &= size - 1
    for (;;) {
      const at = table[h]
      if (at < 0) {
        table[h] = count
        outBits[count * 3] = x
        outBits[count * 3 + 1] = y
        outBits[count * 3 + 2] = z
        map[i] = count++
        break
      }
      if (outBits[at * 3] === x && outBits[at * 3 + 1] === y && outBits[at * 3 + 2] === z) {
        map[i] = at
        break
      }
      h = (h + 1) & (size - 1)
    }
  }
  const tri = new Uint32Array(m.triangles.length)
  for (let i = 0; i < tri.length; i++) tri[i] = map[m.triangles[i]]
  return { positions: out.slice(0, count * 3), triangles: tri }
}

/**
 * Paint for triangles that came from no painted source (a cut's new walls
 * and floors): the paint of the nearest source triangle facing the same way
 * (a new pocket floor takes the nearby pocket floors' color, its walls the
 * wall color); what has none within reach takes a painted neighbour's.
 */
function inheritPaint(m: TriMesh, paint: Uint32Array, known: Uint8Array) {
  const T = m.triangles
  const P = m.positions
  const nt = T.length / 3
  let todo = 0
  for (let t = 0; t < nt; t++) if (!known[t]) todo++
  if (!todo) return
  const cen = new Float32Array(nt * 3)
  const nor = new Float32Array(nt * 3)
  for (let t = 0; t < nt; t++) {
    const a = T[t * 3] * 3
    const b = T[t * 3 + 1] * 3
    const c = T[t * 3 + 2] * 3
    for (let k = 0; k < 3; k++) cen[t * 3 + k] = (P[a + k] + P[b + k] + P[c + k]) / 3
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2]
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z) || 1
    nor[t * 3] = x / l
    nor[t * 3 + 1] = y / l
    nor[t * 3 + 2] = z / l
  }
  // A new face takes the paint of original faces in the same plane (the
  // floors at that height, the walls in that line), else the nearest original
  // face that looks the same way. Planes: facing rounded, offset in 0.05 mm.
  const plane = (t: number) => {
    const nx = Math.round(nor[t * 3] * 20), ny = Math.round(nor[t * 3 + 1] * 20), nz = Math.round(nor[t * 3 + 2] * 20)
    const d = Math.round((nor[t * 3] * cen[t * 3] + nor[t * 3 + 1] * cen[t * 3 + 1] + nor[t * 3 + 2] * cen[t * 3 + 2]) / 0.05)
    return `${nx},${ny},${nz},${d}`
  }
  const byPlane = new Map<string, Map<number, number>>()
  for (let t = 0; t < nt; t++) {
    if (known[t] !== 1) continue
    const k = plane(t)
    let votes = byPlane.get(k)
    if (!votes) byPlane.set(k, (votes = new Map()))
    votes.set(paint[t], (votes.get(paint[t]) ?? 0) + 1)
  }
  for (let t = 0; t < nt; t++) {
    if (known[t]) continue
    const votes = byPlane.get(plane(t))
    if (!votes) continue
    let best = 0
    let most = -1
    for (const [p, n] of votes) if (n > most) [best, most] = [p, n]
    paint[t] = best
    known[t] = 2
    todo--
  }
  if (!todo) return

  const dot = (a: number, b: number) => nor[a * 3] * nor[b * 3] + nor[a * 3 + 1] * nor[b * 3 + 1] + nor[a * 3 + 2] * nor[b * 3 + 2]

  // Source triangles in a grid of cells, by centroid.
  const cell = 2
  const grid = new Map<string, number[]>()
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  for (let t = 0; t < nt; t++) {
    if (known[t] !== 1) continue
    const k = key(Math.floor(cen[t * 3] / cell), Math.floor(cen[t * 3 + 1] / cell), Math.floor(cen[t * 3 + 2] / cell))
    let list = grid.get(k)
    if (!list) grid.set(k, (list = []))
    list.push(t)
  }
  const reach = 12
  for (let t = 0; t < nt; t++) {
    if (known[t]) continue
    const cx = Math.floor(cen[t * 3] / cell)
    const cy = Math.floor(cen[t * 3 + 1] / cell)
    const cz = Math.floor(cen[t * 3 + 2] / cell)
    let best = -1
    let bestD = Infinity
    for (let r = 0; r <= reach && best < 0; r++) {
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++)
          for (let k = -r; k <= r; k++) {
            if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue
            const list = grid.get(key(cx + i, cy + j, cz + k))
            if (!list) continue
            for (const o of list) {
              if (dot(t, o) < 0.9) continue
              const d = (cen[o * 3] - cen[t * 3]) ** 2 + (cen[o * 3 + 1] - cen[t * 3 + 1]) ** 2 + (cen[o * 3 + 2] - cen[t * 3 + 2]) ** 2
              if (d < bestD) {
                bestD = d
                best = o
              }
            }
          }
    }
    if (best >= 0) {
      paint[t] = paint[best]
      known[t] = 2
      todo--
    }
  }
  if (!todo) return

  // Left over: flood from painted neighbours across shared edges.
  const nv = P.length / 3
  const edges = new Map<number, number>()
  const nb = new Int32Array(nt * 3).fill(-1)
  for (let t = 0; t < nt; t++)
    for (let j = 0; j < 3; j++) {
      const a = T[t * 3 + j]
      const b = T[t * 3 + ((j + 1) % 3)]
      const e = Math.min(a, b) * nv + Math.max(a, b)
      const o = edges.get(e)
      if (o === undefined) edges.set(e, t * 3 + j)
      else {
        nb[t * 3 + j] = Math.floor(o / 3)
        nb[o] = t
      }
    }
  let grew = true
  while (grew && todo) {
    grew = false
    for (let t = 0; t < nt; t++) {
      if (known[t]) continue
      for (let j = 0; j < 3; j++) {
        const o = nb[t * 3 + j]
        if (o >= 0 && known[o]) {
          paint[t] = paint[o]
          known[t] = 2
          todo--
          grew = true
          break
        }
      }
    }
  }
}

/** A mesh body from triangles; says what is wrong when they are not a closed solid. */
export function meshBody(tri: TriMesh, what: string): MeshBody {
  if (!tri.triangles.length) throw new Error(`${what} has no triangles`)
  const L = manifoldLib()
  const w = weld(tri)
  // Painted meshes get their own original ID, and each triangle its index as faceID, to follow paint through booleans.
  const id = tri.paint && tri.paints ? L.Manifold.reserveIDs(1) : undefined
  const build = (merge: boolean): Manifold | string => {
    const mesh = new L.Mesh({
      numProp: 3,
      vertProperties: w.positions,
      triVerts: w.triangles,
      ...(id !== undefined ? { faceID: sequence(w.triangles.length / 3), runOriginalID: new Uint32Array([id]), runIndex: new Uint32Array([0, w.triangles.length]) } : {}),
    })
    if (merge) mesh.merge()
    try {
      const m = new L.Manifold(mesh)
      const st = m.status()
      if (st === 'NoError') return m
      m.delete()
      return st
    } catch (e) {
      // manifold-3d throws on a mesh it cannot use ("Not manifold").
      const msg = e instanceof Error ? e.message : String(e)
      return /not manifold/i.test(msg) ? 'NotManifold' : msg
    }
  }
  // Corners that are close but not identical (rounding in the file): merge along open edges and try again.
  let m = build(false)
  if (m === 'NotManifold') m = build(true)
  if (typeof m === 'string') throw new Error(`${what}: ${STATUS[m] ?? m}; repair the mesh (for example with the slicer's repair or Meshmixer) and load it again`)
  if (m.volume() < 0) {
    m.delete()
    throw new Error(`${what}: the triangles face inward (negative volume); flip the normals and load it again`)
  }
  if (id !== undefined) painted.set(id, { paint: tri.paint!, paints: tri.paints! })
  return new MeshBody(m)
}

function sequence(n: number): Uint32Array {
  const t = new Uint32Array(n)
  for (let i = 0; i < n; i++) t[i] = i
  return t
}

/** A B-rep solid as a mesh body (tessellated within tolerance mm). */
export function meshFromTriangles(vertices: ArrayLike<number>, triangles: ArrayLike<number>, what: string): MeshBody {
  return meshBody({ positions: Float32Array.from(vertices), triangles: Uint32Array.from(triangles) }, what)
}

/** Bodies that do not overlap as one body, as they are (no boolean); consumes them. */
export function composeBodies(list: MeshBody[]): MeshBody {
  const out = manifoldLib().Manifold.compose(list.map((b) => b.m))
  for (const b of list) b.delete()
  return new MeshBody(out)
}

/** A box or point as a mesh body, for distance probes. */
export function meshCube(lo: V3, hi: V3): MeshBody {
  const L = manifoldLib()
  return new MeshBody(L.Manifold.cube([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]).translate(lo))
}

export interface DisplayMesh {
  vertices: Float32Array
  normals: Float32Array
  triangles: Uint32Array
  /** Line segments along edges sharper than the crease angle. */
  edges: Float32Array
}

/**
 * Triangles for the viewport: smooth normals across gentle bends, split
 * where triangles meet at more than crease degrees, and lines on those
 * sharp edges, so a faceted solid reads like a CAD body.
 */
export function displayMesh(body: MeshBody, crease = 30): DisplayMesh {
  const g = body.m.getMesh()
  const k = g.numProp
  const P = g.vertProperties
  const T = g.triVerts
  const nt = T.length / 3
  const nv = P.length / k
  const pos = (v: number, c: number) => P[v * k + c]

  // Face normals (unit) and areas.
  const fn = new Float32Array(nt * 3)
  const fa = new Float32Array(nt)
  for (let t = 0; t < nt; t++) {
    const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2]
    const ux = pos(b, 0) - pos(a, 0), uy = pos(b, 1) - pos(a, 1), uz = pos(b, 2) - pos(a, 2)
    const vx = pos(c, 0) - pos(a, 0), vy = pos(c, 1) - pos(a, 1), vz = pos(c, 2) - pos(a, 2)
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z)
    fa[t] = l / 2
    if (l > 0) {
      fn[t * 3] = x / l
      fn[t * 3 + 1] = y / l
      fn[t * 3 + 2] = z / l
    }
  }

  // Triangles around each vertex (CSR).
  const start = new Uint32Array(nv + 1)
  for (let i = 0; i < T.length; i++) start[T[i] + 1]++
  for (let v = 0; v < nv; v++) start[v + 1] += start[v]
  const fill = start.slice(0, nv)
  const around = new Uint32Array(T.length)
  for (let t = 0; t < nt; t++) for (let j = 0; j < 3; j++) around[fill[T[t * 3 + j]]++] = t

  const cos = Math.cos((crease * Math.PI) / 180)
  const dotf = (a: number, b: number) => fn[a * 3] * fn[b * 3] + fn[a * 3 + 1] * fn[b * 3 + 1] + fn[a * 3 + 2] * fn[b * 3 + 2]

  // Each corner gets an output vertex per (vertex, group of triangles that bend gently).
  const corner = new Uint32Array(T.length)
  const outPos: number[] = []
  const outNorm: number[] = []
  let count = 0
  const seeds: number[] = []
  const sums: number[] = []
  const ids: number[] = []
  for (let v = 0; v < nv; v++) {
    seeds.length = 0
    sums.length = 0
    ids.length = 0
    for (let i = start[v]; i < start[v + 1]; i++) {
      const t = around[i]
      let c = 0
      for (; c < seeds.length; c++) if (dotf(seeds[c], t) >= cos) break
      if (c === seeds.length) {
        seeds.push(t)
        sums.push(0, 0, 0)
        ids.push(count++)
        outPos.push(pos(v, 0), pos(v, 1), pos(v, 2))
        outNorm.push(0, 0, 0)
      }
      sums[c * 3] += fn[t * 3] * fa[t]
      sums[c * 3 + 1] += fn[t * 3 + 1] * fa[t]
      sums[c * 3 + 2] += fn[t * 3 + 2] * fa[t]
      const j = T[t * 3] === v ? 0 : T[t * 3 + 1] === v ? 1 : 2
      corner[t * 3 + j] = ids[c]
    }
    for (let c = 0; c < seeds.length; c++) {
      const l = Math.hypot(sums[c * 3], sums[c * 3 + 1], sums[c * 3 + 2]) || 1
      const o = ids[c] * 3
      outNorm[o] = sums[c * 3] / l
      outNorm[o + 1] = sums[c * 3 + 1] / l
      outNorm[o + 2] = sums[c * 3 + 2] / l
    }
  }

  // Sharp edges: each edge once (from its lower vertex), where its two triangles bend past the crease.
  const lines: number[] = []
  for (let t = 0; t < nt; t++) {
    for (let j = 0; j < 3; j++) {
      const a = T[t * 3 + j]
      const b = T[t * 3 + ((j + 1) % 3)]
      if (a > b) continue
      let other = -1
      for (let i = start[a]; i < start[a + 1]; i++) {
        const u = around[i]
        if (u !== t && (T[u * 3] === b || T[u * 3 + 1] === b || T[u * 3 + 2] === b)) {
          other = u
          break
        }
      }
      if (other >= 0 && dotf(t, other) >= cos) continue
      lines.push(pos(a, 0), pos(a, 1), pos(a, 2), pos(b, 0), pos(b, 1), pos(b, 2))
    }
  }

  return { vertices: Float32Array.from(outPos), normals: Float32Array.from(outNorm), triangles: corner, edges: Float32Array.from(lines) }
}
