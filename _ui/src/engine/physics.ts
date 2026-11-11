// Physics with Rapier: loose bodies fall and collide; everything else is
// solid, and bodies the motion plan drives are kinematic, so a turning gear
// or a sliding rack pushes what touches it. Colliders: a convex hull for a
// loose body (fast, stable), the triangle mesh for still and driven bodies.
// Units: the scene is in mm, Rapier works in metres.

import RAPIER from '@dimforge/rapier3d-compat'

import type { MeshData } from './kernel'
import { amountOf, type MotionPlan, quatOf, type V3 } from './motion'

let ready: Promise<void> | undefined
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init()
  return ready
}

const MM = 0.001

export interface Pose {
  /** Translation in mm. */
  t: V3
  /** Rotation quaternion x, y, z, w (about the world origin, applied before t). */
  q: [number, number, number, number]
}

export interface PhysicsWorld {
  /** Advances by dt seconds with the driven parameter at value. */
  step(dt: number, value: number): void
  /** Current poses of loose and driven bodies (relative to where they were built). */
  poses(): Map<string, Pose>
  /** Bodies each loose body is touching now. */
  contacts(): Map<string, string[]>
  dispose(): void
}

/** The pose of a driven body at parameter offset d (value − base). */
export function drivenPose(mv: MotionPlan['moves'][number], d: number): Pose {
  const amount = amountOf(mv, d)
  let pose: Pose
  if (mv.kind === 'slide') pose = { t: [mv.axis[0] * amount, mv.axis[1] * amount, mv.axis[2] * amount], q: [0, 0, 0, 1] }
  else pose = turnAbout(mv.axis, mv.origin, amount)
  if (!mv.orbit) return pose
  // Then the whole body circles the orbit axis: p'' = O(p') with p' = Rp + t.
  const o = turnAbout(mv.orbit.axis, mv.orbit.origin, mv.orbit.rate * d)
  const t = rotate(o.q, pose.t)
  return { t: [t[0] + o.t[0], t[1] + o.t[1], t[2] + o.t[2]], q: qmul(o.q, pose.q) }
}

function turnAbout(axis: V3, o: V3, deg: number): Pose {
  const q = quatOf(axis, deg)
  // Rotation about origin o: p' = R(p − o) + o, so t = o − R·o.
  const ro = rotate(q, o)
  return { t: [o[0] - ro[0], o[1] - ro[1], o[2] - ro[2]], q }
}

function qmul(a: Pose['q'], b: Pose['q']): Pose['q'] {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
}

export function rotate(q: [number, number, number, number], v: V3): V3 {
  const [x, y, z, w] = q
  const ix = w * v[0] + y * v[2] - z * v[1]
  const iy = w * v[1] + z * v[0] - x * v[2]
  const iz = w * v[2] + x * v[1] - y * v[0]
  const iw = -x * v[0] - y * v[1] - z * v[2]
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]
}

function centroid(m: MeshData): V3 {
  // The middle of the bounds: exact for a sphere, whose tessellation crowds
  // vertices at its poles and pulls a vertex average off center.
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < m.vertices.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], m.vertices[i + k])
      hi[k] = Math.max(hi[k], m.vertices[i + k])
    }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
}

/** The radius when every vertex lies on one sphere about c, else 0. */
function sphereRadius(m: MeshData, c: V3): number {
  const v = m.vertices
  let lo = Infinity
  let hi = 0
  for (let i = 0; i < v.length; i += 3) {
    const d = Math.hypot(v[i] - c[0], v[i + 1] - c[1], v[i + 2] - c[2])
    lo = Math.min(lo, d)
    hi = Math.max(hi, d)
  }
  return hi > 0 && (hi - lo) / hi < 0.01 ? hi : 0
}

/** Largest extent of a mesh, mm. */
function size(m: MeshData): number {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < m.vertices.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], m.vertices[i + k])
      hi[k] = Math.max(hi[k], m.vertices[i + k])
    }
  return Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
}

/** The smallest loose body sets the scale of the tolerances, mm. */
function typicalSize(meshes: MeshData[], plan: MotionPlan): number {
  const loose = new Set(plan.physics.map((p) => p.name))
  const sizes = meshes.filter((m) => loose.has(m.name)).map(size)
  return sizes.length ? Math.min(...sizes) : 100
}

/**
 * True when a mesh is convex: every vertex lies on or behind every
 * triangle's plane. Convex still bodies collide as hulls (solid inside).
 */
function isConvexBox(m: MeshData): boolean {
  const v = m.vertices
  const t = m.triangles
  if (t.length / 3 > 4000) return false
  const tol = 1e-3
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3
    const b = t[i + 1] * 3
    const c = t[i + 2] * 3
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2]
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2]
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    const nl = Math.hypot(nx, ny, nz)
    if (nl < 1e-12) continue
    for (let j = 0; j < v.length; j += 3 * Math.max(1, Math.floor(v.length / 3 / 400))) {
      if (((v[j] - v[a]) * nx + (v[j + 1] - v[a + 1]) * ny + (v[j + 2] - v[a + 2]) * nz) / nl > tol) return false
    }
  }
  return true
}

/**
 * One convex slab per B-rep face when every face is flat: the face's
 * triangles plus the same points pushed against the face normal by the
 * thickness of material behind it (found by casting rays from the face's
 * points into the solid to the nearest face looking the other way). The
 * slabs overlap where faces meet, which is fine for a static or driven body.
 * undefined when a face is curved (or the mesh has too many faces); the
 * caller uses a triangle mesh then. Points in metres.
 */
export function faceSlabs(m: MeshData): Float32Array[] | undefined {
  const v = m.vertices
  const t = m.triangles
  const g = m.faceGroups
  const faces = g.length / 2
  if (!faces || faces > 400) return undefined
  type Face = { n: V3; d: number; tris: number[] }
  const list: Face[] = []
  for (let f = 0; f < faces; f++) {
    const start = g[f * 2]
    const count = g[f * 2 + 1]
    if (!count) continue
    const tris: number[] = []
    let n: V3 | undefined
    for (let i = start; i < start + count; i++) {
      const a = t[i * 3] * 3
      const b = t[i * 3 + 1] * 3
      const c = t[i * 3 + 2] * 3
      const u: V3 = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]]
      const w: V3 = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]]
      const cr: V3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
      const l = Math.hypot(...cr)
      if (l < 1e-12) continue
      const tn: V3 = [cr[0] / l, cr[1] / l, cr[2] / l]
      if (!n) n = tn
      else if (n[0] * tn[0] + n[1] * tn[1] + n[2] * tn[2] < 0.9999) return undefined
      tris.push(i)
    }
    if (!n || !tris.length) continue
    const a = t[tris[0] * 3] * 3
    list.push({ n, d: n[0] * v[a] + n[1] * v[a + 1] + n[2] * v[a + 2], tris })
  }
  if (!list.length) return undefined

  // Thickness behind a face: the nearest opposite-facing face plane that a
  // ray from the face's centroid (inward) crosses inside that face.
  const triHit = (o: V3, dir: V3, i: number): number => {
    const a = t[i * 3] * 3
    const b = t[i * 3 + 1] * 3
    const c = t[i * 3 + 2] * 3
    const e1: V3 = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]]
    const e2: V3 = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]]
    const p: V3 = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]]
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2]
    if (Math.abs(det) < 1e-12) return Infinity
    const inv = 1 / det
    const s: V3 = [o[0] - v[a], o[1] - v[a + 1], o[2] - v[a + 2]]
    const uu = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv
    if (uu < -1e-6 || uu > 1 + 1e-6) return Infinity
    const q: V3 = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]]
    const vv = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv
    if (vv < -1e-6 || uu + vv > 1 + 1e-6) return Infinity
    const dist = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv
    return dist > 1e-6 ? dist : Infinity
  }
  const out: Float32Array[] = []
  for (const f of list) {
    const dir: V3 = [-f.n[0], -f.n[1], -f.n[2]]
    // Probe from each triangle's centroid; the slab is as thick as the thinnest hit.
    let depth = Infinity
    for (const i of f.tris) {
      const a = t[i * 3] * 3
      const b = t[i * 3 + 1] * 3
      const c = t[i * 3 + 2] * 3
      const o: V3 = [(v[a] + v[b] + v[c]) / 3, (v[a + 1] + v[b + 1] + v[c + 1]) / 3, (v[a + 2] + v[b + 2] + v[c + 2]) / 3]
      const from: V3 = [o[0] + dir[0] * 1e-4, o[1] + dir[1] * 1e-4, o[2] + dir[2] * 1e-4]
      for (const g2 of list) {
        if (g2 === f || g2.n[0] * f.n[0] + g2.n[1] * f.n[1] + g2.n[2] * f.n[2] > -0.5) continue
        for (const j of g2.tris) depth = Math.min(depth, triHit(from, dir, j))
      }
    }
    if (!Number.isFinite(depth)) return undefined
    // Each triangle on its own: a face with a hole (an L, a ring) is not convex.
    for (const i of f.tris) {
      const pts = new Float32Array(18)
      for (let k = 0; k < 3; k++) {
        const a = t[i * 3 + k] * 3
        for (let j = 0; j < 3; j++) {
          pts[k * 3 + j] = v[a + j] * MM
          pts[9 + k * 3 + j] = (v[a + j] + dir[j] * depth) * MM
        }
      }
      out.push(pts)
    }
  }
  return out
}

/**
 * Builds a world from the meshes. Loose bodies get their center as the body
 * origin, so their pose is "rotate about the center, then move"; poses() turns
 * it back into a transform of the built mesh.
 */
export function createWorld(meshes: MeshData[], plan: MotionPlan): PhysicsWorld {
  const world = new RAPIER.World({ x: 0, y: 0, z: -plan.gravity * MM })
  world.timestep = 1 / 240
  // lengthUnit scales Rapier's tolerances (slop 0.005·lu m, prediction
  // 0.02·lu m). Keep the allowed overlap well under the thinnest wall:
  // 0.03 → 0.15 mm slop, 0.6 mm prediction.
  world.lengthUnit = Math.min(1, Math.max(0.01, typicalSize(meshes, plan) * MM * 4))
  world.numSolverIterations = 10
  world.maxCcdSubsteps = 4
  const loose = new Map(plan.physics.map((p) => [p.name, p]))
  const driven = new Map(plan.moves.map((m) => [m.body, m]))
  const bodies = new Map<string, { rb: RAPIER.RigidBody; center: V3; kind: 'loose' | 'driven' }>()
  const names = new Map<number, string>()

  let minZ = Infinity
  for (const m of meshes) for (let i = 2; i < m.vertices.length; i += 3) minZ = Math.min(minZ, m.vertices[i])
  if (plan.floor && Number.isFinite(minZ)) {
    const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, (minZ - 5) * MM))
    world.createCollider(RAPIER.ColliderDesc.cuboid(5, 5, 5 * MM).setFriction(0.8), floor)
  }

  for (const m of meshes) {
    const scaled = new Float32Array(m.vertices.length)
    const lp = loose.get(m.name)
    const c: V3 = lp ? centroid(m) : [0, 0, 0]
    for (let i = 0; i < m.vertices.length; i += 3) {
      scaled[i] = (m.vertices[i] - c[0]) * MM
      scaled[i + 1] = (m.vertices[i + 1] - c[1]) * MM
      scaled[i + 2] = (m.vertices[i + 2] - c[2]) * MM
    }
    if (lp) {
      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(c[0] * MM, c[1] * MM, c[2] * MM)
        .setLinvel(lp.velocity[0] * MM, lp.velocity[1] * MM, lp.velocity[2] * MM)
        .setAngvel({ x: (lp.spin[0] * Math.PI) / 180, y: (lp.spin[1] * Math.PI) / 180, z: (lp.spin[2] * Math.PI) / 180 })
        // Hard CCD sweeps fast bodies; soft CCD predicts contacts ahead (Rapier's advice for small bodies on trimeshes).
        .setCcdEnabled(true)
        .setSoftCcdPrediction((size(m) / 2) * MM)
        .setAngularDamping(0.3)
        .setAdditionalSolverIterations(4)
        // A body resting in a moving cup must keep up with it: a sleeping
        // body is skipped until something hits it, then gets kicked.
        .setCanSleep(false)
      const rb = world.createRigidBody(desc)
      // A sphere gets a true ball (a hull of its tessellation rolls like a die).
      const r = sphereRadius(m, c)
      const col = r ? RAPIER.ColliderDesc.ball(r * MM) : RAPIER.ColliderDesc.convexHull(scaled) ?? RAPIER.ColliderDesc.ball(0.002)
      // g/cm³ → kg/m³.
      world.createCollider(col.setDensity(lp.density * 1000).setFriction(lp.friction).setRestitution(lp.restitution), rb)
      bodies.set(m.name, { rb, center: c, kind: 'loose' })
      names.set(rb.collider(0).handle, m.name)
    } else {
      const isDriven = driven.has(m.name)
      const rb = world.createRigidBody(isDriven ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.fixed())
      // Thin walls need an inside: a triangle mesh has none, so a ball that
      // sinks into a 1.6 mm wall can be pushed out the far side (Rapier
      // #524). Build the body from convex pieces instead: the whole hull when
      // it is convex, else one slab per flat face as thick as the material
      // behind it; a triangle mesh only for what has curved faces.
      const pieces = isConvexBox(m) ? [scaled] : faceSlabs(m)
      let made: RAPIER.Collider | undefined
      if (pieces) {
        for (const p of pieces) {
          const d = RAPIER.ColliderDesc.convexHull(p)
          if (!d) continue
          made = world.createCollider(d.setFriction(0.6).setContactSkin(0.0001), rb)
          names.set(made.handle, m.name)
        }
      }
      if (!made) {
        const flags = RAPIER.TriMeshFlags.ORIENTED | RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES | RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES | RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES
        made = world.createCollider(RAPIER.ColliderDesc.trimesh(scaled, m.triangles, flags).setContactSkin(0.0002).setFriction(0.6), rb)
        names.set(made.handle, m.name)
      }
      if (isDriven) bodies.set(m.name, { rb, center: c, kind: 'driven' })
    }
  }

  let acc = 0
  let last: number | undefined = plan.base
  return {
    step(dt, value) {
      acc += Math.min(dt, 0.1)
      // Advance the driven parameter in the same substeps as the world, so a
      // moving cup moves a little each substep instead of jumping once per
      // frame (a jump teleports its walls through what it carries).
      const steps = Math.min(24, Math.floor(acc / world.timestep))
      const from = last ?? value
      for (let n = 1; n <= steps; n++) {
        const v = from + ((value - from) * n) / steps
        for (const [name, b] of bodies) {
          if (b.kind !== 'driven') continue
          const p = drivenPose(driven.get(name)!, v - plan.base)
          b.rb.setNextKinematicTranslation({ x: p.t[0] * MM, y: p.t[1] * MM, z: p.t[2] * MM })
          b.rb.setNextKinematicRotation({ x: p.q[0], y: p.q[1], z: p.q[2], w: p.q[3] })
        }
        world.step()
        acc -= world.timestep
      }
      if (steps === 24) acc = 0
      if (steps) last = value
    },
    poses() {
      const out = new Map<string, Pose>()
      for (const [name, b] of bodies) {
        const t = b.rb.translation()
        const r = b.rb.rotation()
        const q: [number, number, number, number] = [r.x, r.y, r.z, r.w]
        // Mesh vertex p → R(p − c) + t: as "rotate about origin then move", the move is t − R·c.
        const rc = rotate(q, b.center)
        out.set(name, { t: [t.x / MM - rc[0], t.y / MM - rc[1], t.z / MM - rc[2]], q })
      }
      return out
    },
    contacts() {
      const out = new Map<string, string[]>()
      for (const [name, b] of bodies) {
        if (b.kind !== 'loose') continue
        const touching: string[] = []
        world.contactPairsWith(b.rb.collider(0), (other) => {
          let hit = false
          world.contactPair(b.rb.collider(0), other, (m) => {
            if (m.numContacts() > 0) hit = true
          })
          if (hit) touching.push(names.get(other.handle) ?? 'floor')
        })
        out.set(name, touching)
      }
      return out
    },
    dispose() {
      world.free()
    },
  }
}
