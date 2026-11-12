// Result types of the kernel, shared by the worker client, the session and the UI.

import type { Check, Decal, Feature, Material, Plane } from '../doc'
import type { SolvedSketch } from '../sketch'

export type V3 = [number, number, number]
export type BBox = [V3, V3]

export interface FeatureStatus {
  name: string
  type: Feature['type']
  ok: boolean
  error?: string
  warnings?: string[]
  bbox?: BBox
  volume?: number
  solids?: number
  /** Build time when slow (≥ 300 ms). */
  ms?: number
  faces?: number
  edges?: number
  /** A triangle-mesh body (imported STL / 3MF): its triangle count. It has no faces or edges to select. */
  triangles?: number
}

export interface SketchStatus {
  name: string
  plane: Plane
  ok: boolean
  status: SolvedSketch['status']
  dof: number
  loops: number
  message?: string
}

export interface BuildResult {
  ok: boolean
  sketches: SketchStatus[]
  /** Parameter values after resolving expressions. */
  parameters: Record<string, number>
  parameterError?: string
  features: FeatureStatus[]
  /** Names of the visible result bodies. */
  bodies: string[]
  /** Problems with materials or decals (display only, never fail the build). */
  appearance?: string[]
  /** Where the last build spent its time, ms (worker): imports, build, mesh, board. */
  timing?: Record<string, number>
}

export interface MeshData {
  name: string
  key: string
  color?: string
  vertices: Float32Array
  normals: Float32Array
  triangles: Uint32Array
  edges: Float32Array
  /** edgeGroups[i] = [start, count] in points of edges for B-rep edge i;
   *  the ruler snaps to their ends, midpoints and arc centers. */
  edgeGroups: Uint32Array
  /** faceGroups[i] = [start, count] in triangles for face i. */
  faceGroups: Uint32Array
  /** RGB per vertex from slicer paint (3MF); -1 where a triangle is unpainted (the body color shows). */
  colors?: Float32Array
  /** 0..1, from the feature; 1 when unset. */
  opacity?: number
  /** The feature's material (display only). */
  material?: Material
  /** Decals projected onto this body, with numbers resolved. */
  decals?: ResolvedDecal[]
  /** Exploded-view offset (display only). */
  explode?: V3
}

export interface ResolvedDecal extends Omit<Decal, 'at' | 'size' | 'depth' | 'rotation' | 'font_size'> {
  at: V3
  size: [number, number]
  depth: number
  rotation: number
  font_size?: number
}

/** A sketch placed on a face: origin and axes in world coordinates (u, v in the face, normal out of it). */
export interface SketchFrame {
  origin: V3
  normal: V3
  u: V3
  v: V3
}

export interface SketchLines {
  name: string
  ok: boolean
  dof: number
  /** Consumed by a feature; drawn faintly. */
  used: boolean
  lines: Float32Array
  construction: Float32Array
}

export interface CheckResult {
  name: string
  kind: Check['kind']
  ok: boolean
  /** What was measured, e.g. "distance 0.40 mm < 1.00 mm". */
  detail: string
  note?: string
  /** Time it took when slow (≥ 200 ms). */
  ms?: number
}

export interface FaceInfo {
  index: number
  type: string
  center: V3
  normal?: V3
  area: number
}

export interface EdgeInfo {
  index: number
  type: string
  start: V3
  end: V3
  length: number
}

/** Body names the board adds to the model. */
export const BOARD = 'board'
export const PART_PREFIX = 'part_'
