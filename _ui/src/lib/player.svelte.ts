// Playback: advances the driven parameter in real time and poses the body
// meshes from the motion plan, with loose bodies from a Rapier world running
// in the page. Nothing is rebuilt while playing; Stop puts every body back
// and, with "keep", writes the reached value to the document once.

import type { MeshData } from '../engine/kernel'
import type { MotionPlan } from '../engine/motion'
import { createWorld, drivenPose, initPhysics, type PhysicsWorld, type Pose } from '../engine/physics'

export class Player {
  playing = $state(false)
  value = $state(0)
  time = $state(0)
  speed = $state(1)
  error = $state('')

  private plan: MotionPlan | undefined
  private world: PhysicsWorld | undefined
  private raf = 0
  private last = 0
  private dir = 1

  constructor(private pose: (p: Map<string, Pose> | undefined) => void) {}

  get param() {
    return this.plan?.param
  }

  async start(plan: MotionPlan, meshes: MeshData[]) {
    this.stop()
    this.error = ''
    this.plan = plan
    this.value = plan.base
    this.time = 0
    this.dir = 1
    if (plan.physics.length) {
      try {
        await initPhysics()
        this.world = createWorld(meshes, plan)
      } catch (e) {
        this.error = `physics: ${(e as Error).message}`
      }
    }
    if (!plan.moves.length && !this.world) {
      this.error = plan.problems[0] ?? 'Nothing moves yet: drive a gear train from a parameter, or add joints or loose bodies with set_motion.'
      return
    }
    this.playing = true
    this.last = performance.now()
    const tick = (now: number) => {
      if (!this.playing) return
      const dt = Math.min(0.05, (now - this.last) / 1000) * this.speed
      this.last = now
      this.advance(dt)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  private advance(dt: number) {
    const p = this.plan!
    this.time += dt
    let v = this.value + p.speed * dt * this.dir
    if (p.range && p.mode !== 'forever') {
      const [lo, hi] = p.range
      if (p.mode === 'loop') {
        if (v > hi) v = lo + ((v - lo) % (hi - lo || 1))
      } else if (v > hi || v < lo) {
        this.dir = -this.dir
        v = Math.max(lo, Math.min(hi, v))
      }
    }
    this.value = v
    const poses = new Map<string, Pose>()
    if (this.world) {
      this.world.step(dt, v)
      for (const [k, pose] of this.world.poses()) poses.set(k, pose)
    } else {
      for (const m of p.moves) poses.set(m.body, drivenPose(m, v - p.base))
    }
    this.pose(poses)
  }

  /** Stops and puts every body back where the document has it. */
  stop() {
    this.playing = false
    cancelAnimationFrame(this.raf)
    this.world?.dispose()
    this.world = undefined
    this.pose(undefined)
  }

  pause() {
    this.playing = false
    cancelAnimationFrame(this.raf)
  }

  resume() {
    if (!this.plan || this.playing) return
    this.playing = true
    this.last = performance.now()
    const tick = (now: number) => {
      if (!this.playing) return
      const dt = Math.min(0.05, (now - this.last) / 1000) * this.speed
      this.last = now
      this.advance(dt)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  /** True when there is a paused run to resume. */
  get paused() {
    return !this.playing && !!this.plan && this.time > 0
  }

  reset() {
    this.stop()
    this.plan = undefined
    this.time = 0
  }
}
