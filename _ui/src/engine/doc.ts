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

export type Anchor = 'min' | 'center' | 'max'

/** Puts a point of the body's bounding box (after rotate) at to; translate is added after. */
export interface Align {
  to: Vec3E
  /** Which point of the box per axis (default center, center, min: the middle of the bottom). */
  anchor?: [Anchor, Anchor, Anchor]
}

/** Which separate solids of a body to keep. Without any field: all of them (a copy). */
export interface SolidPick {
  /** The solid nearest to this point (0 when the point is inside it). */
  near?: Vec3E
  /** Solids whose box center lies in this box. */
  inBox?: [Vec3E, Vec3E]
  /** Solids by their index in list_solids. */
  index?: number[]
  /** Only the n largest by volume (after the other filters). */
  largest?: number
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
  /**
   * Sketch on a flat face of a built feature instead of a fixed plane: the
   * face is picked by selector (">Z": the top), never by index, so it
   * follows rebuilds. Origin at the face's center, normal out of the face;
   * offset moves along the normal. plane is the nearest axis plane, kept
   * for display and for checks that need one.
   */
  on?: { feature: string; face: Selector }
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
export type Profile = (
  | { kind: 'rect'; w: Expr; h: Expr; r?: Expr; center?: Vec2E }
  | { kind: 'circle'; r: Expr; center?: Vec2E }
  | { kind: 'polygon'; points: Vec2E[] }
  | { kind: 'slot'; length: Expr; width: Expr; center?: Vec2E; angle?: Expr }
) & {
  /** Offset the outline inwards by this many mm (negative grows it): walls, lips and clearances from one outline. */
  inset?: Expr
}

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
  /** Name of a material (doc.materials). Display only. */
  material?: string
}

export type Feature =
  | (FeatureBase & { type: 'box'; size: Vec3E; center?: boolean | [boolean, boolean, boolean] } & Transform)
  | (FeatureBase & { type: 'cylinder'; r: Expr; h: Expr; axis?: 'X' | 'Y' | 'Z' } & Transform)
  | (FeatureBase & { type: 'sphere'; r: Expr } & Transform)
  | (FeatureBase & { type: 'extrude'; plane?: Plane; offset?: Expr; profile?: Profile; sketch?: string; distance: Expr; symmetric?: boolean } & Transform)
  | (FeatureBase & { type: 'revolve'; sketch?: string; plane?: Plane; offset?: Expr; profile?: Profile; axis: 'X' | 'Y' | 'Z'; angle?: Expr } & Transform)
  | (FeatureBase & { type: 'loft'; sections: Section[]; ruled?: boolean } & Transform)
  | (FeatureBase & { type: 'sweep'; sketch?: string; profile?: Profile; path: Vec3E[]; bend?: Expr } & Transform)
  | (FeatureBase & { type: 'boolean'; op: 'union' | 'cut' | 'intersect'; target: string; tools: string[]; separate?: boolean; paint?: Record<string, number> })
  | (FeatureBase & { type: 'fillet'; target: string; r: Expr; edges?: Selector })
  | (FeatureBase & { type: 'chamfer'; target: string; d: Expr; edges?: Selector })
  | (FeatureBase & { type: 'shell'; target: string; thickness: Expr; open?: Selector })
  | (FeatureBase & {
      /** Another placement of a body that stays where it is (a second identical part): the source is not consumed. */
      type: 'instance'
      of: string
    } & Transform)
  | (FeatureBase & {
      type: 'hole'
      target: string
      /** The flat face the holes start from (e.g. { where: ">Z" }); they go in along its normal. */
      face: Selector
      /** Hole centers in the face's (u, v) coordinates (see sketch on a face). */
      at: Vec2E[]
      kind?: 'plain' | 'counterbore' | 'countersink' | 'tapped'
      /** Metric screw size (M2..M6): sets the diameters. */
      size?: string
      /** Hole diameter, overrides the size's clearance (or tap) diameter. */
      d?: Expr
      /** Clearance fit for plain/counterbore/countersink holes: close or normal (ISO 273, default normal). */
      fit?: 'close' | 'normal'
      /** Depth below the face; default through the whole body. */
      depth?: Expr
      /** Extra diameter for 3D printing (added to every diameter), default 0. */
      clearance?: Expr
    })
  | (FeatureBase & {
      type: 'insert_boss'
      target: string
      face: Selector
      at: Vec2E[]
      /** Insert size (M2..M5). */
      size: string
      /** Boss height above the face; 0 for a hole straight into the face. */
      height?: Expr
      /** Boss outer diameter; default hole + 2 × the insert's wall. */
      d?: Expr
    })
  | (FeatureBase & {
      type: 'thread'
      /** external: a threaded rod (screw); internal: a threaded hole tool to cut (nut). */
      kind: 'external' | 'internal'
      size?: string
      /** Major diameter and pitch (default from size). */
      d?: Expr
      pitch?: Expr
      length: Expr
      /** Extra radial gap for printed threads, default 0.15 for internal, 0 for external. */
      clearance?: Expr
      axis?: 'X' | 'Y' | 'Z'
    } & Transform)
  | (FeatureBase & {
      type: 'draft'
      target: string
      /** Faces to taper (e.g. side walls { where: "#Z" }). */
      faces: Selector
      /** Degrees; positive narrows the part away from the neutral plane (along its normal), negative widens it. */
      angle: Expr
      /** Neutral plane: faces keep their place where they cross it (default XY at z = 0). */
      plane?: Plane
      offset?: Expr
    })
  | (FeatureBase & {
      type: 'snap_fit'
      /** hook: the cantilever with its catch; window: the opening it latches into (cut it from the mating part), made from the hook's sizes. */
      part: 'hook' | 'window'
      /** window: the hook it matches. */
      hook?: string
      /** hook: beam length, width, thickness, catch depth (overhang) and length. */
      length?: Expr
      width?: Expr
      thickness?: Expr
      catch?: Expr
      catch_length?: Expr
      /** window: clearance around the catch, and the wall thickness it goes through. */
      clearance?: Expr
      wall?: Expr
    } & Transform)
  | (FeatureBase & { type: 'transform'; target: string; align?: Align } & Transform)
  | (FeatureBase & { type: 'solids'; source: string; pick?: SolidPick })
  | (FeatureBase & { type: 'import'; url: string; scale?: Expr } & Transform)
  | (FeatureBase & { type: 'pattern'; target: string; kind: 'linear'; count: Expr; step: Vec3E })
  | (FeatureBase & { type: 'pattern'; target: string; kind: 'grid'; count: Vec2E; step: Vec2E })
  | (FeatureBase & { type: 'pattern'; target: string; kind: 'polar'; count: Expr; axis?: 'X' | 'Y' | 'Z'; center?: Vec3E; angle?: Expr })
  | (FeatureBase & { type: 'mirror'; target: string; plane: Plane; offset?: Expr; keep?: boolean })
  | (FeatureBase & {
      type: 'gear'
      kind: 'spur' | 'helical' | 'herringbone' | 'internal' | 'rack' | 'worm' | 'bevel'
      teeth?: Expr
      module: Expr
      width?: Expr
      length?: Expr
      pressure_angle?: Expr
      helix?: Expr
      hand?: 'right' | 'left'
      profile_shift?: Expr | 'auto'
      backlash?: Expr
      diameter?: Expr
      pair_teeth?: Expr
      cone_angle?: Expr
      bore?: Expr
      hub?: { d: Expr; length: Expr }
      shaft?: { d: Expr; length: Expr }
      holes?: { count: Expr; d: Expr; at?: Expr }
      rim?: Expr
      center?: Vec3E
      axis?: 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z'
      rotation?: Expr
      travel?: Expr
      mesh?: { with: string; angle?: Expr; toward?: Vec3E }
      coaxial?: { with: string; offset?: Expr; phase?: Expr }
    })
  | (FeatureBase & {
      type: 'cam'
      /** Center of the cam, on its axis. */
      center?: Vec3E
      axis?: 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z'
      /** Turn of the cam, degrees: drive it with a parameter. */
      rotation?: Expr
      /** Radius under the follower at zero lift. */
      base_r: Expr
      /** Follower lift, mm, as an expression of t (cam angle 0..360 degrees, in the cam's own frame). */
      lift: string
      width: Expr
      /** Roller follower radius (0 or absent: knife edge). */
      roller?: Expr
      bore?: Expr
      /** Where the follower sits, degrees around the cam in its plane (default 90). */
      follower_at?: Expr
    })
  | (FeatureBase & {
      type: 'geneva'
      part: 'drive'
      slots: Expr
      /** Distance between the drive and wheel axes. */
      distance: Expr
      pin_d: Expr
      width: Expr
      /** Drive center. */
      center?: Vec3E
      axis?: 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z'
      /** Direction from the drive to the wheel, degrees in the drive's plane. */
      toward?: Expr
      /** Drive angle, degrees from the line of centers (180: pin away, wheel locked). Drive it with a parameter. */
      angle?: Expr
      bore?: Expr
      clearance?: Expr
    })
  | (FeatureBase & { type: 'geneva'; part: 'wheel'; drive: string; bore?: Expr })
  | (FeatureBase & {
      type: 'belt'
      plane: Plane
      offset?: Expr
      /** Pulleys around which the belt runs: center in plane coordinates, pitch diameter (or teeth with the belt's pitch); body: the pulley body, which then turns with the belt; back: the belt runs over it with its back (a tensioner outside the loop, bending a run inward). */
      pulleys: { at: Vec2E; d?: Expr; teeth?: Expr; body?: string; back?: boolean }[]
      thickness: Expr
      width: Expr
      /** Chain or timing belt pitch: pulley d = pitch / sin(180°/teeth). */
      pitch?: Expr
    })
  | (FeatureBase & {
      type: 'text'
      text: string
      size: Expr
      depth: Expr
      plane: Plane
      offset?: Expr
      at?: Vec2E
      anchor?: 'center' | 'left' | 'right'
      angle?: Expr
      font?: FontName
    } & Transform)

export type FeatureType = Feature['type']

/**
 * A check is a requirement the design must keep meeting: "wall >= 1.6",
 * "fits(board, case_inner)". run_checks evaluates all of them; a parameter
 * change that breaks one is visible at once.
 */
export type Check =
  | { name: string; kind: 'expr'; expr: string; note?: string }
  | { name: string; kind: 'min_distance'; a: string; b: string; min: Expr; note?: string }
  | { name: string; kind: 'no_overlap'; a: string; b: string; /** Intended overlap, mm³ (snap-fit clips). */ allow?: number; note?: string }
  | { name: string; kind: 'inside'; inner: string; outer: string; margin?: Expr; note?: string }
  | { name: string; kind: 'volume'; target: string; min?: Expr; max?: Expr; note?: string }
  | { name: string; kind: 'overhang'; target: string; angle?: Expr; axis?: '+Z' | '-Z' | '+X' | '-X' | '+Y' | '-Y'; max_area?: Expr; note?: string }
  | { name: string; kind: 'min_wall'; target: string; min: Expr; note?: string }

export interface Doc {
  version: 1
  units: 'mm'
  parameters: Parameter[]
  sketches: Sketch[]
  features: Feature[]
  checks: Check[]
  pcb?: Pcb
  /** How bodies look (display only): PBR materials, assigned per feature. */
  materials?: Material[]
  /** Labels and images projected onto bodies (display only). */
  decals?: Decal[]
  /** How the model moves: a driven parameter, joints, and bodies that fall and collide. */
  motion?: Motion
  /** Exploded view (display only): bodies moved apart to show the assembly. */
  explode?: Explode
  /** Named variants of the design: parameter values that replace the base ones. */
  configurations?: Configuration[]
  /** The configuration the design is built with; none = the base parameters. */
  configuration?: string
  meta: { description?: string }
}

/** A named set of parameter values (a variant: "ESP32-S3", "large"). */
export interface Configuration {
  name: string
  values: Record<string, Expr>
  note?: string
}

/**
 * The parameters a document builds with: the base ones, with the active
 * configuration's values in place of theirs (or of the named one).
 */
export function effectiveParameters(doc: Doc, configuration = doc.configuration): Parameter[] {
  const c = configuration ? doc.configurations?.find((x) => x.name === configuration) : undefined
  if (!c) return doc.parameters
  return doc.parameters.map((p) => (p.name in c.values ? { ...p, expr: c.values[p.name] } : p))
}

/** The document as built with another configuration (undefined: the base parameters). */
export function withConfiguration(doc: Doc, configuration: string | undefined): Doc {
  if (configuration && !doc.configurations?.some((c) => c.name === configuration)) {
    const known = doc.configurations?.map((c) => c.name) ?? []
    throw new Error(`no configuration "${configuration}"; configurations are: ${known.join(', ') || '(none; add one with set_configuration)'}`)
  }
  const next = { ...doc }
  if (configuration) next.configuration = configuration
  else delete next.configuration
  return next
}

/**
 * An exploded view: each listed body (or every body of a group) is drawn
 * moved by offset [x, y, z] mm when the view is exploded. Display only: the
 * model, checks and exports stay where they are built.
 */
export interface Explode {
  steps: { names: string[]; offset: Vec3E; note?: string }[]
}

// ── Motion ─────────────────────────────────────────────────────────────
// Kinematics are exact: a joint turns or slides a body in proportion to a
// parameter (gears get their joints from the mesh solver). Physics is for
// loose parts: they fall and collide with everything else, which is solid
// (moving joint bodies push them). Neither changes the document while it
// plays; stopping writes the driven parameter back once.

export interface Joint {
  body: string
  /**
   * rotate: about axis through origin; slide: along axis. follow: copy
   * another body's motion (a crank on a worm shaft). cam: the body slides as
   * the follower of a cam feature.
   */
  kind: 'rotate' | 'slide' | 'follow' | 'cam'
  axis?: Vec3E
  origin?: Vec3E
  /** Degrees (rotate) or mm (slide) per unit of param. */
  rate?: Expr
  /** Instead of rate: the angle or travel as an expression of the drive parameter (nonlinear, e.g. "8*sin(crank)"). */
  position?: string
  param?: string
  follow?: string
  /** cam: the cam feature this body follows. */
  cam?: string
}

export interface PhysicsBody {
  name: string
  /** g/cm³ (steel 7.8, PLA 1.25, wood 0.6). */
  density?: number
  friction?: number
  restitution?: number
  /** Start velocity, mm/s. */
  velocity?: [number, number, number]
  /** Start spin, degrees/s about x, y, z. */
  spin?: [number, number, number]
}

export interface Motion {
  /** The parameter Play advances, and how. */
  drive?: { param: string; speed: number; mode?: 'forever' | 'loop' | 'bounce'; range?: [number, number] }
  joints?: Joint[]
  physics?: { bodies: PhysicsBody[]; gravity?: number; floor?: boolean }
}

/** Fonts for text features (outlines become geometry). */
export type FontName = 'regular' | 'bold'

// ── Appearance ─────────────────────────────────────────────────────────
// Materials and decals never change geometry, exports or checks; they only
// change how the viewport and render draw a body.

export type TexturePattern = 'noise' | 'brushed' | 'scratches' | 'wood' | 'leather' | 'checker' | 'grid' | 'dots' | 'knurl'

/**
 * One texture map: a procedural pattern (tileable, seeded) or an image URL.
 * Values follow the map's meaning: albedo mixes color → color2, roughness
 * and metallic vary around the material's value by ±strength/2, normal and
 * displacement use the pattern as a height field.
 */
export interface TextureMap {
  pattern?: TexturePattern
  image?: string
  /** Tile size in mm (default: the material's uv.scale). */
  scale?: number
  /** 0..1 for most maps; mm of relief for displacement. */
  strength?: number
  /** albedo: second color the pattern mixes in. */
  color2?: string
  seed?: number
}

export interface UVMapping {
  /** box: each face from its dominant axis; planar: along axis; cylindrical: around axis. */
  projection: 'box' | 'planar' | 'cylindrical'
  axis?: 'X' | 'Y' | 'Z'
  /** Tile size in mm. */
  scale?: number
  /** Degrees. */
  rotation?: number
  /** [u, v] in mm. */
  offset?: [number, number]
}

export interface Material {
  name: string
  color: string
  /** 0 dielectric .. 1 metal. */
  metalness?: number
  /** 0 mirror .. 1 matte. */
  roughness?: number
  opacity?: number
  /** Light it gives off, 0..1 of its color (screens, LEDs). */
  emissive?: number
  /** Clear lacquer layer, 0..1 (car paint, glossy plastic). */
  clearcoat?: number
  uv?: UVMapping
  maps?: { albedo?: TextureMap; normal?: TextureMap; roughness?: TextureMap; metallic?: TextureMap; ao?: TextureMap; displacement?: TextureMap }
  note?: string
}

/**
 * A decal is projected onto a body along -normal at a point: text (drawn
 * with a CSS font) or an image, size [w, h] mm on the surface, depth the
 * thickness of the projection box.
 */
export interface Decal {
  name: string
  target: string
  at: Vec3E
  /** Direction the decal faces (out of the surface). */
  normal: [number, number, number]
  /** Which way is up on the decal (default +Z, or +Y when the decal faces ±Z). */
  up?: [number, number, number]
  size: Vec2E
  depth?: Expr
  rotation?: Expr
  text?: string
  image?: string
  /** Text color, or a tint for images. */
  color?: string
  background?: string
  /** Cap height of the text in mm (default fits the decal). */
  font_size?: Expr
  font?: string
  weight?: number
  align?: 'left' | 'center' | 'right'
  valign?: 'top' | 'middle' | 'bottom'
  roughness?: number
  metalness?: number
  emissive?: number
  opacity?: number
}

// ── PCB ────────────────────────────────────────────────────────────────
// Board coordinates are the world XY plane in mm (y up); the board's
// bottom face sits at z = placement.z, so an enclosure can be designed
// around it with the same parameters.

export type CopperLayer = 'F.Cu' | 'B.Cu' | 'In1.Cu' | 'In2.Cu' | 'In3.Cu' | 'In4.Cu'

/** Copper layer counts a board can have. */
export type LayerCount = 2 | 4 | 6

/** Every copper layer name, for schemas. */
export const COPPER_LAYERS = ['F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'B.Cu'] as const

/** The copper layers a via joins: its span (top to bottom), or every layer. */
export function viaLayers(v: { span?: [CopperLayer, CopperLayer] }, layers: LayerCount): CopperLayer[] {
  const all = copperLayersOf(layers)
  if (!v.span) return all
  const [i, j] = v.span.map((l) => all.indexOf(l)).sort((a, b) => a - b)
  return i < 0 || j < 0 ? all : all.slice(i, j + 1)
}

/** The copper layers of a board, top to bottom. */
export function copperLayersOf(layers: LayerCount): CopperLayer[] {
  return layers === 6 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'B.Cu'] : layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu']
}

/**
 * The physical build-up of a board: copper and dielectric thicknesses and the
 * dielectric constant, top to bottom. Used for impedance and for the
 * manufacturing report; layer count still comes from Pcb.layers.
 */
export interface Stackup {
  /** Preset it came from (e.g. "jlcpcb-4l-7628"), for the report. */
  preset?: string
  /** Copper thickness per layer, µm (35 = 1 oz), top to bottom. */
  copper: number[]
  /** Dielectric between each pair of copper layers, top to bottom: thickness mm and εr. */
  dielectric: { thickness: number; er: number; kind?: 'core' | 'prepreg' }[]
  /** Solder mask thickness µm and εr (outer layers). */
  mask?: { thickness: number; er: number }
}

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
  drill?: { d: number; slot?: number; plated: boolean; /** Slot centerline ends relative to the pad center, before pad rotation. */ ends?: [P, P] }
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
  /** Body lines (EasyEDA PL/PG polylines): [x0, y0, x1, y1, ...]. */
  lines?: number[][]
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
  /** Explicit electrical intent, keyed by canonical pad number (never guessed from pin names). */
  pin_rules?: Record<string, { type: PinType; required?: boolean }>
  /** Not assembled: bare copper (solder pads, test points) or a part fitted by hand. Left out of the BOM and CPL. */
  dnp?: boolean
  /**
   * A real 3D model (STEP/STL URL) for the part body, in footprint
   * coordinates: x/y on the board, z up from the board face the part sits on.
   * Replaces the courtyard block as body part_<ref>.
   */
  model?: PartModel
}

export type PinType = 'input' | 'output' | 'bidirectional' | 'passive' | 'power_in' | 'power_out' | 'open_drain' | 'no_connect'

export interface PartModel {
  url: string
  /** Degrees about X, Y, Z (applied first), then translate. */
  rotate?: Vec3E
  translate?: Vec3E
  scale?: Expr
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
  /** Copper layers it joins, top first (default all: a through via). Blind: from an outer layer; buried: inner only. */
  span?: [CopperLayer, CopperLayer]
  /** Placed by stitch_vias (replaced when it runs again). */
  stitch?: boolean
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

export interface DiffPair {
  name: string
  /** Positive and negative nets. */
  p: string
  n: string
  /** Track width and edge-to-edge gap, mm (from impedance). */
  width: number
  gap: number
  /** Allowed length difference between the two, mm (default 0.15). */
  skew?: number
  /** Target differential impedance, for the report. */
  impedance?: number
}

export interface LengthGroup {
  name: string
  nets: string[]
  /** Allowed spread from the longest, mm. */
  tolerance: number
  /** Optional absolute bounds on every net's length, mm. */
  min?: number
  max?: number
}

/** A region of the board that forbids tracks, vias, pours and/or parts, on some copper layers (parts: by side). */
export interface Keepout {
  name: string
  polygon: [number, number][]
  /** Copper layers it applies to; default all. Parts follow the side of these layers (F.Cu top, B.Cu bottom). */
  layers?: CopperLayer[]
  forbid: ('tracks' | 'vias' | 'pours' | 'parts')[]
  note?: string
}

export type MaskColor = 'green' | 'black' | 'white' | 'blue' | 'red' | 'purple' | 'yellow'
export type SilkColor = 'white' | 'black'

/** Prepared, normalized ink polygons: width 1 mm, centered at the origin. */
export interface BoardArtwork {
  name: string
  kind: 'text' | 'image'
  text?: string
  at: Vec2E
  width: Expr
  rotation?: Expr
  side: 'top' | 'bottom'
  regions: P[][][]
}

export interface Pcb {
  /** Board outline: a closed XY sketch (inner circles become holes) or a rect. */
  outline: { sketch: string } | { rect: { w: Expr; h: Expr; r?: Expr; center?: Vec2E } }
  thickness: Expr
  layers: LayerCount
  rules: 'jlcpcb'
  /** Physical layer build-up (set_stackup); thickness follows it when set. */
  stackup?: Stackup
  placement?: { z?: Expr }
  components: Component[]
  nets: Net[]
  classes: NetClass[]
  tracks: Track[]
  vias: Via[]
  zones?: Zone[]
  /** Teardrops where tracks meet pads and vias (derived when the board is resolved). */
  teardrops?: { length?: number; width?: number }
  /** Differential pairs: two nets routed side by side at a gap (USB D+/D−, LVDS). */
  diff_pairs?: DiffPair[]
  /** Nets whose routed lengths must match (a bus, a pair's two halves), within a tolerance. */
  length_groups?: LengthGroup[]
  /** Areas where some things may not go: copper (tracks, vias, pours) or parts (antenna clearance, under a connector). */
  keepouts?: Keepout[]
  /** Schematic wires between pins of the same net (drawing only; the netlist decides connectivity). */
  wires?: Wire[]
  holes: { at: Vec2E; d: Expr }[]
  style?: { mask: MaskColor; silk: SilkColor }
  artwork?: BoardArtwork[]
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

/** Features a feature depends on without consuming them (a gear follows the gear it meshes with). */
export function refsOf(f: Feature): string[] {
  if (f.type === 'gear') {
    const r = f.mesh?.with ?? f.coaxial?.with
    return r ? [r] : []
  }
  if (f.type === 'geneva' && f.part === 'wheel') return [f.drive]
  if (f.type === 'solids') return [f.source]
  if (f.type === 'instance') return [f.of]
  if (f.type === 'snap_fit' && f.part === 'window' && f.hook) return [f.hook]
  return []
}

/** Features a feature needs built before it: what it consumes and what it reads without consuming. */
export function dependsOn(f: Feature, doc?: Doc): string[] {
  const own = f.type === 'solids' ? [...inputsOf(f), f.source] : f.type === 'instance' ? [f.of] : f.type === 'snap_fit' && f.part === 'window' && f.hook ? [f.hook] : inputsOf(f)
  // A sketch on a face needs the feature that face belongs to.
  const faces = doc ? sketchesOf(f).flatMap((n) => doc.sketches.find((s) => s.name === n)?.on?.feature ?? []) : []
  return faces.length ? [...new Set([...own, ...faces])] : own
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
    case 'mirror':
    case 'hole':
    case 'insert_boss':
    case 'draft':
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
