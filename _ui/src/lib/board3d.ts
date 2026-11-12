// The PCB's copper and silk in the 3D view: tracks, pads, vias and pours as
// thin plates on the board faces, the way a finished board looks (copper
// under a tinted solder mask, pads exposed as gold). Display only; the
// board solid itself comes from the kernel. Adapted from Flamingo's 3D
// viewer (MIT, github.com/cheewee2000/flamingo-pcb): layered thin
// extrusions and tinting instead of booleans.

import * as THREE from 'three'

import type { Pcb } from '../engine/doc'
import type { BoardState } from '../engine/pcb/state'
import { boardStyle } from '../engine/pcb/artwork'
import { boardDrills, drillRing } from '../engine/pcb/drills'

type P = { x: number; y: number }

const MAT = {
  // Copper seen through green mask: a lighter relief of the mask color.
  trace: new THREE.MeshStandardMaterial({ color: 0x3f8f55, roughness: 0.45, metalness: 0.3 }),
  pour: new THREE.MeshStandardMaterial({ color: 0x2f7a46, roughness: 0.5, metalness: 0.25 }),
  // Exposed pads: ENIG gold.
  gold: new THREE.MeshStandardMaterial({ color: 0xd8b545, roughness: 0.3, metalness: 0.9 }),
  barrel: new THREE.MeshStandardMaterial({ color: 0xb5923a, roughness: 0.4, metalness: 0.8, side: THREE.DoubleSide }),
  // Tented vias: a mask-covered bump.
  via: new THREE.MeshStandardMaterial({ color: 0x4a9a60, roughness: 0.5, metalness: 0.25 }),
  silk: new THREE.MeshBasicMaterial({ color: 0xf2f2ea }),
}

const CU = 0.035
const LIFT = 0.002
const materials = new Map<string, typeof MAT>()

function boardMaterials(pcb: Pcb): typeof MAT {
  const style = boardStyle(pcb)
  const key = `${style.mask}/${style.silk}`
  let mat = materials.get(key)
  if (!mat) {
    // A bounded palette cache, not mutable shared colors: several project
    // tabs (and exports) can show different boards at the same time.
    const tint = (amount: number) => new THREE.Color(style.maskColor).lerp(new THREE.Color('#ffffff'), amount)
    mat = { ...MAT, trace: MAT.trace.clone(), pour: MAT.pour.clone(), via: MAT.via.clone(), silk: MAT.silk.clone() }
    mat.trace.color.copy(tint(0.12))
    mat.pour.color.copy(tint(0.05))
    mat.via.color.copy(tint(0.16))
    mat.silk.color.set(style.silkColor)
    materials.set(key, mat)
  }
  return mat
}

function ring(at: P, r: number, n = 20): P[] {
  return Array.from({ length: n }, (_, i) => ({ x: at.x + r * Math.cos((i / n) * 2 * Math.PI), y: at.y + r * Math.sin((i / n) * 2 * Math.PI) }))
}

/** A segment of width w with round ends, as a closed outline. */
function capsule(a: P, b: P, w: number): P[] {
  const r = w / 2
  const ang = Math.atan2(b.y - a.y, b.x - a.x)
  const out: P[] = []
  const n = 8
  for (let i = 0; i <= n; i++) {
    const t = ang - Math.PI / 2 + (i / n) * Math.PI
    out.push({ x: b.x + r * Math.cos(t), y: b.y + r * Math.sin(t) })
  }
  for (let i = 0; i <= n; i++) {
    const t = ang + Math.PI / 2 + (i / n) * Math.PI
    out.push({ x: a.x + r * Math.cos(t), y: a.y + r * Math.sin(t) })
  }
  return out
}

function shape(outer: P[], holes: P[][] = []): THREE.Shape {
  const s = new THREE.Shape(outer.map((p) => new THREE.Vector2(p.x, p.y)))
  for (const h of holes) s.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))))
  return s
}

/** Many outlines extruded into one mesh at z0, depth d. */
function plates(shapes: THREE.Shape[], z0: number, d: number, mat: THREE.Material): THREE.Mesh | undefined {
  if (!shapes.length) return undefined
  const geo = new THREE.ExtrudeGeometry(shapes, { depth: d, bevelEnabled: false, curveSegments: 6 })
  const m = new THREE.Mesh(geo, mat)
  m.position.z = z0
  return m
}

/** The board's copper (and via barrels) as a group; z: board bottom, t: thickness. */
export function boardCopper(pcb: Pcb, st: BoardState): THREE.Group {
  const mat = boardMaterials(pcb)
  const g = new THREE.Group()
  g.userData.name = 'board'
  const b = st.board
  const z0 = b.z
  const top = b.z + b.thickness
  const at = (layer: string) => (layer === 'F.Cu' ? { z: top + LIFT, d: CU } : layer === 'B.Cu' ? { z: z0 - LIFT - CU, d: CU } : undefined)

  for (const layer of ['F.Cu', 'B.Cu']) {
    const pos = at(layer)!
    // Pours first, under the tracks.
    const pours: THREE.Shape[] = []
    for (const z of st.zones) if (z.layer === layer) for (const reg of z.regions) if (reg[0]?.length >= 3) pours.push(shape(reg[0], reg.slice(1).filter((h) => h.length >= 3)))
    const pm = plates(pours, pos.z, pos.d * 0.8, mat.pour)
    if (pm) g.add(pm)
    const tracks: THREE.Shape[] = []
    for (const t of pcb.tracks) {
      if (t.layer !== layer) continue
      for (let i = 1; i < t.points.length; i++) tracks.push(shape(capsule({ x: t.points[i - 1][0], y: t.points[i - 1][1] }, { x: t.points[i][0], y: t.points[i][1] }, t.width)))
    }
    for (const d of st.teardrops ?? []) if (d.layer === layer && d.outline.length >= 3) tracks.push(shape(d.outline, []))
    const tm = plates(tracks, pos.z, pos.d, mat.trace)
    if (tm) g.add(tm)
    const pads: THREE.Shape[] = []
    for (const p of b.pads) {
      if (!p.layers.includes(layer) || p.outline.length < 3) continue
      pads.push(shape(p.outline, p.drill ? [drillRing({ from: p.drillSlot?.[0] ?? p.center, to: p.drillSlot?.[1] ?? p.center, d: p.drill })] : []))
    }
    // Pads stand a little proud of the mask.
    const pd = plates(pads, layer === 'F.Cu' ? pos.z : pos.z - 0.02, pos.d + 0.02, MAT.gold)
    if (pd) g.add(pd)
    const vias: THREE.Shape[] = []
    for (const v of pcb.vias) vias.push(shape(ring({ x: v.at[0], y: v.at[1] }, v.diameter / 2), [ring({ x: v.at[0], y: v.at[1] }, v.drill / 2, 12)]))
    const vm = plates(vias, layer === 'F.Cu' ? pos.z : pos.z - 0.01, pos.d + 0.01, mat.via)
    if (vm) g.add(vm)
  }

  // Plated barrels through drilled pads and vias.
  const barrels: { at: P; r: number }[] = [
    ...b.pads.filter((p) => p.drill && !p.drillSlot && p.drillPlated !== false).map((p) => ({ at: p.center, r: p.drill! / 2 })),
    ...pcb.vias.map((v) => ({ at: { x: v.at[0], y: v.at[1] }, r: v.drill / 2 })),
  ]
  for (const h of boardDrills(pcb, b).filter((h) => h.plated && Math.hypot(h.to.x - h.from.x, h.to.y - h.from.y) > 1e-9)) {
    const barrel = plates([shape(drillRing({ ...h, d: h.d + 0.04 }), [drillRing(h)])], z0 - CU, b.thickness + 2 * CU, MAT.barrel)
    if (barrel) g.add(barrel)
  }
  if (barrels.length) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true)
    geo.rotateX(Math.PI / 2)
    const inst = new THREE.InstancedMesh(geo, MAT.barrel, barrels.length)
    const m = new THREE.Matrix4()
    barrels.forEach((br, i) => {
      m.makeScale(br.r, br.r, b.thickness + 2 * CU)
      m.setPosition(br.at.x, br.at.y, z0 + b.thickness / 2)
      inst.setMatrixAt(i, m)
    })
    g.add(inst)
  }

  // Silkscreen from the footprints (lines at their width).
  const silk: { top: THREE.Shape[]; bottom: THREE.Shape[] } = { top: [], bottom: [] }
  for (const c of b.components) {
    const side = c.side === 'bottom' ? 'bottom' : 'top'
    const tf = (x: number, y: number): P => {
      const mx = c.side === 'bottom' ? -x : x
      const a = (c.rotation * Math.PI) / 180
      return { x: c.at.x + mx * Math.cos(a) - y * Math.sin(a), y: c.at.y + mx * Math.sin(a) + y * Math.cos(a) }
    }
    for (const [x1, y1, x2, y2, w] of c.footprint.silk) silk[side].push(shape(capsule(tf(x1, y1), tf(x2, y2), Math.max(w, 0.12))))
  }
  for (const art of b.artwork ?? []) {
    for (const region of art.regions) silk[art.side].push(shape(region[0], region.slice(1)))
  }
  const st1 = plates(silk.top, top + LIFT + CU + 0.004, 0.01, mat.silk)
  if (st1) g.add(st1)
  const sb = plates(silk.bottom, z0 - LIFT - CU - 0.014, 0.01, mat.silk)
  if (sb) g.add(sb)

  g.traverse((o) => {
    o.userData.name = 'board'
    o.userData.overlay = true
  })
  return g
}

export function disposeCopper(g: THREE.Object3D) {
  g.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
}
