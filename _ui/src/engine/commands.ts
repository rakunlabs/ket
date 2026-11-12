// The CAD commands. Each feature command adds a feature, or replaces the
// feature of the same name when replace is true, so a model can redefine a
// part without deleting and re-adding everything that depends on it.

import { z } from 'zod'

import { type Doc, type Feature, findFeature, inputsOf, normalizeDoc, refsOf, sketchesOf } from './doc'
import { namesIn } from './expr'
import { define, applyOp } from './registry'
import { checkDef, common, expr, featureName, featureRef, ident, placement, plane, profile, selector, vec2, vec3 } from './schema'

const replace = z
  .boolean()
  .optional()
  .describe('Replace the existing feature with this name, keeping its position in the list (default false: fail if the name exists)')

function clone(doc: Doc): Doc {
  // JSON, not structuredClone: the doc may be a Svelte state proxy, and it
  // is plain data by design.
  return normalizeDoc(JSON.parse(JSON.stringify(doc)) as Doc)
}

export function upsert(doc: Doc, f: Feature, replaceIt: boolean | undefined): { doc: Doc; summary: string } {
  const next = clone(doc)
  for (const s of sketchesOf(f)) {
    if (!next.sketches.some((x) => x.name === s)) {
      throw new Error(`sketch "${s}" does not exist; sketches are: ${next.sketches.map((x) => x.name).join(', ') || '(none yet; create one with sketch)'}`)
    }
  }
  const i = next.features.findIndex((x) => x.name === f.name)
  if (i >= 0) {
    if (!replaceIt) {
      throw new Error(`a feature named "${f.name}" exists (${next.features[i].type}); pick another name, or pass replace: true to redefine it`)
    }
    next.features[i] = f
    return { doc: next, summary: `replaced ${f.type} ${f.name}` }
  }
  for (const input of inputsOf(f)) {
    if (!findFeature(next, input)) {
      const known = next.features.map((x) => x.name)
      throw new Error(`"${input}" does not exist; features are: ${known.join(', ') || '(none yet)'}`)
    }
  }
  next.features.push(f)
  return { doc: next, summary: `added ${f.type} ${f.name}` }
}

/** Removes undefined fields so the stored op and document stay compact. */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

function featureCommand<S extends z.ZodRawShape>(
  name: string,
  type: Feature['type'],
  description: string,
  shape: S,
  examples: z.input<z.ZodObject<S & typeof common & { replace: typeof replace }>>[],
) {
  const args = z.object({ ...common, ...shape, replace })
  define({
    name,
    group: 'cad',
    kind: 'mutate',
    description,
    args,
    examples,
    apply(doc, a) {
      const { replace: r, ...rest } = a as Record<string, unknown> & { replace?: boolean }
      return upsert(doc, compact({ ...rest, type }) as unknown as Feature, r)
    },
  })
}

// ── Parameters ──────────────────────────────────────────────────────────

define({
  name: 'set_parameters',
  group: 'params',
  kind: 'mutate',
  description:
    'Create or update named parameters. Values are numbers (mm, degrees) or expressions over other parameters. Use parameters for every dimension that matters (board size, wall, clearance) so the design stays editable: change one and every feature that uses it rebuilds.',
  args: z.object({
    parameters: z
      .array(
        z.object({
          name: ident,
          expr: expr,
          unit: z.string().optional(),
          description: z.string().optional(),
        }),
      )
      .min(1),
  }),
  examples: [
    {
      parameters: [
        { name: 'board_w', expr: 50, description: 'PCB width' },
        { name: 'wall', expr: 2 },
        { name: 'case_w', expr: 'board_w + 2*wall + 1' },
      ],
    },
  ],
  apply(doc, a) {
    const next = clone(doc)
    const changed: string[] = []
    for (const p of a.parameters) {
      const entry = compact({ name: p.name, expr: p.expr, unit: p.unit, description: p.description })
      const i = next.parameters.findIndex((x) => x.name === p.name)
      if (i >= 0) next.parameters[i] = { ...next.parameters[i], ...entry }
      else next.parameters.push(entry)
      changed.push(`${p.name}=${p.expr}`)
    }
    return { doc: next, summary: `set ${changed.join(', ')}` }
  },
})

define({
  name: 'delete_parameters',
  group: 'params',
  kind: 'mutate',
  description: 'Delete parameters. Fails while a parameter, feature or check still uses one of them.',
  args: z.object({ names: z.array(z.string()).min(1) }),
  apply(doc, a) {
    const next = clone(doc)
    const drop = new Set(a.names)
    const users: string[] = []
    const scan = (owner: string, v: unknown) => {
      if (typeof v === 'string') {
        try {
          for (const n of namesIn(v)) if (drop.has(n)) users.push(`${owner} uses ${n}`)
        } catch {
          // not an expression
        }
      } else if (Array.isArray(v)) v.forEach((x) => scan(owner, x))
      else if (v && typeof v === 'object') for (const x of Object.values(v)) scan(owner, x)
    }
    for (const p of next.parameters) if (!drop.has(p.name)) scan(`parameter ${p.name}`, p.expr)
    for (const f of next.features) scan(`feature ${f.name}`, { ...f, name: undefined, target: undefined, tools: undefined })
    for (const c of next.checks) scan(`check ${c.name}`, c)
    if (users.length) throw new Error(`cannot delete: ${users.join('; ')}`)
    const missing = a.names.filter((n) => !next.parameters.some((p) => p.name === n))
    if (missing.length) throw new Error(`no parameter ${missing.join(', ')}`)
    next.parameters = next.parameters.filter((p) => !drop.has(p.name))
    return { doc: next, summary: `deleted parameters ${a.names.join(', ')}` }
  },
})

// ── Primitives ──────────────────────────────────────────────────────────

featureCommand(
  'box',
  'box',
  'Add a box. By default it is centered on X and Y and sits on Z=0 (from z=0 to z=size[2]). Set center to choose per axis: [true,true,false] is the default, true centers all axes, false puts the corner at the origin.',
  {
    size: vec3.describe('[x, y, z] size in mm'),
  center: z.union([z.boolean(), z.tuple([z.boolean(), z.boolean(), z.boolean()])]).optional(),
    ...placement,
  },
  [{ name: 'case_body', size: ['case_w', 'case_d', 'case_h'] }, { name: 'tab', size: [10, 5, 2], translate: [20, 0, 0] }],
)

featureCommand(
  'cylinder',
  'cylinder',
  'Add a cylinder. Its base circle is centered on the origin and it extends along +axis (default Z) by h.',
  { r: expr.describe('Radius'), h: expr.describe('Height'), axis: z.enum(['X', 'Y', 'Z']).optional(), ...placement },
  [{ name: 'standoff', r: 2.5, h: 'standoff_h', translate: [20, 15, 'wall'] }],
)

featureCommand('sphere', 'sphere', 'Add a sphere centered on the origin.', { r: expr, ...placement }, [{ name: 'knob', r: 5, translate: [0, 0, 20] }])

featureCommand(
  'extrude',
  'extrude',
  'Extrude a closed 2D outline into a solid. Either sketch (a constrained sketch, see the sketch command; holes inside the outline stay holes) or a quick profile on a plane (rect with optional corner r, circle, slot, polygon). XY extrudes along +Z from z=offset, XZ along +Y, YZ along +X; a negative distance goes the other way; symmetric centers it on the sketch plane.',
  {
    sketch: z.string().optional().describe('Name of a sketch; its plane and offset are used'),
    plane: plane.optional().describe('With profile: sketch plane'),
    offset: expr.optional().describe('With profile: distance of the sketch plane from the origin along its normal'),
    profile: profile.optional(),
    distance: expr.describe('Extrusion length; negative goes the other way'),
    symmetric: z.boolean().optional().describe('Extrude distance/2 to both sides'),
    ...placement,
  },
  [
    { name: 'plate', sketch: 'plate_outline', distance: 'plate_t' },
    { name: 'lid', plane: 'XY', offset: 'case_h', profile: { kind: 'rect', w: 'case_w', h: 'case_d', r: 3 }, distance: 2 },
    { name: 'usb_hole', plane: 'YZ', offset: -40, profile: { kind: 'slot', length: 9.5, width: 3.5, center: [0, 6] }, distance: 10 },
  ],
)

featureCommand(
  'revolve',
  'revolve',
  'Revolve a closed outline (sketch or profile) about an axis through the origin that lies in its plane: XZ sketches about Z (lathe-like parts: knobs, bushings) or X, XY about X or Y, YZ about Y or Z. The outline must not cross the axis.',
  {
    sketch: z.string().optional(),
    plane: plane.optional(),
    profile: profile.optional(),
    axis: z.enum(['X', 'Y', 'Z']),
    angle: expr.optional().describe('Degrees, default 360'),
    ...placement,
  },
  [{ name: 'knob', sketch: 'knob_profile', axis: 'Z' }],
)

define({
  name: 'loft',
  group: 'cad',
  kind: 'mutate',
  description:
    'Blend a solid through 2 or more cross-sections in order (e.g. a rectangle at the base to a circle at the top: funnels, transitions, tapered bosses). Each section is a sketch or a profile on a plane with an offset; sections are usually parallel and spaced along the normal. Each must be one closed loop without holes (cut holes afterwards). ruled: straight faces between sections instead of a smooth blend.',
  args: z.object({
    ...common,
    sections: z
      .array(
        z.object({
          sketch: z.string().optional().describe('Name of a sketch'),
          plane: plane.optional(),
          offset: expr.optional().describe('Distance of the plane from the origin along its normal'),
          profile: profile.optional(),
        }),
      )
      .min(2),
    ruled: z.boolean().optional(),
    ...placement,
    replace,
  }),
  examples: [
    {
      name: 'funnel',
      sections: [
        { plane: 'XY', offset: 0, profile: { kind: 'rect', w: 30, h: 30, r: 2 } },
        { plane: 'XY', offset: 25, profile: { kind: 'circle', r: 6 } },
      ],
    },
  ],
  apply(doc, a) {
    const { replace: r, ...rest } = a
    return upsert(doc, compact({ ...rest, type: 'loft' }) as unknown as Feature, r)
  },
})

define({
  name: 'sweep',
  group: 'cad',
  kind: 'mutate',
  description:
    'Sweep a cross-section along a 3D path (cable channels, handles, bent rods, gaskets). The path goes straight through the points; bend rounds every corner with that radius (recommended, sharp corners are mitered). The cross-section (profile or sketch, in its own u/v coordinates) is centered on the first point, perpendicular to the first segment; u is horizontal (perpendicular to the path and Z) and v is up. One loop without holes: for a tube sweep the inner profile too and cut it.',
  args: z.object({
    ...common,
    profile: profile.optional(),
    sketch: z.string().optional().describe('Use a sketch\'s outline as the cross-section (its plane is ignored)'),
    path: z.array(vec3).min(2).describe('Path points [x, y, z] in order'),
    bend: expr.optional().describe('Corner radius of the path; 0 = sharp'),
    ...placement,
    replace,
  }),
  examples: [
    {
      name: 'handle',
      profile: { kind: 'circle', r: 4 },
      path: [
        [-30, 0, 0],
        [-30, 0, 25],
        [30, 0, 25],
        [30, 0, 0],
      ],
      bend: 8,
    },
  ],
  apply(doc, a) {
    const { replace: r, ...rest } = a
    return upsert(doc, compact({ ...rest, type: 'sweep' }) as unknown as Feature, r)
  },
})

// ── Operations ──────────────────────────────────────────────────────────

const num1 = expr
define({
  name: 'gear',
  group: 'cad',
  kind: 'mutate',
  description:
    'Add an involute gear: spur, helical, herringbone, internal (ring), rack, worm or bevel. Size: module (tooth size; pitch diameter = module × teeth) and teeth; width is the face width along the axis. Place the first gear of a train with center, axis and rotation; every other gear uses mesh: { with: "<earlier gear>", angle } (angle in degrees around the partner, or toward [x,y,z]) and gets its center, axis, hand and tooth phase solved so the teeth interlock, or coaxial: { with, offset } to share a shaft (compound trains). Then the whole train turns from one parameter: make the first gear\'s rotation an expression (e.g. "crank") and change it. Worm: teeth = starts, length, diameter; its wheel meshes with it as kind "helical" and gets the lead angle as helix. Bevel: pair_teeth = teeth of its mate (90° shafts; teeth are tapered involutes, fine for prints and models). Rack: length, meshes with a spur gear and slides. Optional: bore, hub, shaft, lightening holes, profile_shift for few teeth, backlash. get_gears lists ratios and diameters.',
  args: z.object({
    ...common,
    kind: z.enum(['spur', 'helical', 'herringbone', 'internal', 'rack', 'worm', 'bevel']),
    teeth: num1.optional().describe('Teeth; for a worm the number of starts (1-6); not needed for a rack'),
    module: num1.describe('Module in mm (0.5..3 for printed gears; ≥ 1 for FDM). Meshing gears share it; a worm pair uses the axial module'),
    width: num1.optional().describe('Face width along the axis (rack: across it). Not for worms'),
    length: num1.optional().describe('Worm or rack length'),
    pressure_angle: num1.optional().describe('Degrees, default 20'),
    helix: num1.optional().describe('Helical/herringbone helix angle, degrees (default 20; + right hand, − left). A mate gets the opposite hand by itself'),
    hand: z.enum(['right', 'left']).optional().describe('Worm thread hand (default right)'),
    profile_shift: z.union([num1, z.literal('auto')]).optional().describe('Profile shift coefficient x (-0.8..0.8); "auto" picks the smallest shift that avoids undercut (for pinions under 17 teeth)'),
    backlash: num1.optional().describe('Play between teeth, mm (default 0.04·module + 0.03)'),
    diameter: num1.optional().describe('Worm pitch diameter (default 8 × module)'),
    pair_teeth: num1.optional().describe('Bevel: teeth of the mating bevel (sets the cone angle for 90° shafts)'),
    cone_angle: num1.optional().describe('Bevel: pitch cone angle, degrees (instead of pair_teeth)'),
    bore: num1.optional().describe('Shaft hole diameter'),
    hub: z.object({ d: num1, length: num1 }).optional().describe('Boss on the +axis side (bevels: on the back)'),
    shaft: z.object({ d: num1, length: num1 }).optional().describe('A solid shaft through the gear, centered on it'),
    holes: z.object({ count: num1, d: num1, at: num1.optional().describe('Radius of the hole circle (default midway)') }).optional().describe('Lightening holes in the web'),
    rim: num1.optional().describe('Internal gear: outside diameter of the ring; rack: thickness behind the roots'),
    center: vec3.optional().describe('First gear only: center (mid-face; back face for bevels)'),
    axis: z.enum(['X', 'Y', 'Z', '-X', '-Y', '-Z']).optional().describe('First gear only: axis direction (default Z)'),
    rotation: num1.optional().describe('First gear only: rotation about its axis, degrees; drive the train with an expression'),
    travel: num1.optional().describe('First gear only (a free rack): position along its length'),
    mesh: z
      .object({
        with: featureRef.describe('An earlier gear'),
        angle: num1.optional().describe('Where around the partner, degrees in its plane (0 = its reference direction)'),
        toward: vec3.optional().describe('Or: a direction from the partner center toward this gear'),
      })
      .optional(),
    coaxial: z
      .object({ with: featureRef, offset: num1.optional().describe('Along the shared axis, mm'), phase: num1.optional().describe('Extra rotation, degrees') })
      .optional()
      .describe('Same shaft as an earlier gear: turns with it'),
    replace,
  }),
  examples: [
    { name: 'drive', kind: 'spur', teeth: 20, module: 1.5, width: 6, bore: 5, rotation: 'crank' },
    { name: 'idler', kind: 'spur', teeth: 32, module: 1.5, width: 6, bore: 5, mesh: { with: 'drive', angle: 0 } },
    { name: 'worm', kind: 'worm', teeth: 1, module: 1.5, length: 30, diameter: 14, axis: 'X', rotation: 'crank' },
    { name: 'wheel', kind: 'helical', teeth: 30, module: 1.5, width: 8, mesh: { with: 'worm', toward: [0, 0, 1] } },
  ],
  apply(doc, a) {
    const { replace: r, ...rest } = a
    const ref = a.mesh?.with ?? a.coaxial?.with
    if (ref) {
      const p = doc.features.find((f) => f.name === ref)
      if (!p) throw new Error(`no gear "${ref}"; gears are: ${doc.features.filter((f) => f.type === 'gear').map((f) => f.name).join(', ') || '(none yet; place the first gear with center and axis)'}`)
      if (p.type !== 'gear') throw new Error(`"${ref}" is a ${p.type}, not a gear`)
    }
    return upsert(doc, compact({ ...rest, type: 'gear' }) as unknown as Feature, r)
  },
})

// ── Operations (boolean, fillet, ...) ───────────────────────────────────

define({
  name: 'text',
  group: 'cad',
  kind: 'mutate',
  description:
    'Lettering as real geometry: the outline of a text extruded by depth from a plane (raised labels, engraved serials, embossed logos that must print or machine). size is the cap height in mm; at is where the middle of the text sits in plane coordinates (u, v as in sketch); anchor picks which end of the text is at at. Union it onto a body to raise it, or give a negative depth / cut it to engrave. For printed-on labels that need no geometry use add_decal.',
  args: z.object({
    ...common,
    text: z.string().min(1).max(200),
    size: expr.describe('Cap height in mm (≥ 1.5 for FDM, ≥ 0.6 for resin)'),
    depth: expr.describe('Extrusion along the plane normal; negative goes the other way'),
    plane,
    offset: expr.optional().describe('Distance of the plane from the origin along its normal'),
    at: vec2.optional().describe('[u, v] of the text anchor in plane coordinates (default [0, 0])'),
    anchor: z.enum(['center', 'left', 'right']).optional().describe('Which part of the text sits at at (default center); vertically the cap height is centered'),
    angle: expr.optional().describe('Rotation in the plane, degrees counter-clockwise'),
    font: z.enum(['regular', 'bold']).optional().describe('Monospace font weight (default regular)'),
    ...placement,
    replace,
  }),
  examples: [
    { name: 'label', text: 'KET-01', size: 4, depth: 0.6, plane: 'XY', offset: 'case_h', at: [0, -10] },
    { name: 'serial_cut', text: 'SN 0042', size: 2.5, depth: -0.4, plane: 'XZ', offset: '-case_d/2', font: 'bold' },
  ],
  apply(doc, a) {
    const { replace: r, ...rest } = a
    return upsert(doc, compact({ ...rest, type: 'text' }) as unknown as Feature, r)
  },
})

featureCommand(
  'boolean',
  'boolean',
  'Combine features: union merges the tools into the target, cut subtracts them, intersect keeps the common volume. Inputs are consumed: only the result is a visible body. To cut a hole, first add the tool body (box, cylinder, extrude), then cut it from the target. A union of parts that do not touch (keys, wheels) is one body of separate solids: pass separate: true to say that is intended.',
  {
    op: z.enum(['union', 'cut', 'intersect']),
    target: featureRef,
    tools: z.array(featureRef).min(1),
    separate: z.boolean().optional().describe('union: the parts are meant to stay separate solids; skips the "does not touch" warnings'),
  },
  [{ name: 'case_open', op: 'cut', target: 'case_shell', tools: ['usb_hole', 'led_hole'] }],
)

featureCommand(
  'fillet',
  'fillet',
  'Round edges of a feature with radius r. Select edges with a selector; without one all edges are rounded. Fillet last when you can: shell and cuts on filleted bodies fail more often.',
  { target: featureRef, r: expr, edges: selector.optional() },
  [{ name: 'case_round', target: 'case_body', r: 3, edges: { where: '|Z' } }],
)

featureCommand(
  'chamfer',
  'chamfer',
  'Bevel edges of a feature by distance d. Select edges with a selector; without one all edges are chamfered.',
  { target: featureRef, d: expr, edges: selector.optional() },
  [{ name: 'base_chamfer', target: 'case_body', d: 0.5, edges: { where: '<Z' } }],
)

featureCommand(
  'shell',
  'shell',
  'Hollow a solid into walls of the given thickness, removing the faces picked by open (default the top face, ">Z"). Walls grow inwards, so outer dimensions stay.',
  { target: featureRef, thickness: expr, open: selector.optional() },
  [{ name: 'case_shell', target: 'case_round', thickness: 'wall', open: { where: '>Z' } }],
)

featureCommand(
  'transform',
  'transform',
  'Move and/or rotate a copy of a feature; the original is consumed.',
  { target: featureRef, ...placement },
  [{ name: 'lid_placed', target: 'lid', translate: [0, 0, 30], rotate: [180, 0, 0] }],
)

featureCommand(
  'import',
  'import',
  'Bring in a real 3D model as a solid body you can place, check (inside, no_overlap, min_distance) and cut with. STEP (vendor or library model: a switch, a keycap, a dev board) becomes a B-rep solid. STL and 3MF (a print model, a slicer project) become a triangle-mesh body: boolean (union/cut/intersect with any body), transform, pattern, mirror, checks, measure and STL/3MF export work on it even at hundreds of thousands of triangles; fillet, chamfer, shell and face/edge selectors need B-rep bodies, so make cutting tools with box/extrude/sketch and cut them out of the mesh. url is an uploaded file ("ket:asset/<id>/<file>", from the Import model button in the UI; list them with list_assets) or https on an open model library: raw.githubusercontent.com (e.g. kiswitch/kiswitch for Cherry MX switches and Kailh hot-swap sockets, anhthang/dsa-keycap for keycaps, adafruit/Adafruit_CAD_Parts), gitlab.com (KiCad kicad-packages3D) or a vendor (files.seeedstudio.com). For a zip add #<file> to pick the model inside; for a 3MF with several objects add #<object id> or #<object name> (list_assets shows them). The model keeps its own origin and orientation (a 3MF object stays where the slicer placed it on the plate): measure it, then rotate (applied first) and translate it into place; scale converts units (0.0254 for inches... rarely needed).',
  {
    url: z.string().url().describe('ket:asset/<id>/<file> of an uploaded file, or https URL of a .step/.stp/.stl/.3mf file (or a zip with #file inside); #<object id or name> picks one object of a 3MF'),
    scale: expr.optional().describe('Uniform scale about the file origin (default 1)'),
    ...placement,
  },
  [
    { name: 'mx_switch', url: 'https://raw.githubusercontent.com/kiswitch/kiswitch/main/library/3dmodels/3d-library.3dshapes/SW_Cherry_MX_PCB.stp', translate: [0, 0, 5] },
    { name: 'xiao', url: 'https://files.seeedstudio.com/wiki/XIAO-BLE/seeed-studio-xiao-nrf52840-3d-model.zip#XIAO-nRF52840 v15.step', rotate: [90, 0, 0] },
  ],
)

define({
  name: 'pattern',
  group: 'cad',
  kind: 'mutate',
  description:
    'Repeat a feature: linear (count copies, each moved by step [x,y,z] from the previous), grid (count [nx, ny] copies with step [dx, dy] on XY) or polar (count copies rotated about an axis through center: spokes, bolt circles, gear teeth; angle is the total sweep, default 360 = evenly spaced all round). The copies are fused into one body; use it as a tool to cut many holes at once.',
  args: z
    .object({
      ...common,
      kind: z.enum(['linear', 'grid', 'polar']),
      target: featureRef,
      count: z.union([expr, vec2]).describe('linear/polar: number of copies; grid: [nx, ny]'),
      step: z.union([vec3, vec2]).optional().describe('linear: [dx, dy, dz] between copies; grid: [dx, dy]'),
      axis: z.enum(['X', 'Y', 'Z']).optional().describe('polar: rotation axis direction (default Z)'),
      center: vec3.optional().describe('polar: a point on the rotation axis (default [0, 0, 0])'),
      angle: expr.optional().describe('polar: total angle in degrees (default 360: copies spaced 360/count; less: first and last copy at the ends)'),
      replace,
    })
    .superRefine((a, ctx) => {
      if (a.kind === 'linear' && (Array.isArray(a.count) || !Array.isArray(a.step) || a.step.length !== 3)) {
        ctx.addIssue({ code: 'custom', message: 'linear needs count as a number and step as [dx, dy, dz]' })
      }
      if (a.kind === 'grid' && (!Array.isArray(a.count) || !Array.isArray(a.step) || a.step.length !== 2)) {
        ctx.addIssue({ code: 'custom', message: 'grid needs count as [nx, ny] and step as [dx, dy]' })
      }
      if (a.kind === 'polar' && (Array.isArray(a.count) || a.step !== undefined)) {
        ctx.addIssue({ code: 'custom', message: 'polar needs count as a number, an axis and a center; it takes no step' })
      }
      if (a.kind !== 'polar' && (a.axis !== undefined || a.center !== undefined || a.angle !== undefined)) {
        ctx.addIssue({ code: 'custom', message: 'axis, center and angle are for kind "polar" only' })
      }
    }),
  examples: [
    { name: 'vents', kind: 'linear', target: 'vent_slot', count: 6, step: [4, 0, 0] },
    { name: 'standoffs', kind: 'grid', target: 'standoff', count: [2, 2], step: ['hole_dx', 'hole_dy'] },
    { name: 'spokes', kind: 'polar', target: 'spoke', count: 8, axis: 'Y', center: [0, 0, 'wheel_r'] },
  ],
  apply(doc, a) {
    const { replace: r, ...rest } = a as Record<string, unknown> & { replace?: boolean }
    return upsert(doc, compact({ ...rest, type: 'pattern' }) as unknown as Feature, r)
  },
})

define({
  name: 'mirror',
  group: 'cad',
  kind: 'mutate',
  description:
    'Mirror a feature across a plane: XY (z = offset), XZ (y = offset) or YZ (x = offset). By default keep: true fuses the original and its mirror image into one body (model one side of a symmetric part, then mirror it: left/right wheels, brackets); keep: false leaves only the mirrored copy. The original is consumed.',
  args: z.object({
    ...common,
    target: featureRef,
    plane: z.enum(['XY', 'XZ', 'YZ']).describe('Mirror plane: XY flips Z, XZ flips Y, YZ flips X'),
    offset: expr.optional().describe('Position of the plane along its normal (default 0)'),
    keep: z.boolean().optional().describe('Fuse the original with its mirror image (default true)'),
    replace,
  }),
  examples: [
    { name: 'wheels', target: 'wheels_left', plane: 'XZ' },
    { name: 'bracket_r', target: 'bracket_l', plane: 'YZ', keep: false },
  ],
  apply(doc, a) {
    const { replace: r, ...rest } = a
    return upsert(doc, compact({ ...rest, type: 'mirror' }) as unknown as Feature, r)
  },
})

define({
  name: 'update_feature',
  group: 'cad',
  kind: 'mutate',
  description:
    'Change some fields of an existing feature without restating it, e.g. {"name":"case_round","set":{"r":2}}. Use null to remove an optional field. The feature type cannot change; use the feature command with replace: true for that. Adding a tool to a boolean that was created after it (a new cutter) moves that tool before the boolean.',
  args: z.object({
    name: featureRef,
    set: z.record(z.string(), z.unknown()).describe('Fields to change, as in the feature command'),
  }),
  examples: [{ name: 'case_body', set: { size: ['case_w', 'case_d', 30] } }],
  apply(doc, a) {
    const next = clone(doc)
    let i = next.features.findIndex((f) => f.name === a.name)
    if (i < 0) throw new Error(`no feature "${a.name}"; features are: ${next.features.map((f) => f.name).join(', ') || '(none)'}`)
    if ('type' in a.set || 'name' in a.set) throw new Error('set cannot change type or name; use rename_feature or the feature command with replace: true')
    const f = { ...next.features[i] } as Record<string, unknown>
    for (const [k, v] of Object.entries(a.set)) {
      if (v === null) delete f[k]
      else f[k] = v
    }
    next.features[i] = f as unknown as Feature
    // Inputs defined later (a cutting tool added after the cut): move them,
    // with the features they are built from, to just before this feature,
    // when nothing else uses them and they need nothing defined after it.
    for (const input of inputsOf(next.features[i])) {
      const j = next.features.findIndex((x) => x.name === input)
      if (j <= i) continue
      // The tool and its inputs, transitively.
      const tree = new Set<string>()
      const walk = (n: string) => {
        if (tree.has(n)) return
        tree.add(n)
        const f2 = next.features.find((x) => x.name === n)
        if (f2) for (const d of inputsOf(f2)) walk(d)
      }
      walk(input)
      const members = next.features.filter((x) => tree.has(x.name))
      const usedElsewhere = next.features.some((x) => x.name !== a.name && !tree.has(x.name) && inputsOf(x).some((d) => tree.has(d)))
      if (usedElsewhere || members.some((x) => sketchesOf(x).length || refsOf(x).length)) continue
      next.features = next.features.filter((x) => !tree.has(x.name))
      const at = next.features.findIndex((x) => x.name === a.name)
      next.features.splice(at, 0, ...members)
      i = at + members.length
    }
    const before = new Set(next.features.slice(0, i).map((x) => x.name))
    for (const input of inputsOf(next.features[i])) {
      if (before.has(input)) continue
      const later = next.features.some((x) => x.name === input)
      throw new Error(
        later
          ? `"${input}" is defined after "${a.name}"; a feature can only use features before it. Create a new feature after "${input}" that combines them instead`
          : `"${input}" does not exist; features are: ${[...before].join(', ') || '(none before this one)'}`,
      )
    }
    return { doc: next, summary: `updated ${a.name}: ${Object.keys(a.set).join(', ')}` }
  },
})

define({
  name: 'set_appearance',
  group: 'cad',
  kind: 'mutate',
  description:
    'Set how bodies look in the viewport: a color and an opacity (0.05..1; e.g. 0.3 for a see-through case that shows the board inside). Display only: geometry, exports and checks do not change. null resets to the default. Verify with render.',
  args: z.object({
    names: z.array(featureRef).min(1).describe('Bodies to change'),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb, e.g. "#4a90d9"')
      .nullable()
      .optional()
      .describe('#rrggbb, or null for the default grey'),
    opacity: z.number().min(0.05).max(1).nullable().optional().describe('0.05..1, or null for opaque'),
  }),
  examples: [{ names: ['case_body'], opacity: 0.3 }, { names: ['button_cap'], color: '#d6a100' }],
  apply(doc, a) {
    if (a.color === undefined && a.opacity === undefined) throw new Error('set color, opacity or both (null resets one)')
    const next = clone(doc)
    for (const n of a.names) {
      const i = next.features.findIndex((f) => f.name === n)
      if (i < 0) throw new Error(`no feature "${n}"; features are: ${next.features.map((f) => f.name).join(', ') || '(none)'}`)
      const f = { ...next.features[i] }
      if (a.color === null) delete f.color
      else if (a.color !== undefined) f.color = a.color.toLowerCase()
      if (a.opacity === null || a.opacity === 1) delete f.opacity
      else if (a.opacity !== undefined) f.opacity = Math.round(a.opacity * 100) / 100
      next.features[i] = f
    }
    const what = [a.color !== undefined && `color ${a.color ?? 'default'}`, a.opacity !== undefined && `opacity ${a.opacity ?? 1}`].filter(Boolean).join(', ')
    return { doc: next, summary: `${a.names.join(', ')}: ${what}` }
  },
})

define({
  name: 'rename_feature',
  group: 'cad',
  kind: 'mutate',
  description:
    'Rename a feature and every reference to it. To put a new step after a finished body (one more cut on case_shell), rename it to case_shell_a and add the step under the old name: checks and decals stay on the final body with keep_checks: true.',
  args: z.object({
    name: featureRef,
    to: featureName,
    keep_checks: z.boolean().optional().describe('Leave checks and decals on the old name (the body that will replace it), default false'),
  }),
  apply(doc, a) {
    const next = clone(doc)
    if (!findFeature(next, a.name)) throw new Error(`no feature "${a.name}"`)
    if (findFeature(next, a.to)) throw new Error(`"${a.to}" exists already`)
    const ren = (n: string) => (n === a.name ? a.to : n)
    next.features = next.features.map((f) => {
      const g = { ...f, name: ren(f.name) } as Record<string, unknown>
      if (typeof g.target === 'string') g.target = ren(g.target)
      if (Array.isArray(g.tools)) g.tools = (g.tools as string[]).map(ren)
      return g as unknown as Feature
    })
    if (a.keep_checks) return { doc: next, summary: `renamed ${a.name} → ${a.to} (checks and decals stay on ${a.name})` }
    next.checks = next.checks.map((c) => {
      const g = { ...c } as Record<string, unknown>
      for (const k of ['a', 'b', 'inner', 'outer', 'target']) if (typeof g[k] === 'string') g[k] = ren(g[k] as string)
      return g as unknown as typeof c
    })
    if (next.decals) next.decals = next.decals.map((d) => ({ ...d, target: ren(d.target) }))
    return { doc: next, summary: `renamed ${a.name} → ${a.to}` }
  },
})

define({
  name: 'delete_features',
  group: 'cad',
  kind: 'mutate',
  description: 'Delete features. Fails while another feature or a check uses one of them, unless cascade is true (then the users are deleted too).',
  args: z.object({ names: z.array(featureRef).min(1), cascade: z.boolean().optional() }),
  apply(doc, a) {
    const next = clone(doc)
    const drop = new Set(a.names)
    for (const n of a.names) if (!findFeature(next, n)) throw new Error(`no feature "${n}"`)
    // Grow the set with every feature that (transitively) uses a dropped one.
    let grew = true
    const users: string[] = []
    while (grew) {
      grew = false
      for (const f of next.features) {
        if (drop.has(f.name)) continue
        const used = inputsOf(f).filter((i) => drop.has(i))
        if (used.length) {
          users.push(`${f.name} uses ${used.join(', ')}`)
          if (a.cascade) {
            drop.add(f.name)
            grew = true
          }
        }
      }
    }
    if (users.length && !a.cascade) throw new Error(`cannot delete: ${users.join('; ')}. Pass cascade: true to delete them too.`)
    next.features = next.features.filter((f) => !drop.has(f.name))
    const refs = (c: Record<string, unknown>) => ['a', 'b', 'inner', 'outer', 'target'].some((k) => drop.has(c[k] as string))
    const droppedChecks = next.checks.filter((c) => refs(c as never)).map((c) => c.name)
    next.checks = next.checks.filter((c) => !refs(c as never))
    const droppedDecals = (next.decals ?? []).filter((d) => drop.has(d.target)).map((d) => d.name)
    if (next.decals) next.decals = next.decals.filter((d) => !drop.has(d.target))
    return {
      doc: next,
      summary: `deleted ${[...drop].join(', ')}${droppedChecks.length ? `; removed checks ${droppedChecks.join(', ')}` : ''}${droppedDecals.length ? `; removed decals ${droppedDecals.join(', ')}` : ''}`,
    }
  },
})

// ── Checks ──────────────────────────────────────────────────────────────

define({
  name: 'set_checks',
  group: 'checks',
  kind: 'mutate',
  description:
    'Add or replace (by name) design checks: requirements that run_checks verifies after every change. Write the requirements first, then model, then run_checks. Kinds: expr (boolean over parameters), min_distance (clearance between two bodies), no_overlap, inside (inner fits in outer with margin), volume (min/max).',
  args: z.object({ checks: z.array(checkDef).min(1) }),
  examples: [
    {
      checks: [
        { name: 'wall_printable', kind: 'expr', expr: 'wall >= 1.2', note: 'FDM minimum' },
        { name: 'board_fits', kind: 'inside', inner: 'pcb', outer: 'cavity', margin: 0.3 },
      ],
    },
  ],
  apply(doc, a) {
    const next = clone(doc)
    for (const c of a.checks) {
      const i = next.checks.findIndex((x) => x.name === c.name)
      if (i >= 0) next.checks[i] = compact(c) as never
      else next.checks.push(compact(c) as never)
    }
    return { doc: next, summary: `set checks ${a.checks.map((c) => c.name).join(', ')}` }
  },
})

define({
  name: 'delete_checks',
  group: 'checks',
  kind: 'mutate',
  description: 'Delete design checks by name.',
  args: z.object({ names: z.array(z.string()).min(1) }),
  apply(doc, a) {
    const next = clone(doc)
    const missing = a.names.filter((n) => !next.checks.some((c) => c.name === n))
    if (missing.length) throw new Error(`no check ${missing.join(', ')}`)
    next.checks = next.checks.filter((c) => !a.names.includes(c.name))
    return { doc: next, summary: `deleted checks ${a.names.join(', ')}` }
  },
})

define({
  name: 'set_description',
  group: 'project',
  kind: 'mutate',
  description: 'Set the design brief: what is being built and the key requirements, in a few lines. It is shown to every agent that opens the project.',
  args: z.object({ description: z.string() }),
  apply(doc, a) {
    const next = clone(doc)
    next.meta = { ...next.meta, description: a.description }
    return { doc: next, summary: 'updated description' }
  },
})

// batch is recorded as one op holding its steps; replay applies them in
// order. The session validates and runs it (see Session.execBatch).
define({
  name: 'batch',
  group: 'project',
  kind: 'mutate',
  description:
    'Apply up to 256 changes atomically as one undo step. Each step is prepared against the previous step\'s document, so later steps can use earlier parts, nets and parameters. If any step fails, nothing is committed and the error names the step. Change commands only (no queries or nested batches).',
  args: z.object({
    steps: z
      .array(
        z.object({
          cmd: z.string().describe('A change command, e.g. "box", "boolean", "set_parameters"'),
          args: z.record(z.string(), z.unknown()).describe('Its arguments, as when calling it directly'),
        }),
      )
      .min(1).max(256),
  }),
  examples: [
    {
      steps: [
        { cmd: 'set_parameters', args: { parameters: [{ name: 'w', expr: 40 }] } },
        { cmd: 'box', args: { name: 'body', size: ['w', 20, 10] } },
        { cmd: 'fillet', args: { name: 'body_round', target: 'body', r: 2, edges: { where: '|Z' } } },
      ],
    },
  ],
  apply(doc, a) {
    let next = doc
    const summaries: string[] = []
    a.steps.forEach((s, i) => {
      if (s.cmd === 'batch') throw new Error(`step ${i + 1}: batches cannot be nested`)
      try {
        const out = applyOp(next, { cmd: s.cmd, args: s.args })
        next = out.doc
        summaries.push(out.summary)
      } catch (e) {
        throw new Error(`step ${i + 1} (${s.cmd}) failed, nothing was changed: ${(e as Error).message}`)
      }
    })
    return { doc: next, summary: summaries.join('; ') }
  },
})
