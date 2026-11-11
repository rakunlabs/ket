// Three.js scene for the model: the interactive viewport and offscreen
// renders for agents (fixed camera views, highlights, section cuts).

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'

import type { Pcb } from '../engine/doc'
import type { MeshData, SketchLines } from '../engine/kernel'
import type { BoardState } from '../engine/pcb/state'
import { boardCopper, disposeCopper } from './board3d'
import type { RenderOptions } from '../engine/registry'
import type { PlacedModel } from './models'
import { computeUV, decalObjects, environment, needsUV, pbrMaterial, REAL_LIGHT } from './materials'
import { hex } from './theme.svelte'

// Live view colours come from the theme (app.css --view-*); the agent's
// offscreen renders keep a fixed light palette so a model always sees the
// same kind of picture.
let BODY = 0xa9aaa2
let HIGHLIGHT = 0xfbff81
let SELECTED = 0xfbff81
let EDGE = 0x3a3a36
const RENDER = { bg: 0xffffff, body: 0xa9aaa2, highlight: 0xfbff81, edge: 0x3a3a36, grid: 0xd2d2ca, gridMinor: 0xe8e8e2 }

export interface Pick {
  name: string
  face: number
  point: [number, number, number]
  /** What the point snapped to; absent for a plain surface point. */
  snap?: SnapKind
}

export type SnapKind = 'vertex' | 'midpoint' | 'center' | 'edge'

/**
 * normal: CAD view, plain colors and edges (materials show their base color).
 * realistic: PBR materials, decals, environment reflections, no edges.
 * wireframe: edges only. xray: see-through bodies with edges.
 */
export type Shading = 'normal' | 'realistic' | 'wireframe' | 'xray'

type V3 = [number, number, number]

/** Snap targets of a body, from its B-rep edges. */
export interface Snaps {
  vertex: V3[]
  midpoint: V3[]
  center: V3[]
  /** Edge polylines, for the nearest point on an edge. */
  lines: V3[][]
}

export class Scene3D {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls
  private model = new THREE.Group()
  private helpers = new THREE.Group()
  private grid: THREE.GridHelper
  private disposed = false
  private framed = false
  private selected: string | undefined
  private meshes: MeshData[] = []
  private sketches: SketchLines[] = []
  private sketchGroup = new THREE.Group()
  private partGroup = new THREE.Group()
  private copperGroup = new THREE.Group()
  private copper: { pcb: Pcb; st: BoardState } | undefined
  private measureGroup = new THREE.Group()
  private parts: PlacedModel[] = []
  private snaps = new Map<string, Snaps>()
  private snapMarker: THREE.Object3D | undefined
  /** Show real part models instead of the part_* blocks. */
  realParts = true
  /** Skip drawing while the view is not on screen. */
  paused = false
  private shading: Shading = 'normal'

  private poses: Map<string, { t: [number, number, number]; q: [number, number, number, number] }> | undefined

  /** Moves body groups to poses (playback); undefined puts every body back where it was built. */
  setPoses(poses: Map<string, { t: [number, number, number]; q: [number, number, number, number] }> | undefined) {
    this.poses = poses
    this.placeBodies()
  }

  // ── Inspect: exploded view and hand-moved bodies (display only) ──────
  /** 0 = assembled, 1 = fully exploded (doc.explode offsets). */
  private explodeT = 0
  /** Bodies the user dragged in inspect mode: extra display offset. */
  private moved = new Map<string, THREE.Vector3>()
  private gizmo: TransformControls | undefined
  private gizmoTarget: string | undefined
  /** Called when the user drags a body (inspect mode). */
  onMoved: (() => void) | undefined

  setExplode(t: number) {
    this.explodeT = Math.max(0, Math.min(1, t))
    this.placeBodies()
  }

  get exploded() {
    return this.explodeT
  }

  /** Display offset of a body now: exploded view × t, plus where the user dragged it. */
  private offsetOf(name: string): THREE.Vector3 {
    const v = new THREE.Vector3()
    const e = this.meshes.find((m) => m.name === name)?.explode
    if (e && this.explodeT) v.set(e[0], e[1], e[2]).multiplyScalar(this.explodeT)
    const d = this.moved.get(name)
    if (d) v.add(d)
    return v
  }

  /** Puts every body (and part model) at its pose plus its display offset. */
  private placeBodies() {
    for (const o of this.model.children) {
      const name = o.userData.name as string
      const p = this.poses?.get(name)
      const off = this.offsetOf(name)
      if (p) {
        o.quaternion.set(p.q[0], p.q[1], p.q[2], p.q[3])
        o.position.set(p.t[0] + off.x, p.t[1] + off.y, p.t[2] + off.z)
      } else {
        o.quaternion.identity()
        o.position.copy(off)
      }
    }
    for (const o of this.partGroup.children) {
      const base = o.userData.base as THREE.Vector3 | undefined
      if (base) o.position.copy(base).add(this.offsetOf(o.userData.name as string))
    }
    for (const o of this.copperGroup.children) o.position.copy(this.offsetOf('board'))
  }

  /** Inspect mode: a move gizmo on the picked body; dragging it never changes the document. */
  inspect(name: string | undefined) {
    if (!this.gizmo) {
      this.gizmo = new TransformControls(this.camera, this.canvas)
      this.gizmo.setMode('translate')
      this.gizmo.setSize(0.8)
      this.gizmo.addEventListener('dragging-changed', (e) => {
        this.controls.enabled = !(e as unknown as { value: boolean }).value
      })
      this.gizmo.addEventListener('objectChange', () => {
        const o = this.gizmo!.object
        if (!o || !this.gizmoTarget) return
        // The dragged object sits at offset; keep the hand-moved part of it.
        const explode = this.meshes.find((m) => m.name === this.gizmoTarget)?.explode
        const base = (o.userData.base as THREE.Vector3 | undefined) ?? new THREE.Vector3()
        const ex = explode ? new THREE.Vector3(...explode).multiplyScalar(this.explodeT) : new THREE.Vector3()
        this.moved.set(this.gizmoTarget, o.position.clone().sub(base).sub(ex))
        // Part models follow their block, and copper follows the board.
        this.placeBodies()
        this.onMoved?.()
      })
      this.scene.add(this.gizmo.getHelper())
    }
    this.gizmoTarget = name
    const o = name ? [...this.model.children, ...this.partGroup.children].find((c) => c.userData.name === name) : undefined
    if (o) this.gizmo.attach(o)
    else this.gizmo.detach()
  }

  /** Puts hand-moved bodies back (and leaves inspect). */
  resetMoved() {
    this.moved.clear()
    this.gizmo?.detach()
    this.gizmoTarget = undefined
    this.placeBodies()
  }

  get movedCount() {
    return this.moved.size
  }

  /** Display offsets now (for render of what the user sees). */
  displayOffsets(): Record<string, [number, number, number]> {
    const out: Record<string, [number, number, number]> = {}
    for (const m of this.meshes) {
      const v = this.offsetOf(m.name)
      if (v.lengthSq() > 1e-9) out[m.name] = [v.x, v.y, v.z]
    }
    return out
  }

  setShading(s: Shading) {
    if (s === this.shading) return
    this.shading = s
    this.applyLighting()
    this.setMeshes(this.meshes)
  }

  private lights = new THREE.Group()

  /** CAD shading is flat and even; realistic uses the studio environment and tone mapping. */
  private applyLighting() {
    const real = this.shading === 'realistic'
    this.renderer.toneMapping = real ? REAL_LIGHT.toneMapping : THREE.NoToneMapping
    this.renderer.toneMappingExposure = real ? REAL_LIGHT.exposure : 1
    this.scene.environment = real ? environment(this.renderer) : null
    this.scene.environmentIntensity = REAL_LIGHT.env
    const [hemi, sun, fill] = this.lights.children as [THREE.HemisphereLight, THREE.DirectionalLight, THREE.DirectionalLight]
    hemi.intensity = real ? REAL_LIGHT.hemi : 1.6
    sun.intensity = real ? REAL_LIGHT.sun : 1.6
    fill.intensity = real ? REAL_LIGHT.fill : 0.5
  }

  constructor(private canvas: HTMLCanvasElement) {
    // A reversed depth buffer keeps depth precision even at any zoom, so
    // nearby faces do not fight; three falls back where it is unsupported.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, reversedDepthBuffer: true, logarithmicDepthBuffer: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.localClippingEnabled = true
    this.scene.background = new THREE.Color(0xf3f3ef)

    // Z up, like the document.
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1)
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000)
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(120, -160, 110)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.15

    this.lights.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(80, -120, 200)
    this.lights.add(sun)
    const fill = new THREE.DirectionalLight(0xffffff, 0.5)
    fill.position.set(-100, 120, 60)
    this.lights.add(fill)
    this.scene.add(this.lights)

    this.grid = new THREE.GridHelper(400, 40, 0xdcdcd4, 0xe8e8e2)
    this.grid.rotation.x = Math.PI / 2
    this.helpers.add(this.grid)
    this.applyTheme()
    this.helpers.add(axes(30))
    this.scene.add(this.helpers)
    this.scene.add(this.model)
    this.scene.add(this.sketchGroup)
    this.scene.add(this.partGroup)
    this.scene.add(this.copperGroup)
    this.scene.add(this.measureGroup)

    const loop = () => {
      if (this.disposed) return
      if (!this.paused) {
        this.fitCanvas()
        this.controls.update()
        this.updateClipping()
        this.renderer.render(this.scene, this.camera)
      }
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }

  /**
   * Keeps the drawing buffer the size of the canvas on screen. A resize
   * observer alone misses the first layout of a tab that was hidden, and
   * a 0 × 0 canvas leaves the camera with no aspect until the next event.
   */
  private fitCanvas() {
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (!w || !h) return
    const size = this.renderer.getSize(new THREE.Vector2())
    if (size.x !== w || size.y !== h) this.resize(w, h)
    if (this.frameWhenSized) {
      this.frameWhenSized = false
      this.frame()
    }
  }

  private frameWhenSized = false
  private radius = 100

  /**
   * Near and far follow the camera: depth precision depends on far/near,
   * so a fixed pair set at framing time either clips close-ups or makes
   * nearby faces fight (z-fighting) after zooming out.
   */
  private updateClipping() {
    const d = this.camera.position.distanceTo(this.controls.target)
    const r = Math.max(this.radius, 1)
    const far = d + r * 4 + 400
    const near = Math.max(far / 20000, Math.min(d * 0.5, Math.max(d - r * 2, d / 50)))
    if (Math.abs(this.camera.near - near) / near > 0.05 || Math.abs(this.camera.far - far) / far > 0.05) {
      this.camera.near = near
      this.camera.far = far
      this.camera.updateProjectionMatrix()
    }
  }

  resize(w: number, h: number) {
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  dispose() {
    this.disposed = true
    this.controls.dispose()
    this.gizmo?.dispose()
    this.clearModel()
    this.renderer.dispose()
    this.shot?.dispose()
  }

  private clearModel() {
    for (const o of [...this.model.children]) {
      this.model.remove(o)
      o.traverse((c) => {
        const m = c as THREE.Mesh
        m.geometry?.dispose()
        const mat = m.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat?.dispose()
      })
    }
  }

  setMeshes(meshes: MeshData[]) {
    if (meshes !== this.meshes) this.snaps.clear()
    this.meshes = meshes
    this.clearModel()
    const hidden = this.hiddenBlocks()
    for (const m of meshes) if (!hidden.has(m.name)) this.model.add(bodyObject(m, undefined, [], true, { body: BODY, edge: EDGE }, m.name === this.selected, environment(this.renderer), this.shading))
    this.placeBodies()
    if (this.gizmoTarget) this.inspect(this.gizmoTarget)
    if (!this.framed && meshes.length) {
      // A hidden tab has no size yet: frame once it is laid out.
      if (this.canvas.clientWidth && this.canvas.clientHeight) this.frame()
      else this.frameWhenSized = true
      this.framed = true
    } else if (meshes.length) {
      const box = new THREE.Box3().setFromObject(this.model)
      if (!box.isEmpty()) this.radius = Math.max(this.radius, box.getSize(new THREE.Vector3()).length() / 2)
    }
  }

  /** The board's tracks, pads, vias, pours and silk on its faces. */
  setCopper(pcb: Pcb | undefined, st: BoardState | undefined) {
    this.copper = pcb && st ? { pcb, st } : undefined
    for (const o of [...this.copperGroup.children]) {
      this.copperGroup.remove(o)
      disposeCopper(o)
    }
    if (this.copper) {
      try {
        this.copperGroup.add(boardCopper(this.copper.pcb, this.copper.st))
      } catch (e) {
        console.warn('board copper', e)
      }
    }
    this.placeBodies()
  }

  setParts(parts: PlacedModel[]) {
    this.parts = parts
    for (const o of [...this.partGroup.children]) {
      this.partGroup.remove(o)
      disposeTree(o)
    }
    for (const p of parts) {
      const o = partObject(p)
      o.userData.base = o.position.clone()
      this.partGroup.add(o)
    }
    this.setMeshes(this.meshes)
  }

  /** Shows measurement points and the line between them (on top of the model). */
  setMeasure(points: [number, number, number][]) {
    for (const o of [...this.measureGroup.children]) {
      if (o === this.snapMarker) continue
      this.measureGroup.remove(o)
      disposeTree(o)
    }
    const size = this.camera.position.distanceTo(this.controls.target) / 150
    for (const p of points) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color: HIGHLIGHT, depthTest: false }))
      dot.position.set(...p)
      dot.renderOrder = 10
      this.measureGroup.add(dot)
    }
    if (points.length === 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)))
      const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: HIGHLIGHT, dashSize: size * 2, gapSize: size, depthTest: false }))
      line.computeLineDistances()
      line.renderOrder = 10
      this.measureGroup.add(line)
    }
  }

  /** Screen position (CSS px in the canvas) of a world point. */
  toScreen(p: [number, number, number]): { x: number; y: number } {
    const v = new THREE.Vector3(...p).project(this.camera)
    const r = this.canvas.getBoundingClientRect()
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height }
  }

  /** Part blocks stay hidden where a real model replaces them. */
  private hiddenBlocks(): Set<string> {
    return new Set(this.realParts ? this.parts.map((p) => `part_${p.ref}`) : [])
  }

  setSketches(sketches: SketchLines[]) {
    this.sketches = sketches
    for (const o of [...this.sketchGroup.children]) {
      this.sketchGroup.remove(o)
      const l = o as THREE.LineSegments
      l.geometry.dispose()
      ;(l.material as THREE.Material).dispose()
    }
    for (const s of sketches) for (const o of sketchObjects(s, s.name === this.selected)) this.sketchGroup.add(o)
  }

  /** Re-reads the theme colours (app.css --view-*) and redraws. */
  applyTheme() {
    BODY = hex('--view-body')
    HIGHLIGHT = hex('--view-hl')
    SELECTED = hex('--view-sel')
    EDGE = hex('--view-edge')
    this.scene.background = new THREE.Color(hex('--view-bg'))
    const old = this.grid
    this.grid = new THREE.GridHelper(400, 40, hex('--view-grid'), hex('--view-grid-minor'))
    this.grid.rotation.x = Math.PI / 2
    this.helpers.remove(old)
    old.geometry.dispose()
    ;(old.material as THREE.Material).dispose()
    this.helpers.add(this.grid)
    this.setMeshes(this.meshes)
    this.setSketches(this.sketches)
  }

  select(name: string | undefined) {
    this.selected = name
    this.setMeshes(this.meshes)
    this.setSketches(this.sketches)
  }

  /** Points the camera at the whole model. */
  frame(dir: THREE.Vector3 = new THREE.Vector3(0.8, -1, 0.75)) {
    const box = new THREE.Box3().setFromObject(this.model)
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 30))
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3()).length()
    this.radius = size / 2
    const dist = size / (2 * Math.tan((this.camera.fov * Math.PI) / 360)) * 1.15
    this.camera.position.copy(center).add(dir.clone().normalize().multiplyScalar(dist))
    this.controls.target.copy(center)
    // Zoom limits keep the camera out of the model and the model on screen.
    this.controls.minDistance = Math.max(size / 2000, 0.05)
    this.controls.maxDistance = Math.max(dist * 20, 500)
    this.controls.update()
    this.updateClipping()
  }

  pick(clientX: number, clientY: number): Pick | undefined {
    const r = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const hit = ray
      .intersectObjects([...this.model.children, ...this.partGroup.children], true)
      .find((h) => (h.object as THREE.Mesh).isMesh && !h.object.userData.seeThrough)
    if (!hit) return undefined
    const name = hit.object.userData.name as string
    const data = this.meshes.find((m) => m.name === name)
    let face = -1
    if (data && hit.faceIndex !== undefined && hit.faceIndex !== null) {
      const tri = hit.faceIndex * 3
      for (let i = 0; i < data.faceGroups.length / 2; i++) {
        const start = data.faceGroups[i * 2]
        const count = data.faceGroups[i * 2 + 1]
        if (tri >= start && tri < start + count) {
          face = i
          break
        }
      }
    }
    const p = hit.point
    return { name, face, point: [round(p.x), round(p.y), round(p.z)] }
  }

  /**
   * pick, snapped: the nearest vertex, edge midpoint or arc center of the
   * body under the cursor within px screen pixels, else the nearest point
   * on an edge, else the surface point. Bodies seen through a transparent
   * one count too.
   */
  pickSnap(clientX: number, clientY: number, px = 12): Pick | undefined {
    const r = this.canvas.getBoundingClientRect()
    const mx = clientX - r.left
    const my = clientY - r.top
    const ndc = new THREE.Vector2((mx / r.width) * 2 - 1, -(my / r.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const hits = ray.intersectObjects([...this.model.children, ...this.partGroup.children], true).filter((h) => (h.object as THREE.Mesh).isMesh)
    const names = [...new Set(hits.map((h) => h.object.userData.name as string).filter(Boolean))]
    const solid = hits.find((h) => !h.object.userData.seeThrough)
    // Only bodies under the cursor, so far ones never steal the snap.
    const screen = (p: V3) => {
      const v = new THREE.Vector3(...p).project(this.camera)
      return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height, z: v.z }
    }
    // A snap point hidden behind the first solid surface does not count.
    const depth = solid ? solid.distance : Infinity
    const visible = (p: V3) => this.camera.position.distanceTo(new THREE.Vector3(...p)) <= depth + Math.max(depth * 0.01, 0.05)

    let best: { p: V3; kind: SnapKind; d: number; name: string } | undefined
    const order: Record<SnapKind, number> = { vertex: 0, center: 1, midpoint: 2, edge: 3 }
    for (const name of names) {
      const s = this.snapsOf(name)
      if (!s) continue
      for (const kind of ['vertex', 'center', 'midpoint'] as const) {
        for (const p of s[kind]) {
          const q = screen(p)
          const d = Math.hypot(q.x - mx, q.y - my)
          if (d > px || q.z > 1 || !visible(p)) continue
          // Prefer vertices over centers over midpoints when they are close.
          if (!best || d + order[kind] * 2 < best.d + order[best.kind] * 2) best = { p, kind, d, name }
        }
      }
      if (best) continue
      for (const line of s.lines) {
        for (let i = 0; i + 1 < line.length; i++) {
          const a = screen(line[i])
          const b = screen(line[i + 1])
          const abx = b.x - a.x
          const aby = b.y - a.y
          const len2 = abx * abx + aby * aby || 1
          const t = Math.max(0, Math.min(1, ((mx - a.x) * abx + (my - a.y) * aby) / len2))
          const d = Math.hypot(a.x + abx * t - mx, a.y + aby * t - my)
          if (d > px * 0.6 || (best && d >= best.d)) continue
          const pa = line[i]
          const pb = line[i + 1]
          const p: V3 = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]
          if (visible(p)) best = { p, kind: 'edge', d, name }
        }
      }
    }
    if (best) {
      const base = this.pick(clientX, clientY)
      return { name: best.name, face: base?.name === best.name ? base.face : -1, point: [round(best.p[0]), round(best.p[1]), round(best.p[2])], snap: best.kind }
    }

    return this.pick(clientX, clientY)
  }

  private snapsOf(name: string): Snaps | undefined {
    const hit = this.snaps.get(name)
    if (hit) return hit
    const m = this.meshes.find((x) => x.name === name)
    if (!m) return undefined
    const s = snapPoints(m)
    this.snaps.set(name, s)
    return s
  }

  /** Marks the point the cursor would snap to (or nothing). */
  showSnap(p: Pick | undefined) {
    if (this.snapMarker) {
      this.measureGroup.remove(this.snapMarker)
      disposeTree(this.snapMarker)
      this.snapMarker = undefined
    }
    if (!p?.snap) return
    const size = this.camera.position.distanceTo(new THREE.Vector3(...p.point)) / 90
    const mat = new THREE.LineBasicMaterial({ color: SELECTED, depthTest: false })
    let geo: THREE.BufferGeometry
    if (p.snap === 'vertex') geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(size, size, size))
    else if (p.snap === 'center') {
      const pts: THREE.Vector3[] = []
      for (let i = 0; i <= 24; i++) pts.push(new THREE.Vector3(Math.cos((i / 24) * Math.PI * 2) * size * 0.7, Math.sin((i / 24) * Math.PI * 2) * size * 0.7, 0))
      pts.push(new THREE.Vector3(-size, 0, 0), new THREE.Vector3(size, 0, 0))
      geo = new THREE.BufferGeometry().setFromPoints(pts)
    } else if (p.snap === 'midpoint') {
      const h = size * 0.6
      geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-h, -h * 0.6, 0), new THREE.Vector3(h, -h * 0.6, 0), new THREE.Vector3(0, h, 0), new THREE.Vector3(-h, -h * 0.6, 0)])
    } else geo = new THREE.EdgesGeometry(new THREE.OctahedronGeometry(size * 0.45))
    const o = p.snap === 'vertex' || p.snap === 'edge' ? new THREE.LineSegments(geo, mat) : new THREE.Line(geo, mat)
    o.position.set(...p.point)
    // 2D markers face the camera.
    if (p.snap === 'center' || p.snap === 'midpoint') o.quaternion.copy(this.camera.quaternion)
    o.renderOrder = 11
    this.snapMarker = o
    this.measureGroup.add(o)
  }

  /**
   * Renders fixed views offscreen for an agent and returns PNG base64.
   * Highlighted bodies are orange, the rest grey; hidden ones are left out.
   */
  private shot: THREE.WebGLRenderer | undefined

  /**
   * Renders fixed views offscreen for an agent and returns PNG base64.
   * Highlighted bodies are orange, the rest grey; hidden ones are left out.
   * A section removes the material between the camera and the cut plane.
   */
  async renderViews(opts: RenderOptions): Promise<{ images: { mime: string; data: string }[]; views: string[] }> {
    const size = opts.size
    // A separate renderer with its own canvas, so color management matches
    // the viewport and toDataURL works directly.
    if (!this.shot) {
      this.shot = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, reversedDepthBuffer: true })
      this.shot.localClippingEnabled = true
    }
    const r = this.shot
    r.setPixelRatio(1)
    r.setSize(size, size, false)

    const cam = new THREE.PerspectiveCamera(35, 1, 0.1, 10000)
    const hide = new Set(opts.hide ?? [])
    const hl = new Set(opts.highlight ?? [])
    const clip = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)
    const planes = opts.section ? [clip] : []

    const shading: Shading = opts.shading ?? (opts.edges === false ? 'realistic' : 'normal')
    const real = shading === 'realistic'
    r.toneMapping = real ? REAL_LIGHT.toneMapping : THREE.NoToneMapping
    r.toneMappingExposure = real ? REAL_LIGHT.exposure : 1

    const group = new THREE.Group()
    const blocks = this.hiddenBlocks()
    for (const m of this.meshes) {
      if (hide.has(m.name) || (blocks.has(m.name) && !hl.has(m.name))) continue
      const o = bodyObject(m, hl.has(m.name) ? RENDER.highlight : undefined, planes, opts.edges !== false, RENDER, false, environment(r), shading)
      const off = opts.offsets?.[m.name]
      if (off) o.position.set(off[0], off[1], off[2])
      group.add(o)
    }
    for (const p of this.parts) {
      if (hide.has(`part_${p.ref}`) || hl.has(`part_${p.ref}`)) continue
      const o = partObject(p, planes)
      const off = opts.offsets?.[`part_${p.ref}`]
      if (off) o.position.add(new THREE.Vector3(off[0], off[1], off[2]))
      group.add(o)
    }
    if (this.copper && !hide.has('board')) {
      try {
        const cu = boardCopper(this.copper.pcb, this.copper.st)
        const off = opts.offsets?.board
        if (off) cu.position.set(off[0], off[1], off[2])
        group.add(cu)
      } catch (e) {
        console.warn('board copper', e)
      }
    }
    for (const sk of this.sketches) {
      if (hide.has(sk.name) || (sk.used && !hl.has(sk.name))) continue
      for (const o of sketchObjects(sk, hl.has(sk.name))) group.add(o)
    }

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(RENDER.bg)
    if (real) scene.environment = environment(r)
    scene.environmentIntensity = REAL_LIGHT.env
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, real ? REAL_LIGHT.hemi : 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, real ? REAL_LIGHT.sun : 1.5)
    scene.add(sun)
    scene.add(group)
    const box = new THREE.Box3().setFromObject(group)
    if (box.isEmpty()) box.set(new THREE.Vector3(-20, -20, 0), new THREE.Vector3(20, 20, 20))
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1)
    const cells = Math.max(10, Math.ceil((radius * 4) / 10))
    const grid = new THREE.GridHelper(cells * 10, cells, RENDER.grid, RENDER.gridMinor)
    grid.rotation.x = Math.PI / 2
    grid.position.set(Math.round(center.x / 10) * 10, Math.round(center.y / 10) * 10, box.min.z - 0.01)
    scene.add(grid)
    scene.add(axes(Math.max(10, radius * 0.4)))

    const images: { mime: string; data: string }[] = []
    for (const view of opts.views) {
      const dir = (VIEW_DIRS[view] ?? VIEW_DIRS.iso).clone().normalize()
      if (opts.section) {
        const axis = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) }[opts.section.axis]
        // Keep the side away from the camera; Three clips where n·p + c < 0.
        const side = dir.dot(axis) > 1e-6 ? -1 : 1
        clip.normal.copy(axis).multiplyScalar(side)
        clip.constant = -side * opts.section.at
      }
      const dist = (radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.05
      cam.position.copy(center).add(dir.multiplyScalar(dist))
      if (view === 'top' || view === 'bottom') cam.up.set(0, 1, 0)
      else cam.up.set(0, 0, 1)
      cam.near = Math.max(dist - radius * 1.5, dist / 200)
      cam.far = dist + radius * 3
      cam.lookAt(center)
      cam.updateProjectionMatrix()
      sun.position.copy(cam.position).add(new THREE.Vector3(radius, -radius, radius * 2))

      r.render(scene, cam)

      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(r.domElement, 0, 0)
      ctx.font = `${Math.round(size / 28)}px system-ui, sans-serif`
      ctx.fillStyle = '#444'
      ctx.fillText(view + (opts.section ? ` · section ${opts.section.axis}=${opts.section.at}` : ''), 8, Math.round(size / 20))
      const url = canvas.toDataURL('image/png')
      images.push({ mime: 'image/png', data: url.slice(url.indexOf(',') + 1) })
    }

    group.traverse((c) => {
      const m = c as THREE.Mesh
      m.geometry?.dispose()
      // Board copper materials are shared module singletons.
      if (!m.userData.overlay) (m.material as THREE.Material | undefined)?.dispose?.()
    })
    grid.geometry.dispose()

    return { images, views: opts.views }
  }
}

const VIEW_DIRS: Record<string, THREE.Vector3> = {
  iso: new THREE.Vector3(1, -1, 0.8),
  iso_back: new THREE.Vector3(-1, 1, 0.8),
  top: new THREE.Vector3(0, -0.0001, 1),
  bottom: new THREE.Vector3(0, 0.0001, -1),
  front: new THREE.Vector3(0, -1, 0.0001),
  back: new THREE.Vector3(0, 1, 0.0001),
  left: new THREE.Vector3(-1, 0, 0.0001),
  right: new THREE.Vector3(1, 0, 0.0001),
}

function round(v: number) {
  return Math.round(v * 100) / 100
}

function axes(len: number) {
  const g = new THREE.Group()
  const mk = (to: THREE.Vector3, color: number) => {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), to])
    g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false })))
  }
  mk(new THREE.Vector3(len, 0, 0), 0xd64545)
  mk(new THREE.Vector3(0, len, 0), 0x3a9a4a)
  mk(new THREE.Vector3(0, 0, len), 0x3b6fd6)
  g.renderOrder = 10
  return g
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh
    m.geometry?.dispose()
    const mat = m.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
    else mat?.dispose()
  })
}

/** A real part model placed on the board. */
function partObject(p: PlacedModel, clip: THREE.Plane[] = []): THREE.Group {
  const g = new THREE.Group()
  g.userData.name = `part_${p.ref}`
  for (const grp of p.mesh.groups) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(grp.positions, 3))
    geo.computeVertexNormals()
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(grp.color[0], grp.color[1], grp.color[2]),
      metalness: 0.2,
      roughness: 0.55,
      side: THREE.DoubleSide,
      clippingPlanes: clip,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.userData.name = `part_${p.ref}`
    g.add(mesh)
  }
  // Footprint space → board: mirror for the bottom, rotate, move, lift.
  if (p.side === 'bottom') g.scale.set(-1, 1, -1)
  const outer = new THREE.Group()
  outer.add(g)
  outer.rotation.z = (p.rotation * Math.PI) / 180
  outer.position.set(p.at.x, p.at.y, p.z)
  outer.userData.name = `part_${p.ref}`
  return outer
}

function sketchObjects(s: SketchLines, selected: boolean): THREE.Object3D[] {
  const color = !s.ok ? 0xc4372f : selected ? SELECTED : s.dof > 0 ? 0xb87414 : 0x2f8a56
  const out: THREE.Object3D[] = []
  const mk = (arr: Float32Array, mat: THREE.LineBasicMaterial | THREE.LineDashedMaterial) => {
    if (!arr.length) return
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    const l = new THREE.LineSegments(g, mat)
    if (mat instanceof THREE.LineDashedMaterial) l.computeLineDistances()
    l.renderOrder = 5
    l.userData.sketch = s.name
    out.push(l)
  }
  const opacity = s.used && !selected ? 0.35 : 1
  mk(s.lines, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: !selected }))
  mk(s.construction, new THREE.LineDashedMaterial({ color, dashSize: 1.5, gapSize: 1, transparent: true, opacity: opacity * 0.7 }))
  return out
}

function bodyObject(
  m: MeshData,
  override?: number,
  clip: THREE.Plane[] = [],
  edges = true,
  palette = { body: BODY, edge: EDGE },
  selected = false,
  env?: THREE.Texture,
  shading: Shading = 'normal',
): THREE.Group {
  const g = new THREE.Group()
  g.userData.name = m.name

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(m.vertices, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3))
  geo.setIndex(new THREE.BufferAttribute(m.triangles, 1))

  // In the CAD view a material shows its base color, so bodies stay apart.
  const base = m.material ? new THREE.Color(m.material.color).getHex() : m.color ? new THREE.Color(m.color).getHex() : palette.body
  const color = override ?? base
  // See-through bodies: no depth writes, so what is inside shows; their
  // edges stay faint but visible.
  const xray = shading === 'xray'
  const wire = shading === 'wireframe'
  const ownOpacity = m.opacity !== undefined && m.opacity < 1 ? m.opacity : 1
  const opacity = xray ? Math.min(ownOpacity, 0.22) : wire ? 0.04 : ownOpacity
  const usePbr = shading === 'realistic' && !!m.material && override === undefined
  const seeThrough = opacity < 1 || (usePbr && (m.material?.opacity ?? 1) < 1)
  const side = clip.length || xray ? THREE.DoubleSide : THREE.FrontSide
  if (usePbr && needsUV(m.material)) geo.setAttribute('uv', new THREE.BufferAttribute(computeUV(m.vertices, m.normals, m.material!.uv), 2))
  const mat = usePbr
    ? pbrMaterial(m.material!, { clip, side, emissiveBoost: selected ? 0.15 : 0, env })
    : new THREE.MeshStandardMaterial({
        color,
        transparent: seeThrough,
        opacity,
        depthWrite: !seeThrough,
        // Selection lifts the body slightly and draws its edges in the
        // selection colour, so the body keeps the colour it was given.
        emissive: selected ? color : 0x000000,
        emissiveIntensity: selected ? 0.18 : 0,
        metalness: shading === 'realistic' ? 0.1 : 0.05,
        roughness: shading === 'realistic' ? 0.55 : 0.65,
        envMap: shading === 'realistic' ? env ?? null : null,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        side,
        clippingPlanes: clip,
      })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.userData.name = m.name
  mesh.userData.seeThrough = seeThrough
  if (seeThrough) mesh.renderOrder = 2
  g.add(mesh)

  if (m.decals?.length && override === undefined && (shading === 'realistic' || shading === 'normal')) {
    for (const d of decalObjects(mesh, m.decals, clip, shading === 'realistic' ? env : undefined)) {
      d.userData.name = m.name
      g.add(d)
    }
  }

  // Realistic views read as a product, not a drawing: edges only when selected.
  const showEdges = edges && m.edges.length && (shading !== 'realistic' || selected || override !== undefined)
  if (showEdges) {
    const faint = seeThrough && !wire
    const eg = new THREE.BufferGeometry()
    eg.setAttribute('position', new THREE.BufferAttribute(m.edges, 3))
    const lines = new THREE.LineSegments(
      eg,
      new THREE.LineBasicMaterial({
        color: selected ? SELECTED : wire && (m.material || m.color) ? color : palette.edge,
        clippingPlanes: clip,
        transparent: faint,
        opacity: faint ? Math.max(0.35, opacity) : 1,
      }),
    )
    lines.userData.name = m.name
    g.add(lines)
  }

  return g
}

/** Ends, midpoints and arc centers of a body's B-rep edges. */
export function snapPoints(m: MeshData): Snaps {
  const out: Snaps = { vertex: [], midpoint: [], center: [], lines: [] }
  // Edges meet at vertices: keep each point once per kind.
  const seen = new Set<string>()
  const add = (list: V3[], p: V3) => {
    const k = (list === out.vertex ? 'v' : 'c') + p.map((v) => v.toFixed(3)).join(',')
    if (seen.has(k)) return
    seen.add(k)
    list.push(p)
  }
  const e = m.edges
  const groups = m.edgeGroups?.length ? m.edgeGroups : new Uint32Array([0, e.length / 3])
  for (let g = 0; g < groups.length; g += 2) {
    const start = groups[g]
    const count = groups[g + 1]
    if (count < 2) continue
    // Edges are line segments: points 2i and 2i+1. Join them into a polyline.
    const pts: V3[] = []
    for (let i = start; i < start + count; i++) {
      const p: V3 = [e[i * 3], e[i * 3 + 1], e[i * 3 + 2]]
      const last = pts[pts.length - 1]
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > 1e-6) pts.push(p)
    }
    if (pts.length < 2) continue
    out.lines.push(pts)
    const a = pts[0]
    const b = pts[pts.length - 1]
    const closed = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-4
    if (!closed) {
      add(out.vertex, a)
      add(out.vertex, b)
    }
    // Midpoint along the length.
    let total = 0
    for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i])
    if (!closed && total > 1e-6) {
      let walked = 0
      for (let i = 1; i < pts.length; i++) {
        const d = dist(pts[i - 1], pts[i])
        if (walked + d >= total / 2) {
          const t = (total / 2 - walked) / (d || 1)
          const p0 = pts[i - 1]
          const p1 = pts[i]
          out.midpoint.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t])
          break
        }
        walked += d
      }
    }
    // Arcs and circles: the center of the circle through three points.
    if (pts.length >= 3) {
      const c = circleCenter(pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)])
      if (c && pts.every((p) => Math.abs(dist(p, c) - dist(pts[0], c)) < Math.max(1e-3, dist(pts[0], c) * 0.02))) add(out.center, c)
    }
  }

  return out
}

function dist(a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** Center of the circle through three points, or undefined when collinear. */
function circleCenter(a: V3, b: V3, c: V3): V3 | undefined {
  const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  const ac = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2])
  const n = new THREE.Vector3().crossVectors(ab, ac)
  const n2 = n.lengthSq()
  if (n2 < 1e-12) return undefined
  const t1 = new THREE.Vector3().crossVectors(n, ab).multiplyScalar(ac.lengthSq())
  const t2 = new THREE.Vector3().crossVectors(ac, n).multiplyScalar(ab.lengthSq())
  const o = t1.add(t2).divideScalar(2 * n2)

  return [a[0] + o.x, a[1] + o.y, a[2] + o.z]
}
