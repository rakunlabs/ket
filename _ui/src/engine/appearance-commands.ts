// Appearance commands: PBR materials (base color, metallic, roughness,
// normal, AO and displacement maps, UV mapping) and decals (printed text or
// images projected onto a body). They are display only: geometry, exports
// and checks never change. Raised or engraved lettering that must exist in
// the part is the text feature instead.

import { z } from 'zod'

import { type Decal, type Doc, type Material, findFeature, normalizeDoc } from './doc'
import { define } from './registry'
import { expr, featureRef, ident, vec2, vec3 } from './schema'

function clone(doc: Doc): Doc {
  return normalizeDoc(JSON.parse(JSON.stringify(doc)) as Doc)
}

function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb, e.g. "#4a90d9"')
const unit = z.number().min(0).max(1)

export const PATTERNS = ['noise', 'brushed', 'scratches', 'wood', 'leather', 'checker', 'grid', 'dots', 'knurl'] as const

const textureMap = z
  .object({
    pattern: z.enum(PATTERNS).optional().describe('Procedural, tileable: noise (cast, sand), brushed (metal grain along u), scratches, wood (rings along u), leather, checker, grid, dots, knurl'),
    image: z.string().optional().describe('Image URL (https or data:) instead of a pattern; for normal maps it must be a tangent-space normal map'),
    scale: z.number().positive().optional().describe('Tile size in mm (default: uv.scale)'),
    strength: z.number().min(0).optional().describe('How strong: 0..1 for most maps (default 0.5); displacement: relief in mm (default 0.2)'),
    color2: hexColor.optional().describe('albedo only: the second color the pattern mixes in (default a darker color)'),
    seed: z.number().int().optional(),
  })
  .refine((m) => !!m.pattern !== !!m.image, 'give either pattern or image')

const PRESETS: Record<string, Omit<Material, 'name'>> = {
  aluminum: { color: '#c7c9cc', metalness: 0.9, roughness: 0.38, uv: { projection: 'box', scale: 6 }, maps: { roughness: { pattern: 'noise', strength: 0.15 }, normal: { pattern: 'noise', strength: 0.05 } } },
  aluminum_dark: { color: '#3b3d42', metalness: 0.85, roughness: 0.42, uv: { projection: 'box', scale: 6 }, maps: { roughness: { pattern: 'noise', strength: 0.15 }, normal: { pattern: 'noise', strength: 0.05 } } },
  brushed_steel: { color: '#b9bbbe', metalness: 1, roughness: 0.32, uv: { projection: 'box', scale: 20 }, maps: { normal: { pattern: 'brushed', strength: 0.25 }, roughness: { pattern: 'brushed', strength: 0.3 } } },
  chrome: { color: '#e8e8ea', metalness: 1, roughness: 0.06 },
  gold: { color: '#d4a640', metalness: 1, roughness: 0.25 },
  brass: { color: '#c9a45a', metalness: 1, roughness: 0.3, uv: { projection: 'box', scale: 10 }, maps: { roughness: { pattern: 'scratches', strength: 0.3 } } },
  copper: { color: '#c27a52', metalness: 1, roughness: 0.3 },
  cast_iron: { color: '#3d3c3a', metalness: 0.7, roughness: 0.75, uv: { projection: 'box', scale: 4 }, maps: { normal: { pattern: 'noise', strength: 0.6 }, ao: { pattern: 'noise', strength: 0.4 }, roughness: { pattern: 'noise', strength: 0.3 } } },
  painted_metal: { color: '#1f3b2d', metalness: 0.3, roughness: 0.45, clearcoat: 0.4 },
  plastic_matte: { color: '#2b2b2b', metalness: 0, roughness: 0.8, uv: { projection: 'box', scale: 3 }, maps: { normal: { pattern: 'noise', strength: 0.15 } } },
  plastic_glossy: { color: '#d8d8d8', metalness: 0, roughness: 0.2, clearcoat: 0.6 },
  rubber: { color: '#1e1e1e', metalness: 0, roughness: 0.95 },
  glass: { color: '#dfe8ec', metalness: 0, roughness: 0.03, opacity: 0.25, clearcoat: 1 },
  screen: { color: '#0b0f17', metalness: 0, roughness: 0.08, clearcoat: 1, emissive: 0.15 },
  wood: { color: '#a8743f', metalness: 0, roughness: 0.6, uv: { projection: 'box', scale: 40 }, maps: { albedo: { pattern: 'wood', color2: '#6e4522', strength: 0.8 }, normal: { pattern: 'wood', strength: 0.2 } } },
  leather: { color: '#5a3a26', metalness: 0, roughness: 0.7, uv: { projection: 'box', scale: 8 }, maps: { normal: { pattern: 'leather', strength: 0.5 }, ao: { pattern: 'leather', strength: 0.3 } } },
  knurled_steel: { color: '#a9abae', metalness: 1, roughness: 0.4, uv: { projection: 'cylindrical', axis: 'Z', scale: 3 }, maps: { normal: { pattern: 'knurl', strength: 0.8 }, ao: { pattern: 'knurl', strength: 0.4 } } },
}

export const PRESET_NAMES = Object.keys(PRESETS)

define({
  name: 'set_material',
  group: 'appearance',
  kind: 'mutate',
  description:
    'Create or change a PBR material (display only: geometry, exports and checks do not change), then give it to bodies with assign_material. Start from a preset (aluminum, brushed_steel, chrome, glass, rubber, wood, screen, ...) and override fields. color is the base color (albedo); metalness 0 plastic .. 1 metal; roughness 0 mirror .. 1 matte; emissive makes it glow (screens, LEDs); clearcoat adds a lacquer layer. maps add surface detail from tileable procedural patterns or images: albedo (color variation), normal (fake small bumps, scratches, grain), roughness, metallic, ao (darkens crevices), displacement (moves the displayed surface; real relief that must print belongs in geometry). uv says how maps wrap around the body: box (any shape), planar or cylindrical along an axis, scale = tile size in mm.',
  args: z.object({
    name: ident.describe('Material name, e.g. "case_alu"'),
    preset: z.enum(PRESET_NAMES as [string, ...string[]]).optional().describe('Start from these values; the other fields override them'),
    color: hexColor.optional().describe('Base color (albedo)'),
    metalness: unit.optional(),
    roughness: unit.optional(),
    opacity: z.number().min(0.05).max(1).optional(),
    emissive: unit.optional().describe('Glow, as a fraction of the color'),
    clearcoat: unit.optional(),
    uv: z
      .object({
        projection: z.enum(['box', 'planar', 'cylindrical']),
        axis: z.enum(['X', 'Y', 'Z']).optional().describe('planar: the direction it projects along; cylindrical: the cylinder axis (default Z)'),
        scale: z.number().positive().optional().describe('Tile size in mm (default 10)'),
        rotation: z.number().optional().describe('Degrees'),
        offset: z.tuple([z.number(), z.number()]).optional().describe('[u, v] in mm'),
      })
      .optional()
      .describe('How texture maps are laid onto the surface (UV mapping)'),
    maps: z
      .object({
        albedo: textureMap.optional(),
        normal: textureMap.optional(),
        roughness: textureMap.optional(),
        metallic: textureMap.optional(),
        ao: textureMap.optional(),
        displacement: textureMap.optional(),
      })
      .optional(),
    note: z.string().optional(),
  }),
  examples: [
    { name: 'case_alu', preset: 'aluminum', color: '#c7c9cc' },
    { name: 'oak', preset: 'wood', uv: { projection: 'planar', axis: 'Z', scale: 60, rotation: 90 } },
    { name: 'grip', color: '#202020', roughness: 0.9, uv: { projection: 'cylindrical', axis: 'Z', scale: 2 }, maps: { normal: { pattern: 'knurl', strength: 0.9 }, displacement: { pattern: 'knurl', strength: 0.15 } } },
  ],
  apply(doc, a) {
    const next = clone(doc)
    next.materials ??= []
    const i = next.materials.findIndex((m) => m.name === a.name)
    const base: Partial<Material> = a.preset ? JSON.parse(JSON.stringify(PRESETS[a.preset])) : i >= 0 ? next.materials[i] : {}
    const { preset: _p, maps, ...rest } = a
    const m = compact({ ...base, ...compact(rest), maps: maps || base.maps ? compact({ ...base.maps, ...maps }) : undefined }) as Material
    m.name = a.name
    if (!m.color) m.color = '#a9aaa2'
    if (i >= 0) next.materials[i] = m
    else next.materials.push(m)
    const users = next.features.filter((f) => f.material === a.name).map((f) => f.name)
    return { doc: next, summary: `${i >= 0 ? 'changed' : 'added'} material ${a.name}${a.preset ? ` (${a.preset})` : ''}${users.length ? `, used by ${users.join(', ')}` : ''}` }
  },
})

define({
  name: 'assign_material',
  group: 'appearance',
  kind: 'mutate',
  description: 'Give bodies a material from set_material (null removes it, back to the plain color). The material wins over the body color. Verify with render.',
  args: z.object({
    names: z.array(featureRef).min(1).describe('Bodies'),
    material: ident.nullable().describe('Material name, or null'),
  }),
  examples: [{ names: ['base', 'lid'], material: 'case_alu' }],
  apply(doc, a) {
    const next = clone(doc)
    if (a.material !== null && !next.materials?.some((m) => m.name === a.material)) {
      throw new Error(`no material "${a.material}"; materials are: ${next.materials?.map((m) => m.name).join(', ') || '(none; create one with set_material)'}`)
    }
    for (const n of a.names) {
      const i = next.features.findIndex((f) => f.name === n)
      if (i < 0) throw new Error(`no feature "${n}"; features are: ${next.features.map((f) => f.name).join(', ') || '(none)'}`)
      const f = { ...next.features[i] }
      if (a.material === null) delete f.material
      else f.material = a.material
      next.features[i] = f
    }
    return { doc: next, summary: `${a.names.join(', ')}: material ${a.material ?? 'none'}` }
  },
})

define({
  name: 'delete_materials',
  group: 'appearance',
  kind: 'mutate',
  description: 'Delete materials; bodies that used them go back to their plain color.',
  args: z.object({ names: z.array(ident).min(1) }),
  apply(doc, a) {
    const next = clone(doc)
    for (const n of a.names) if (!next.materials?.some((m) => m.name === n)) throw new Error(`no material "${n}"`)
    const drop = new Set(a.names)
    next.materials = (next.materials ?? []).filter((m) => !drop.has(m.name))
    next.features = next.features.map((f) => {
      if (!f.material || !drop.has(f.material)) return f
      const g = { ...f }
      delete g.material
      return g
    })
    return { doc: next, summary: `deleted materials ${a.names.join(', ')}` }
  },
})

const decalArgs = z.object({
  name: ident.describe('Decal name, e.g. "logo", "key_label_a"'),
  target: featureRef.describe('The body it is printed on (a visible body)'),
  at: vec3.describe('Point on (or just above) the surface, at the center of the decal'),
  normal: z.tuple([z.number(), z.number(), z.number()]).describe('Direction the printed side faces, out of the surface, e.g. [0, 0, 1] on a top face'),
  up: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Which way the top of the text points (default +Z; +Y when normal is ±Z)'),
  size: vec2.describe('[w, h] in mm on the surface'),
  depth: expr.optional().describe('Thickness of the projection box in mm (default 2): what it may wrap onto'),
  rotation: expr.optional().describe('Degrees about the normal'),
  text: z.string().optional().describe('Text to print (several lines with \\n)'),
  image: z.string().optional().describe('Image URL (https or data:), e.g. a logo PNG or SVG'),
  color: hexColor.optional().describe('Text color (default black), or a tint for images'),
  background: hexColor.optional().describe('Fill behind the text (default transparent)'),
  font_size: expr.optional().describe('Text cap height in mm (default: fits the decal)'),
  font: z.string().optional().describe('CSS font family (default the system UI font)'),
  weight: z.number().int().min(100).max(900).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  valign: z.enum(['top', 'middle', 'bottom']).optional(),
  roughness: unit.optional(),
  metalness: unit.optional(),
  emissive: unit.optional().describe('Glow, e.g. backlit key legends'),
  opacity: z.number().min(0.05).max(1).optional(),
  replace: z.boolean().optional().describe('Replace the decal with this name (default false: fail if it exists)'),
})

define({
  name: 'add_decal',
  group: 'appearance',
  kind: 'mutate',
  description:
    'Print text or an image onto a body, projected along -normal at a point: labels, key legends, logos, serial plates, dials. Display only (a texture, like a sticker or pad print); for raised or engraved letters that must be in the part use the text feature. Place it with at on the surface and normal pointing out of it; it wraps over curved faces within depth. Check with render.',
  args: decalArgs,
  examples: [
    { name: 'brand', target: 'lid', at: [0, 120, 10], normal: [0, -0.34, 0.94], size: [40, 12], text: 'ACME', color: '#ffffff', weight: 600 },
    { name: 'key_a', target: 'keys', at: [-80, 10, 7.7], normal: [0, 0, 1], size: [16, 16], text: 'A', font_size: 3, color: '#ffffff' },
  ],
  apply(doc, a) {
    if (!a.text && !a.image) throw new Error('give text or image')
    if (a.text && a.image) throw new Error('give text or image, not both; use two decals')
    if (!a.normal.some((v) => v !== 0)) throw new Error('normal must not be [0, 0, 0]')
    const next = clone(doc)
    if (!findFeature(next, a.target)) throw new Error(`no feature "${a.target}"; features are: ${next.features.map((f) => f.name).join(', ') || '(none)'}`)
    next.decals ??= []
    const { replace, ...rest } = a
    const d = compact(rest) as Decal
    const i = next.decals.findIndex((x) => x.name === a.name)
    if (i >= 0 && !replace) throw new Error(`a decal named "${a.name}" exists; pick another name, or pass replace: true`)
    if (i >= 0) next.decals[i] = d
    else next.decals.push(d)
    return { doc: next, summary: `${i >= 0 ? 'replaced' : 'added'} decal ${a.name} on ${a.target}` }
  },
})

define({
  name: 'add_decals',
  group: 'appearance',
  kind: 'mutate',
  description: 'Add many decals at once (e.g. every key legend of a keyboard): the same fields as add_decal per item, plus shared defaults that each item may override.',
  args: z.object({
    defaults: decalArgs.partial().omit({ name: true, replace: true }).optional().describe('Fields shared by every decal (target, normal, size, color, font, ...)'),
    decals: z.array(decalArgs.partial().extend({ name: ident })).min(1),
    replace: z.boolean().optional(),
  }),
  apply(doc, a) {
    const next = clone(doc)
    next.decals ??= []
    for (const [k, item] of a.decals.entries()) {
      const r = decalArgs.safeParse({ ...a.defaults, ...item })
      if (!r.success) throw new Error(`decals[${k}] (${item.name}): ${r.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`).join('; ')}`)
      const d = r.data
      if (!d.text && !d.image) throw new Error(`decals[${k}] (${d.name}): give text or image`)
      if (!findFeature(next, d.target)) throw new Error(`decals[${k}] (${d.name}): no feature "${d.target}"`)
      const { replace: _r, ...rest } = d
      const i = next.decals.findIndex((x) => x.name === d.name)
      if (i >= 0 && !a.replace) throw new Error(`decals[${k}]: a decal named "${d.name}" exists; pass replace: true to redefine`)
      if (i >= 0) next.decals[i] = compact(rest) as Decal
      else next.decals.push(compact(rest) as Decal)
    }
    return { doc: next, summary: `added ${a.decals.length} decals` }
  },
})

define({
  name: 'delete_decals',
  group: 'appearance',
  kind: 'mutate',
  description: 'Delete decals by name, or every decal on a target.',
  args: z.object({ names: z.array(ident).optional(), target: featureRef.optional() }),
  apply(doc, a) {
    if (!a.names?.length && !a.target) throw new Error('give names or target')
    const next = clone(doc)
    const before = next.decals?.length ?? 0
    for (const n of a.names ?? []) if (!next.decals?.some((d) => d.name === n)) throw new Error(`no decal "${n}"`)
    const drop = new Set(a.names ?? [])
    next.decals = (next.decals ?? []).filter((d) => !drop.has(d.name) && d.target !== a.target)
    return { doc: next, summary: `deleted ${before - next.decals.length} decal(s)` }
  },
})

define({
  name: 'set_explode',
  group: 'cad',
  kind: 'mutate',
  description:
    'Define the exploded view (display only, like materials): steps move bodies apart by offset [x, y, z] mm (expressions allowed) so the assembly can be seen part by part: the lid up, the board above the base, keycaps above their switches. Board parts move with "board" unless listed themselves; "part_*" matches every part. The viewport Explode slider and render with explode: 1 show it; the model, checks and exports never move. Replaces the earlier definition; steps: [] removes it.',
  args: z.object({
    steps: z
      .array(
        z.object({
          names: z.array(z.string().min(1)).min(1).describe('Bodies, or a prefix ending in * (e.g. "part_*", "cap*")'),
          offset: vec3,
          note: z.string().optional(),
        }),
      )
      .max(64),
  }),
  examples: [{ steps: [{ names: ['lid'], offset: [0, 0, 30] }, { names: ['board', 'part_*'], offset: [0, 0, 15] }] }],
  apply(doc, a) {
    const next = clone(doc)
    const known = new Set([...next.features.map((f) => f.name), 'board', ...(next.pcb?.components ?? []).map((c) => `part_${c.ref}`)])
    for (const st of a.steps)
      for (const n of st.names) {
        if (n.endsWith('*')) {
          if (![...known].some((k) => k.startsWith(n.slice(0, -1)))) throw new Error(`"${n}" matches no body`)
        } else if (!known.has(n)) throw new Error(`no body "${n}"; bodies are ${[...known].slice(0, 40).join(', ')}`)
      }
    if (!a.steps.length) delete next.explode
    else next.explode = { steps: a.steps.map((s) => compact({ ...s })) }
    return { doc: next, summary: a.steps.length ? `exploded view: ${a.steps.map((s) => `${s.names.join(', ')} by [${s.offset.join(', ')}]`).join('; ')}` : 'removed the exploded view' }
  },
})
