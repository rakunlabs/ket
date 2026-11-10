// The document is the single source of truth: plain JSON, readable by people
// and models alike. Geometry is never stored; it is rebuilt from the feature
// list by the kernel. Every number may be an expression over parameters
// ("wall * 2 + 1"), so changing a parameter rebuilds everything that uses it.

/** A number, or an expression string over parameters ("board_w + 2*wall"). */
export type Expr = number | string

export type Vec3E = [Expr, Expr, Expr]
export type Vec2E = [Expr, Expr]

export interface Parameter {
  name: string
  expr: Expr
  unit?: string
  description?: string
}

/** Selector picks faces or edges by meaning, not by index. */
export interface Selector {
  /**
   * Direction words: ">Z" (top-most faces along +Z), "<Z" (bottom-most),
   * "|Z" (edges parallel to Z), "#Z" (faces whose normal is ⟂ Z, i.e. the
   * side walls), "all".
   */
  where?: string
  /** Faces or edges within this box [min, max]. */
  inBox?: [Vec3E, Vec3E]
  /** Surface/curve type: plane, cylinder, line, circle ... */
  type?: string
  /** Only faces/edges that touch this point (within 0.01mm). */
  near?: Vec3E
}

export interface Transform {
  translate?: Vec3E
  /** Rotation in degrees about the axes, applied X then Y then Z, about the origin. */
  rotate?: Vec3E
}

export type Plane = 'XY' | 'XZ' | 'YZ'

/**
 * A constrained 2D sketch. Geometry refers to points by name; constraints
 * hold the design intent ("l1 is horizontal", "w = board_w"). The solver
 * moves the points to satisfy the constraints; the positions given here are
 * only the starting guess. Plane coordinates (u, v): XY → (x, y),
 * XZ → (x, z), YZ → (y, z).
 */
export interface Sketch {
  name: string
  plane: Plane
  offset?: Expr
  points: SketchPoint[]
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  note?: string
}

export interface SketchPoint {
  id: string
  x: Expr
  y: Expr
  /** A fixed point is not moved by the solver. */
  fixed?: boolean
}

export type SketchEntity =
  | { id: string; kind: 'line'; a: string; b: string; construction?: boolean }
  | { id: string; kind: 'circle'; center: string; r: Expr; construction?: boolean }
  /** Arc from start to end, counter-clockwise around center. */
  | { id: string; kind: 'arc'; center: string; start: string; end: string; construction?: boolean }

export type SketchConstraint =
  | { kind: 'coincident'; a: string; b: string }
  | { kind: 'horizontal'; line: string }
  | { kind: 'vertical'; line: string }
  | { kind: 'parallel'; a: string; b: string }
  | { kind: 'perpendicular'; a: string; b: string }
  | { kind: 'equal'; a: string; b: string }
  | { kind: 'tangent'; a: string; b: string }
  | { kind: 'point_on'; point: string; on: string }
  | { kind: 'midpoint'; point: string; line: string }
  | { kind: 'distance'; a: string; b: string; value: Expr }
  | { kind: 'distance_x'; a: string; b: string; value: Expr }
  | { kind: 'distance_y'; a: string; b: string; value: Expr }
  | { kind: 'length'; line: string; value: Expr }
  | { kind: 'radius'; of: string; value: Expr }
  | { kind: 'angle'; a: string; b: string; value: Expr }
  | { kind: 'fix'; point: string; x?: Expr; y?: Expr }
  | { kind: 'symmetric'; a: string; b: string; about: string }

/** 2D profile for extrusions; points are in the plane's local coordinates. */
export type Profile =
  | { kind: 'rect'; w: Expr; h: Expr; r?: Expr; center?: Vec2E }
  | { kind: 'circle'; r: Expr; center?: Vec2E }
  | { kind: 'polygon'; points: Vec2E[] }
  | { kind: 'slot'; length: Expr; width: Expr; center?: Vec2E; angle?: Expr }

/** One cross-section of a loft: a sketch, or a profile on a plane. */
export interface Section {
  sketch?: string
  plane?: Plane
  offset?: Expr
  profile?: Profile
}

interface FeatureBase {
  /** Unique, human-readable name, e.g. "case_body", "usb_cutout". */
  name: string
  /** Hidden features still exist and can be used as tools. */
  hidden?: boolean
  /** Short note: why this feature exists. Helps the next edit. */
  note?: string
  /** Viewport color (CSS), e.g. "#4a90d9". */
  color?: string
  /** Viewport opacity 0..1; lower shows what is inside. Display only. */
  opacity?: number
}

export type Feature =
  | (FeatureBase & { type: 'box'; size: Vec3E; center?: boolean | [boolean, boolean, boolean] } & Transform)
  | (FeatureBase & { type: 'cylinder'; r: Expr; h: Expr; axis?: 'X' | 'Y' | 'Z' } & Transform)
  | (FeatureBase & { type: 'sphere'; r: Expr } & Transform)
  | (FeatureBase & { type: 'extrude'; plane?: Plane; offset?: Expr; profile?: Profile; sketch?: string; distance: Expr; symmetric?: boolean } & Transform)
  | (FeatureBase & { type: 'revolve'; sketch?: string; plane?: Plane; offset?: Expr; profile?: Profile; axis: 'X' | 'Y' | 'Z'; angle?: Expr } & Transform)
  | (FeatureBase & { type: 'loft'; sections: Section[]; ruled?: boolean } & Transform)
  | (FeatureBase & { type: 'sweep'; sketch?: string; profile?: Profile; path: Vec3E[]; bend?: Expr } & Transform)
  | (FeatureBase & { type: 'boolean'; op: 'union' | 'cut' | 'intersect'; target: string; tools: string[] })
  | (FeatureBase & { type: 'fillet'; target: string; r: Expr; edges?: Selector })
  | (FeatureBase & { type: 'chamfer'; target: string; d: Expr; edges?: Selector })
  | (FeatureBase & { type: 'shell'; target: string; thickness: Expr; open?: Selector })
  | (FeatureBase & { type: 'transform'; target: string } & Transform)
  | (FeatureBase & { type: 'pattern'; target: string; kind: 'linear'; count: Expr; step: Vec3E })
  | (FeatureBase & { type: 'pattern'; target: string; kind: 'grid'; count: Vec2E; step: Vec2E })

export type FeatureType = Feature['type']

/**
 * A check is a requirement the design must keep meeting: "wall >= 1.6",
 * "fits(board, case_inner)". run_checks evaluates all of them; a parameter
 * change that breaks one is visible at once.
 */
export type Check =
  | { name: string; kind: 'expr'; expr: string; note?: string }
  | { name: string; kind: 'min_distance'; a: string; b: string; min: Expr; note?: string }
  | { name: string; kind: 'no_overlap'; a: string; b: string; note?: string }
  | { name: string; kind: 'inside'; inner: string; outer: string; margin?: Expr; note?: string }
  | { name: string; kind: 'volume'; target: string; min?: Expr; max?: Expr; note?: string }

export interface Doc {
  version: 1
  units: 'mm'
  parameters: Parameter[]
  sketches: Sketch[]
  features: Feature[]
  checks: Check[]
  pcb?: Pcb
  meta: { description?: string }
}

// ── PCB ────────────────────────────────────────────────────────────────
// Board coordinates are the world XY plane in mm (y up); the board's
// bottom face sits at z = placement.z, so an enclosure can be designed
// around it with the same parameters.

export type CopperLayer = 'F.Cu' | 'B.Cu' | 'In1.Cu' | 'In2.Cu'

export interface P {
  x: number
  y: number
}

export interface Pad {
  number: string
  shape: 'rect' | 'oval' | 'circle' | 'polygon'
  /** Relative to the footprint origin. */
  at: P
  /** Degrees CCW. */
  rotation: number
  w: number
  h: number
  /** Polygon outline relative to at, unrotated. */
  polygon?: P[]
  drill?: { d: number; slot?: number; plated: boolean }
  layer: 'top' | 'bottom' | 'through'
}

export interface Footprint {
  name: string
  pads: Pad[]
  /** Silk lines [x1, y1, x2, y2, width] relative to the origin. */
  silk: [number, number, number, number, number][]
  /** Body outline used for courtyard checks and 3D blocks. */
  courtyard: P[]
  /** NPTH holes of the part (locating posts). */
  holes?: { at: P; d: number }[]
  /** Pad number → pin name from the symbol ("1" → "GND"). */
  pins: Record<string, string>
  /** Body height above the board, mm (estimate; settable). */
  height?: number
  /** EasyEDA 3D model reference, in footprint coordinates. */
  model?: Model3D
  /** Schematic symbol (EasyEDA units are 10 mil; we keep them as given). */
  symbol?: SymbolDef
}

/**
 * A schematic symbol in symbol-local units (EasyEDA's 10-mil grid, y down):
 * body rectangles/ellipses and pins with their connection point.
 */
export interface SymbolDef {
  rects: [number, number, number, number][]
  circles: [number, number, number][]
  pins: { number: string; name: string; x: number; y: number; /** direction the pin points out of the body, degrees */ dir: number; length: number }[]
}

export interface Model3D {
  uuid: string
  /** Where the model's bounding box center sits (footprint mm). */
  origin: P
  /** Height of the model's bottom above the board face (negative for THT legs). */
  z: number
  /** EasyEDA euler rotation in degrees (XYZ). */
  rotation: [number, number, number]
}

export interface Component {
  ref: string
  /** LCSC part number, e.g. "C6186". */
  lcsc: string
  value?: string
  mpn?: string
  description?: string
  package?: string
  basic?: boolean
  at: Vec2E
  rotation?: Expr
  side?: 'top' | 'bottom'
  /** Edge-mounted (USB, headers): the body may overhang the board edge; pads must stay on it. */
  edge?: boolean
  /** Schematic position [x, y] in symbol units (10 mil), set by the user or auto-placed. */
  sch?: [number, number]
  note?: string
  height?: Expr
  footprint: Footprint
}

export interface Net {
  name: string
  /** Pin refs "U1.3" (pad numbers, resolved from names on connect). */
  pins: string[]
  class?: string
}

export interface NetClass {
  name: string
  track: number
  clearance: number
  via_drill: number
  via_diameter: number
}

export interface Track {
  net: string
  layer: CopperLayer
  width: number
  points: [number, number][]
}

export interface Via {
  net: string
  at: [number, number]
  drill: number
  diameter: number
}

/**
 * A copper pour. The fill is computed (never stored): the zone polygon
 * (default: the whole board) minus clearance around other nets' copper,
 * with thermal spokes to same-net pads and islands that reach no pad of
 * the net removed.
 */
export interface Zone {
  net: string
  layer: CopperLayer
  /** Polygon in board coordinates; omitted = the board outline. */
  polygon?: [number, number][]
  clearance?: number
  /** Distance kept from the board edge. */
  edge?: number
  thermal?: { gap: number; spoke: number } | false
  /** Lower priority zones are filled first and give way to higher ones. */
  priority?: number
}

export interface Pcb {
  /** Board outline: a closed XY sketch (inner circles become holes) or a rect. */
  outline: { sketch: string } | { rect: { w: Expr; h: Expr; r?: Expr; center?: Vec2E } }
  thickness: Expr
  layers: 2 | 4
  rules: 'jlcpcb'
  placement?: { z?: Expr }
  components: Component[]
  nets: Net[]
  classes: NetClass[]
  tracks: Track[]
  vias: Via[]
  zones?: Zone[]
  /** Schematic wires between pins of the same net (drawing only; the netlist decides connectivity). */
  wires?: Wire[]
  holes: { at: Vec2E; d: Expr }[]
}

/** A schematic wire from pin a to pin b ("R1.2"), with optional bend points (symbol units). */
export interface Wire {
  a: string
  b: string
  points?: [number, number][]
}

export function emptyDoc(): Doc {
  return { version: 1, units: 'mm', parameters: [], sketches: [], features: [], checks: [], meta: {} }
}

/** Fills fields added after a document was written. */
export function normalizeDoc(doc: Doc): Doc {
  if (!doc.sketches) doc.sketches = []
  return doc
}

/** Sketches a feature uses. */
export function sketchesOf(f: Feature): string[] {
  if ((f.type === 'extrude' || f.type === 'revolve' || f.type === 'sweep') && f.sketch) return [f.sketch]
  if (f.type === 'loft') return f.sections.flatMap((s) => (s.sketch ? [s.sketch] : []))
  return []
}

/** Features that consume other features; consumed bodies are not shown. */
export function inputsOf(f: Feature): string[] {
  switch (f.type) {
    case 'boolean':
      return [f.target, ...f.tools]
    case 'fillet':
    case 'chamfer':
    case 'shell':
    case 'transform':
    case 'pattern':
      return [f.target]
    default:
      return []
  }
}

/**
 * Bodies are the features that are not consumed by a later feature: what
 * the model actually consists of right now.
 */
export function bodies(doc: Doc): Feature[] {
  const used = new Set<string>()
  for (const f of doc.features) for (const i of inputsOf(f)) used.add(i)

  return doc.features.filter((f) => !used.has(f.name) && !f.hidden)
}

export function findFeature(doc: Doc, name: string): Feature | undefined {
  return doc.features.find((f) => f.name === name)
}
