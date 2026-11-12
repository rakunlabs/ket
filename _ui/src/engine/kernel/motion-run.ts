// Running motion: headless physics of loose bodies, and the interference sweep of moving bodies.

import RAPIER from '@dimforge/rapier3d-compat'

import { type Doc, bodies } from '../doc'
import { createWorld, drivenPose, initPhysics, rotate } from '../physics'
import type { Kernel } from '../kernel'
import type { SweepOptions } from '../registry'
import { type Body, bodyBox, boxesApart, brepToMesh, isMesh, meshCenter, overlapVolume, quatAxisAngle } from './shapes'
import type { BuildResult } from './types'

/** Headless physics: loose bodies' centers over time. */
export async function simulateMotion(k: Kernel, doc: Doc, seconds: number, samples: number): Promise<Record<string, unknown>> {
  const plan = k.motion(doc)
  if (!plan.physics.length && !plan.moves.length) return { note: 'nothing moves: add physics bodies or joints with set_motion (gear trains move from their first gear rotation parameter)', problems: plan.problems }
  await initPhysics()
  const meshes = k.meshes({ bodies: bodies(doc).map((f) => f.name).filter((n) => k.cache.has(n)) } as BuildResult)
  const world = createWorld(meshes, plan)
  const centers = new Map(meshes.map((m) => [m.name, meshCenter(m)]))
  const r1 = (v: number) => Math.round(v * 10) / 10
  const shots: Record<string, unknown>[] = []
  const dt = 1 / 60
  const total = Math.round(seconds / dt)
  const every = Math.max(1, Math.round(total / samples))
  let last = new Map<string, [number, number, number]>()
  const escaped: string[] = []
  try {
    for (let i = 1; i <= total; i++) {
      const t = i * dt
      world.step(dt, plan.base + (plan.param ? plan.speed * t : 0))
      if (i % every === 0 || i === total) {
        const poses = world.poses()
        const touching = world.contacts()
        const shot: Record<string, unknown> = { t: r1(t), ...(plan.param ? { [plan.param]: r1(plan.base + plan.speed * t) } : {}) }
        for (const p of plan.physics) {
          const pose = poses.get(p.name)
          const c0 = centers.get(p.name)!
          if (!pose) continue
          const rc = rotate(pose.q, c0)
          const c: [number, number, number] = [rc[0] + pose.t[0], rc[1] + pose.t[1], rc[2] + pose.t[2]]
          const prev = last.get(p.name)
          const still = prev ? Math.hypot(c[0] - prev[0], c[1] - prev[1], c[2] - prev[2]) < 0.2 : false
          shot[p.name] = { center: c.map(r1), moved: r1(Math.hypot(c[0] - c0[0], c[1] - c0[1], c[2] - c0[2])), resting: still || undefined, touching: touching.get(p.name)?.length ? touching.get(p.name) : undefined }
          // Watchdog: a loose body inside a solid passed through it.
          const inside = k.insideOf(c, p.name)
          if (inside) {
            escaped.push(`${p.name} is inside "${inside}" at t=${r1(t)} s: it passed through a wall; make the wall thicker or the body slower`)
          }
          last.set(p.name, c)
        }
        shots.push(shot)
        last = new Map(last)
      }
    }
  } finally {
    world.dispose()
  }
  return { param: plan.param, speed: plan.speed, moving: plan.moves.map((m) => m.body), loose: plan.physics.map((p) => p.name), samples: shots, escaped: escaped.length ? [...new Set(escaped)].slice(0, 5) : undefined, problems: plan.problems.length ? plan.problems : undefined }
}

/**
 * Interference sweep: steps the driven parameter over a range, poses every
 * moving body and finds pairs of bodies that overlap. Exact: the pose's
 * solids are intersected with OpenCascade for every pair whose bounds
 * meet, so it takes a while; steps × moving pairs boolean operations.
 */
export async function sweepMotion(k: Kernel, doc: Doc, opts: SweepOptions): Promise<Record<string, unknown>> {
  const plan = k.motion(doc)
  if (!plan.param) return { error: 'nothing drives the model: make a gear or mechanism rotation an expression of a parameter, or set motion drive' }
  if (!plan.moves.length) return { error: 'nothing moves with ' + plan.param, problems: plan.problems }
  const from = opts.from ?? plan.base
  const to = opts.to ?? plan.base + 360
  const steps = Math.max(1, Math.min(720, opts.steps ?? 72))
  const minVol = opts.min_volume ?? 0.001
  await initPhysics()
  const moves = new Map(plan.moves.map((m) => [m.body, m]))
  const all = bodies(doc)
    .map((f) => f.name)
    .filter((n) => k.cache.has(n))
  const chosen = opts.bodies?.length ? all.filter((n) => opts.bodies!.includes(n)) : all
  const unknown = (opts.bodies ?? []).filter((n) => !all.includes(n))
  if (unknown.length) return { error: `not visible bodies: ${unknown.join(', ')}; bodies are ${all.join(', ')}` }
  const skip = new Set((opts.ignore ?? []).flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]))
  // A belt rides on its pulleys: that contact is the point.
  for (const f of doc.features) if (f.type === 'belt') for (const p of f.pulleys) if (p.body) skip.add(`${f.name}|${p.body}`).add(`${p.body}|${f.name}`)
  const pairs: [string, string][] = []
  for (let i = 0; i < chosen.length; i++)
    for (let j = i + 1; j < chosen.length; j++) {
      const a = chosen[i]
      const b = chosen[j]
      if ((moves.has(a) || moves.has(b)) && !skip.has(`${a}|${b}`)) pairs.push([a, b])
    }
  const posed = (name: string, d: number): Body => {
    const s = k.body(name)
    const mv = moves.get(name)
    if (!mv) return s
    const p = drivenPose(mv, d)
    const { axis, angle } = quatAxisAngle(p.q)
    if (isMesh(s)) {
      let out = s
      if (angle) out = out.rotateAbout(angle, [0, 0, 0], axis)
      if (p.t[0] || p.t[1] || p.t[2]) out = out.translate(p.t)
      return out
    }
    let out = s
    if (angle) out = out.rotate(angle, [0, 0, 0], axis)
    if (p.t[0] || p.t[1] || p.t[2]) out = out.translate(p.t[0], p.t[1], p.t[2])
    return out
  }
  const hits = new Map<string, { first: number; last: number; volume: number; depth: number; at: number; count: number }>()
  const started = performance.now()
  let done = 0
  let stopped = false
  // Broad phase on the display meshes with Rapier (milliseconds per pair):
  // only pairs whose meshes touch go to the exact OpenCascade intersection
  // (about a second for two gears). The meshes sit within their tolerance
  // inside curved surfaces, so overlaps under ~0.05 mm can slip through.
  const meshes = new Map(k.meshes({ bodies: chosen } as BuildResult).map((m) => [m.name, m]))
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 })
  const colliders = new Map<string, RAPIER.Collider>()
  for (const [name, m] of meshes) {
    const d = RAPIER.ColliderDesc.trimesh(m.vertices, m.triangles, RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES | RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES)
    colliders.set(name, world.createCollider(d))
  }
  // Penetration depth of two meshes (> 0 overlap), undefined when apart.
  const depth = (a: string, b: string): number | undefined => {
    const ca = colliders.get(a)
    const cb = colliders.get(b)
    if (!ca || !cb) return 0
    try {
      const c = ca.contactCollider(cb, 0.01)
      return c && c.distance < 0.01 ? -c.distance : undefined
    } catch {
      return 0
    }
  }
  try {
    for (let i = 0; i <= steps && !stopped; i++) {
      const v = from + ((to - from) * i) / steps
      const d = v - plan.base
      for (const [name, c] of colliders) {
        const mv = moves.get(name)
        if (!mv) continue
        const p = drivenPose(mv, d)
        c.setTranslation({ x: p.t[0], y: p.t[1], z: p.t[2] })
        c.setRotation({ x: p.q[0], y: p.q[1], z: p.q[2], w: p.q[3] })
      }
      const cache = new Map<string, Body>()
      const get = (n: string) => {
        let s = cache.get(n)
        if (!s) cache.set(n, (s = posed(n, d)))
        return s
      }
      for (const [a, b] of pairs) {
        const pen = depth(a, b)
        if (pen === undefined) continue
        const key = `${a}|${b}`
        const h = hits.get(key)
        // A pair already confirmed: follow it on the meshes (fast).
        if (h) {
          if (pen > 0.02) {
            h.last = v
            h.count++
            if (pen > h.depth) {
              h.depth = pen
              h.at = v
            }
          }
          continue
        }
        // First contact: confirm with the exact solids.
        const A = get(a)
        const B = get(b)
        if (boxesApart(bodyBox(A), bodyBox(B))) continue
        let vol: number
        if (isMesh(A) || isMesh(B)) {
          const ma = isMesh(A) ? A : brepToMesh(A, a)
          const mb = isMesh(B) ? B : brepToMesh(B, b)
          vol = ma.overlap(mb).volume
          if (ma !== A) ma.delete()
          if (mb !== B) mb.delete()
        } else vol = overlapVolume(A, B)
        if (vol > minVol) hits.set(key, { first: v, last: v, volume: vol, depth: Math.max(0, pen), at: v, count: 1 })
      }
      for (const s of cache.values()) s.delete()
      done = i
      if (performance.now() - started > 40_000) stopped = true
    }
  } finally {
    world.free()
  }
  const r = (x: number) => Math.round(x * 1000) / 1000
  const collisions = [...hits].map(([k, h]) => {
    const [a, b] = k.split('|')
    return { a, b, first: r(h.first), last: r(h.last), steps: h.count, volume_at_first: r(h.volume), worst_depth: r(h.depth), worst_at: r(h.at) }
  })
  collisions.sort((x, y) => x.first - y.first)
  return {
    param: plan.param,
    from: r(from),
    to: r(to),
    steps: done,
    step: r((to - from) / steps),
    pairs: pairs.length,
    clear: collisions.length === 0,
    collisions,
    ...(stopped ? { note: `stopped after ${done} of ${steps} steps (time limit); sweep a smaller range, fewer steps or fewer bodies` } : {}),
    ...(plan.problems.length ? { problems: plan.problems } : {}),
  }
}
