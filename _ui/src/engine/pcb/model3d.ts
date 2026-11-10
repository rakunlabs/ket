// EasyEDA 3D models: OBJ with inline "newmtl ... endmtl" blocks (only Kd is
// used), vertex-only faces, millimetres, +Z up. Placement follows the
// conventions Flamingo verified (MIT, github.com/cheewee2000/flamingo-pcb):
// rotate by the model's XYZ euler, center the rotated bounding box on the
// footprint anchor in x/y and rest its bottom at z, mirror for bottom-side
// parts, then the component rotation and position, lifted onto the board.

import type { Model3D } from '../doc'

export interface ModelMesh {
  /** Triangles as flat xyz, per color group. */
  groups: { color: [number, number, number]; positions: Float32Array }[]
  /** Bounding box after placement in footprint space (mm). */
  size: [number, number, number]
}

/** Parses an OBJ into color groups of triangles (model-local). */
export function parseOBJ(text: string): { color: [number, number, number]; tris: number[] }[] {
  const verts: number[] = []
  const colors = new Map<string, [number, number, number]>()
  const groups = new Map<string, number[]>()
  let mtl: string | null = null
  let cur = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (mtl !== null) {
      if (line === 'endmtl') mtl = null
      else if (line.startsWith('Kd ')) {
        const [r, g, b] = line.slice(3).trim().split(/\s+/).map(Number)
        if ([r, g, b].every(Number.isFinite)) colors.set(mtl, [r, g, b])
      }
      continue
    }
    if (line.startsWith('newmtl ')) mtl = line.slice(7).trim()
    else if (line.startsWith('v ')) {
      const [x, y, z] = line.slice(2).trim().split(/\s+/).map(Number)
      verts.push(x, y, z)
    } else if (line.startsWith('usemtl ')) cur = line.slice(7).trim()
    else if (line.startsWith('f ')) {
      const n = verts.length / 3
      const idx = line
        .slice(2)
        .trim()
        .split(/\s+/)
        .map((t) => {
          const i = Number(t.split('/')[0])
          return i > 0 ? i - 1 : n + i
        })
        .filter((i) => i >= 0 && i < n)
      let g = groups.get(cur)
      if (!g) groups.set(cur, (g = []))
      for (let i = 1; i + 1 < idx.length; i++) {
        for (const k of [idx[0], idx[i], idx[i + 1]]) g.push(verts[k * 3], verts[k * 3 + 1], verts[k * 3 + 2])
      }
    }
  }
  return [...groups].filter(([, t]) => t.length).map(([name, tris]) => ({ color: colors.get(name) ?? [0.6, 0.6, 0.6], tris }))
}

const DEG = Math.PI / 180

/** three.js 'XYZ' euler: R = Rx·Ry·Rz. */
function euler(rx: number, ry: number, rz: number): number[] {
  const a = Math.cos(rx)
  const b = Math.sin(rx)
  const c = Math.cos(ry)
  const d = Math.sin(ry)
  const e = Math.cos(rz)
  const f = Math.sin(rz)
  return [c * e, -c * f, d, a * f + b * e * d, a * e - b * f * d, -b * c, b * f - a * e * d, b * e + a * f * d, a * c]
}

/**
 * Places a parsed model in footprint space (before the component transform):
 * x/y around the footprint origin, z from the board's top face up.
 */
export function placeModel(groups: ReturnType<typeof parseOBJ>, m: Model3D): ModelMesh {
  const R = euler(m.rotation[0] * DEG, m.rotation[1] * DEG, m.rotation[2] * DEG)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  const rotated = groups.map((g) => {
    const out = new Float32Array(g.tris.length)
    for (let i = 0; i < g.tris.length; i += 3) {
      const x = g.tris[i]
      const y = g.tris[i + 1]
      const z = g.tris[i + 2]
      const qx = R[0] * x + R[1] * y + R[2] * z
      const qy = R[3] * x + R[4] * y + R[5] * z
      const qz = R[6] * x + R[7] * y + R[8] * z
      out[i] = qx
      out[i + 1] = qy
      out[i + 2] = qz
      if (qx < minX) minX = qx
      if (qx > maxX) maxX = qx
      if (qy < minY) minY = qy
      if (qy > maxY) maxY = qy
      if (qz < minZ) minZ = qz
      if (qz > maxZ) maxZ = qz
    }
    return { color: g.color, positions: out }
  })
  if (!Number.isFinite(minX)) return { groups: [], size: [0, 0, 0] }
  const ox = m.origin.x - (minX + maxX) / 2
  const oy = m.origin.y - (minY + maxY) / 2
  const oz = m.z - minZ
  for (const g of rotated) {
    for (let i = 0; i < g.positions.length; i += 3) {
      g.positions[i] += ox
      g.positions[i + 1] += oy
      g.positions[i + 2] += oz
    }
  }
  return { groups: rotated, size: [maxX - minX, maxY - minY, maxZ - minZ + m.z] }
}
