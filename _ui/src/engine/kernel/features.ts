// Building one feature into a body: B-rep features, and features over triangle-mesh bodies.

import * as R from 'replicad'
import type { Edge, EdgeFinder, Face, FaceFinder, Shape3D } from 'replicad'

import { type Feature, inputsOf } from '../doc'
import { num } from '../expr'
import { fontMetrics } from '../fonts'
import { mechanismShape } from '../mechanisms'
import { MeshBody, paintAll } from '../mesh-body'
import type { Kernel } from '../kernel'
import { PLANE_AXES, onFrame, onPlane, pathWire, profileDrawing, sketchDrawing } from './drawings'
import { makeDraft, makeHole, makeInsertBoss, makeSnapFit, makeThread } from './mechanical'
import { place, vec } from './placement'
import { AXES, finderOf, selectElements } from './selectors'
import { type Body, bboxOf, boxesApart, cross3, isMesh, kernelMessage, norm3, safeDistance, sub3, volumeOf } from './shapes'
import type { BBox, V3 } from './types'

export function makeFeature(k: Kernel, f: Feature, warnings: string[]): Body {
  const p = k.parameters
  const n = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, p, `${f.name}.${field}`, fb)

  // An instance: a placed copy of a body that stays (mesh or B-rep alike).
  if (f.type === 'instance') {
    const src = k.body(f.of)
    if (isMesh(src)) return src.place(vec(f.rotate, p, `${f.name}.rotate`), vec(f.translate, p, `${f.name}.translate`))
    return place(src, f, p, f.name)
  }
  // A feature over a triangle-mesh body works on meshes (B-rep inputs are tessellated for it).
  if (inputsOf(f).some((i) => k.isMeshBody(i))) return k.makeMesh(f, warnings)
  if (f.type === 'solids') return k.pickSolids(f)
  if (f.type === 'transform' && f.align) {
    const s = place(k.shape(f.target), { rotate: f.rotate }, p, f.name)
    const [dx, dy, dz] = k.alignOffset(f, bboxOf(s))
    return s.translate(dx, dy, dz)
  }

  switch (f.type) {
    case 'box': {
      const [x, y, z] = vec(f.size, p, `${f.name}.size`)
      if (x <= 0 || y <= 0 || z <= 0) throw new Error(`size must be > 0 on every axis (got ${x} × ${y} × ${z})`)
      const c = f.center === undefined ? [true, true, false] : typeof f.center === 'boolean' ? [f.center, f.center, f.center] : f.center
      // makeBaseBox is centered on X/Y and sits on Z=0.
      let s: Shape3D = R.makeBaseBox(x, y, z)
      const dx = c[0] ? 0 : x / 2
      const dy = c[1] ? 0 : y / 2
      const dz = c[2] ? -z / 2 : 0
      if (dx || dy || dz) s = s.translate(dx, dy, dz)
      return place(s, f, p, f.name)
    }
    case 'cylinder': {
      const r = n(f.r, 'r')
      const h = n(f.h, 'h')
      if (r <= 0 || h <= 0) throw new Error(`r and h must be > 0 (got r=${r}, h=${h})`)
      const dir = AXES[f.axis ?? 'Z']
      return place(R.makeCylinder(r, h, [0, 0, 0], dir), f, p, f.name)
    }
    case 'sphere': {
      const r = n(f.r, 'r')
      if (r <= 0) throw new Error(`r must be > 0`)
      return place(R.makeSphere(r), f, p, f.name)
    }
    case 'extrude': {
      const { drawing, plane, offset, frame } = k.outline(f)
      const dist = n(f.distance, 'distance')
      if (!dist) throw new Error('distance must not be 0')
      if (frame) {
        // On a face: out of the face for distance > 0, into it (a pocket) for < 0.
        const o = f.symmetric ? frame.origin.map((x, i) => x - (frame.normal[i] * dist) / 2) : frame.origin
        const sk = onFrame(drawing, { ...frame, origin: o as V3 })
        return place(sk.extrude(dist) as Shape3D, f, p, f.name)
      }
      const flip = plane === 'XZ' ? -1 : 1
      const sk = onPlane(drawing, plane, f.symmetric ? offset - dist / 2 : offset)
      const solid = sk.extrude(dist * flip) as Shape3D
      return place(solid, f, p, f.name)
    }
    case 'hole':
      return makeHole(k, f, warnings)
    case 'insert_boss':
      return makeInsertBoss(k, f, warnings)
    case 'thread':
      return makeThread(k, f, warnings)
    case 'draft':
      return makeDraft(k, f)
    case 'snap_fit':
      return makeSnapFit(k, f, warnings)
    case 'gear':
      return k.gearShape(f, warnings)
    case 'cam':
    case 'geneva':
    case 'belt':
      return mechanismShape(f, k.mechanisms, k.parameters, warnings)
    case 'text': {
      const font = f.font ?? 'regular'
      const metrics = fontMetrics(font)
      if (!metrics) throw new Error(`font "${font}" is not loaded in this kernel`)
      if (!f.text.trim()) throw new Error('text is empty')
      const size = n(f.size, 'size')
      const depth = n(f.depth, 'depth')
      if (size <= 0) throw new Error('size (cap height in mm) must be > 0')
      if (!depth) throw new Error('depth must not be 0; negative goes into the plane, e.g. to engrave')
      let d: R.Drawing
      try {
        d = R.drawText(f.text, { fontSize: size / metrics.capHeight, fontFamily: font })
      } catch (e) {
        throw new Error(`cannot draw "${f.text}" with font ${font}: ${kernelMessage(e)}; use plain letters, digits and punctuation`)
      }
      const [[x0], [x1]] = d.boundingBox.bounds
      const anchor = f.anchor ?? 'center'
      const dx = anchor === 'left' ? -x0 : anchor === 'right' ? -x1 : -(x0 + x1) / 2
      // Cap height is centred on at: the baseline sits size/2 below it.
      d = d.translate(dx, -size / 2)
      const ang = n(f.angle, 'angle', 0)
      if (ang) d = d.rotate(ang, [0, 0])
      const [ax, ay] = f.at ? [n(f.at[0], 'at[0]'), n(f.at[1], 'at[1]')] : [0, 0]
      if (ax || ay) d = d.translate(ax, ay)
      const plane = f.plane
      const flip = plane === 'XZ' ? -1 : 1
      const solid = onPlane(d, plane, n(f.offset, 'offset', 0)).extrude(depth * flip) as Shape3D
      return place(solid, f, p, f.name)
    }
    case 'revolve': {
      const { drawing, plane, offset, frame } = k.outline(f)
      if (frame) throw new Error('revolve needs a sketch on a plane (XY, XZ or YZ) so the axis lies in it; this sketch is on a face')
      const angle = n(f.angle, 'angle', 360)
      if (angle <= 0 || angle > 360) throw new Error('angle must be in (0, 360]')
      const axis = f.axis
      const [u, v] = PLANE_AXES[plane]
      if (axis !== u && axis !== v) {
        throw new Error(`axis ${axis} is not in the ${plane} plane; revolve about ${u} or ${v} (an axis through the origin lying in the sketch plane)`)
      }
      const dir = AXES[axis]
      const sk = onPlane(drawing, plane, offset)
      const solid = (sk as R.Sketch).revolve(dir, { origin: [0, 0, 0], angle }) as Shape3D
      return place(solid, f, p, f.name)
    }
    case 'loft': {
      if (f.sections.length < 2) throw new Error('a loft needs at least 2 sections')
      const sketches = f.sections.map((sec, i) => {
        const what = `${f.name}.sections[${i}]`
        const { drawing, plane, offset, frame } = k.outline({ ...sec, name: what })
        const sk = frame ? onFrame(drawing, frame) : onPlane(drawing, plane, offset)
        if (!(sk instanceof R.Sketch)) {
          throw new Error(`${what} must be one closed outline without holes (loft joins single loops); loft the outer shape and cut the hole afterwards`)
        }
        return sk
      })
      const solid = sketches[0].loftWith(sketches.slice(1), { ruled: !!f.ruled }) as Shape3D
      return place(solid, f, p, f.name)
    }
    case 'sweep': {
      const pts = f.path.map((q, i) => vec(q, p, `${f.name}.path[${i}]`))
      if (pts.length < 2) throw new Error('path needs at least 2 points')
      const bend = n(f.bend, 'bend', 0)
      if (bend < 0) throw new Error('bend must be ≥ 0')
      const spine = pathWire(pts, bend, f.name)
      let drawing: R.Drawing
      if (f.sketch) {
        if (f.profile) throw new Error('use either sketch or profile, not both')
        drawing = sketchDrawing(k.sketch(f.sketch), f.name)
      } else if (f.profile) drawing = profileDrawing(f.profile, p, f.name)
      else throw new Error('needs a profile (rect, circle, slot, polygon) or a sketch for the cross-section')
      const t = norm3(sub3(pts[1], pts[0]))
      const up: V3 = Math.abs(t[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1]
      const xDir = norm3(cross3(up, t))
      const sk = drawing.sketchOnPlane(new R.Plane(pts[0], xDir, t))
      if (!(sk instanceof R.Sketch)) {
        throw new Error('the cross-section must be one closed outline without holes; for a tube sweep the inner profile too and cut it')
      }
      const solid = R.genericSweep(sk.wire, spine, { transitionMode: 'right', forceProfileSpineOthogonality: true }) as Shape3D
      return place(solid, f, p, f.name)
    }
    case 'boolean': {
      let s = k.shape(f.target)
      if (!f.tools.length) throw new Error('tools must name at least one feature')
      const before = volumeOf(s)
      const apart: string[] = []
      if (f.op === 'intersect') {
        for (const t of f.tools) s = s.intersect(k.shape(t)) as Shape3D
      } else {
        // Tools that are clear of each other go into one OpenCascade
        // operation as a compound: one pass over the target instead of one
        // per tool (5-6x faster on a case with many bosses and cut-outs).
        // Tools that may overlap each other stay in separate passes, since
        // a boolean needs arguments that do not interfere.
        const targetBox = bboxOf(s)
        const solids0 = s.solids?.length ?? 1
        const tools = f.tools.map((name) => {
          const shape = k.shape(name)
          return { name, shape, box: bboxOf(shape) }
        })
        const clear = (a: BBox, b: BBox) => boxesApart(a, b, 0.01)
        const groups: (typeof tools)[] = []
        for (const t of tools) {
          const g = groups.find((g) => g.every((o) => clear(o.box, t.box)))
          if (g) g.push(t)
          else groups.push([t])
        }
        for (const g of groups) {
          const tool = g.length === 1 ? g[0].shape : (R.makeCompound(g.map((t) => t.shape)) as Shape3D)
          s = f.op === 'union' ? s.fuse(tool) : s.cut(tool)
        }
        if (f.op === 'cut') {
          // A tool that is clear of the target (outside it, or loose in its cavity) cut nothing.
          const all = Math.abs(volumeOf(s) - before) < 1e-6
          const base = all ? undefined : k.shape(f.target)
          for (const t of f.tools) {
            let missed = all
            if (base) {
              const tool = k.shape(t)
              missed = clear(bboxOf(tool), targetBox) || safeDistance(base, tool) > 1e-6
              tool.delete()
            }
            if (missed) warnings.push(`cutting "${t}" removed no material: it does not overlap "${f.target}"`)
          }
          base?.delete()
        } else if (!f.separate && (s.solids?.length ?? 1) > solids0) {
          // Only a union that really fell apart pays for the distance
          // checks: a tool is apart when no chain of touching tools leads
          // from it to the target.
          const parts = [f.target, ...f.tools].map((name) => {
            const shape = k.shape(name)
            return { name, shape, box: bboxOf(shape) }
          })
          const joined = new Set([f.target])
          const queue = [parts[0]]
          while (queue.length) {
            const a = queue.pop()!
            for (const b of parts) {
              if (joined.has(b.name) || clear(a.box, b.box) || safeDistance(a.shape, b.shape) > 1e-6) continue
              joined.add(b.name)
              queue.push(b)
            }
          }
          for (const t of parts) {
            if (!joined.has(t.name)) apart.push(t.name)
            t.shape.delete()
          }
        }
      }
      if (apart.length) {
        const list = apart.length > 5 ? `${apart.slice(0, 5).map((t) => `"${t}"`).join(', ')} and ${apart.length - 5} more` : apart.map((t) => `"${t}"`).join(', ')
        warnings.push(`${list} do${apart.length === 1 ? 'es' : ''} not touch the rest: the union holds separate solids (pass separate: true if that is intended, e.g. keys or wheels)`)
      }
      if (f.op === 'intersect' && volumeOf(s) < 1e-9) warnings.push('the intersection is empty')
      if (f.op === 'union' && before > 0 && Math.abs(volumeOf(s) - before) < 1e-6) warnings.push('the union added no material')
      return s
    }
    case 'fillet':
    case 'chamfer': {
      const s = k.shape(f.target)
      const size = f.type === 'fillet' ? n(f.r, 'r') : n(f.d, 'd')
      if (size <= 0) throw new Error(`${f.type === 'fillet' ? 'r' : 'd'} must be > 0`)
      const edges = selectElements(s, f.edges, false, p, `${f.name}.edges`) as Edge[]
      if (!edges.length) throw new Error(`the edges selector matched no edge of "${f.target}" (it has ${s.edges.length}); try list_edges to see them`)
      const out =
        f.type === 'fillet'
          ? s.fillet(size, finderOf<EdgeFinder>(edges))
          : s.chamfer(size, finderOf<EdgeFinder>(edges))
      return out
    }
    case 'shell': {
      const s = k.shape(f.target)
      const t = n(f.thickness, 'thickness')
      if (t <= 0) throw new Error('thickness must be > 0')
      const open = selectElements(s, f.open ?? { where: '>Z' }, true, p, `${f.name}.open`) as Face[]
      if (!open.length) throw new Error(`the open selector matched no face of "${f.target}"; try list_faces`)
      return s.shell(t, finderOf<FaceFinder>(open))
    }
    case 'transform':
      return place(k.shape(f.target), f, p, f.name)
    case 'import': {
      const scale = n(f.scale, 'scale', 1)
      if (scale <= 0) throw new Error('scale must be > 0')
      const body = k.importedBody(f.url, f.name)
      if (isMesh(body)) {
        const scaled = scale !== 1 ? body.scale(scale) : body
        return scaled.place(vec(f.rotate, p, `${f.name}.rotate`), vec(f.translate, p, `${f.name}.translate`))
      }
      let shape = body
      if (scale !== 1) shape = shape.scale(scale, [0, 0, 0]) as Shape3D
      return place(shape, f, p, f.name)
    }
    case 'pattern': {
      const base = k.shape(f.target)
      if (f.kind === 'polar') {
        const count = Math.round(n(f.count, 'count'))
        if (count < 1 || count > 500) throw new Error('count must be between 1 and 500')
        const total = n(f.angle, 'angle', 360)
        if (total <= 0 || total > 360) throw new Error('angle must be in (0, 360]')
        const center = vec(f.center, p, `${f.name}.center`)
        const dir = AXES[f.axis ?? 'Z']
        const step = total >= 360 ? 360 / count : count > 1 ? total / (count - 1) : 0
        let out: Shape3D | undefined
        for (let i = 0; i < count; i++) {
          let copy = base.clone() as Shape3D
          if (i) copy = copy.rotate(step * i, center, dir)
          out = out ? out.fuse(copy) : copy
        }
        base.delete()
        return out!
      }
      const offsets: V3[] = []
      if (f.kind === 'linear') {
        const count = Math.round(n(f.count, 'count'))
        if (count < 1 || count > 500) throw new Error('count must be between 1 and 500')
        const step = vec(f.step, p, `${f.name}.step`)
        for (let i = 0; i < count; i++) offsets.push([step[0] * i, step[1] * i, step[2] * i])
      } else {
        const cx = Math.round(num(f.count[0], p, `${f.name}.count[0]`))
        const cy = Math.round(num(f.count[1], p, `${f.name}.count[1]`))
        if (cx < 1 || cy < 1 || cx * cy > 2000) throw new Error('count must be ≥ 1 per axis and at most 2000 in total')
        const sx = num(f.step[0], p, `${f.name}.step[0]`)
        const sy = num(f.step[1], p, `${f.name}.step[1]`)
        for (let i = 0; i < cx; i++) for (let j = 0; j < cy; j++) offsets.push([sx * i, sy * j, 0])
      }
      let out: Shape3D | undefined
      for (const [x, y, z] of offsets) {
        const copy = (base.clone() as Shape3D).translate(x, y, z)
        out = out ? out.fuse(copy) : copy
      }
      base.delete()
      return out!
    }
    case 'mirror': {
      const s = k.shape(f.target)
      const off = n(f.offset, 'offset', 0)
      const normal: V3 = f.plane === 'XY' ? [0, 0, 1] : f.plane === 'XZ' ? [0, 1, 0] : [1, 0, 0]
      const origin: V3 = [normal[0] * off, normal[1] * off, normal[2] * off]
      const image = (s.clone() as Shape3D).mirror(normal, origin)
      if (f.keep === false) {
        s.delete()
        return image
      }
      return s.fuse(image)
    }
  }
}

/** Features whose inputs include a mesh body: booleans, transforms, patterns and mirrors on meshes. */
export function makeMeshFeature(k: Kernel, f: Feature, warnings: string[]): MeshBody {
  const p = k.parameters
  const n = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, p, `${f.name}.${field}`, fb)
  switch (f.type) {
    case 'boolean': {
      if (!f.tools.length) throw new Error('tools must name at least one feature')
      const target = k.meshOf(f.target)
      const tools: { name: string; body: MeshBody }[] = []
      try {
        for (const t of f.tools) {
          const fil = f.paint?.[t]
          tools.push({ name: t, body: fil ? paintAll(k.meshOf(t), fil, t) : k.meshOf(t) })
        }
      } catch (e) {
        target.delete()
        for (const t of tools) t.body.delete()
        throw e
      }
      const before = target.volume()
      const targetBox = target.bbox()
      if (f.op === 'cut') {
        // Only tools whose box meets the target can cut; one that misses removes nothing.
        for (const t of tools) if (boxesApart(t.body.bbox(), targetBox, 0.01)) warnings.push(`cutting "${t.name}" removed no material: it does not overlap "${f.target}"`)
      }
      const solids0 = f.op === 'union' && !f.separate ? target.solids() : 0
      for (const k of Object.keys(f.paint ?? {})) if (!f.tools.includes(k)) warnings.push(`paint names "${k}", which is not one of the tools`)
      const owned = tools.flatMap((t) => (t.body.paintId !== undefined ? [t.body.paintId] : []))
      const out = target.boolean(f.op, tools.map((t) => t.body))
      if (owned.length) out.ownPaint = owned
      if (f.op === 'cut' && tools.length && !warnings.length && Math.abs(out.volume() - before) < 1e-6) warnings.push(`cutting ${f.tools.map((t) => `"${t}"`).join(', ')} removed no material: ${f.tools.length > 1 ? 'they do' : 'it does'} not overlap "${f.target}"`)
      const after = out.volume()
      if (f.op === 'intersect' && after < 1e-9) warnings.push('the intersection is empty')
      if (f.op === 'union' && before > 0 && Math.abs(after - before) < 1e-6) warnings.push('the union added no material')
      if (f.op === 'union' && !f.separate && out.solids() > solids0) warnings.push('some tools do not touch the rest: the union holds separate solids (pass separate: true if that is intended, e.g. keys or wheels)')
      return out
    }
    case 'transform': {
      const rotated = k.meshOf(f.target).place(vec(f.rotate, p, `${f.name}.rotate`), [0, 0, 0])
      const t = f.align ? k.alignOffset(f, rotated.bbox()) : vec(f.translate, p, `${f.name}.translate`)
      return rotated.translate(t)
    }
    case 'mirror': {
      const s = k.meshOf(f.target)
      const off = n(f.offset, 'offset', 0)
      const normal: V3 = f.plane === 'XY' ? [0, 0, 1] : f.plane === 'XZ' ? [0, 1, 0] : [1, 0, 0]
      const origin: V3 = [normal[0] * off, normal[1] * off, normal[2] * off]
      const image = s.clone().mirror(normal, origin)
      if (f.keep === false) {
        s.delete()
        return image
      }
      return s.boolean('union', [image])
    }
    case 'pattern': {
      const base = k.meshOf(f.target)
      const copies: MeshBody[] = []
      if (f.kind === 'polar') {
        const count = Math.round(n(f.count, 'count'))
        if (count < 1 || count > 500) throw new Error('count must be between 1 and 500')
        const total = n(f.angle, 'angle', 360)
        if (total <= 0 || total > 360) throw new Error('angle must be in (0, 360]')
        const center = vec(f.center, p, `${f.name}.center`)
        const dir = AXES[f.axis ?? 'Z']
        const step = total >= 360 ? 360 / count : count > 1 ? total / (count - 1) : 0
        for (let i = 1; i < count; i++) copies.push(base.clone().rotateAbout(step * i, center, dir))
      } else {
        const offsets: V3[] = []
        if (f.kind === 'linear') {
          const count = Math.round(n(f.count, 'count'))
          if (count < 1 || count > 500) throw new Error('count must be between 1 and 500')
          const step = vec(f.step, p, `${f.name}.step`)
          for (let i = 1; i < count; i++) offsets.push([step[0] * i, step[1] * i, step[2] * i])
        } else {
          const cx = Math.round(num(f.count[0], p, `${f.name}.count[0]`))
          const cy = Math.round(num(f.count[1], p, `${f.name}.count[1]`))
          if (cx < 1 || cy < 1 || cx * cy > 2000) throw new Error('count must be ≥ 1 per axis and at most 2000 in total')
          const sx = num(f.step[0], p, `${f.name}.step[0]`)
          const sy = num(f.step[1], p, `${f.name}.step[1]`)
          for (let i = 0; i < cx; i++) for (let j = 0; j < cy; j++) if (i || j) offsets.push([sx * i, sy * j, 0])
        }
        for (const o of offsets) copies.push(base.clone().translate(o))
      }
      return copies.length ? base.boolean('union', copies) : base
    }
    case 'fillet':
    case 'chamfer':
    case 'shell':
    case 'hole':
    case 'insert_boss':
    case 'draft':
      throw new Error(`"${f.target}" is a triangle mesh (imported STL / 3MF): ${f.type} needs a B-rep solid with edges and faces. Round or hollow the B-rep parts before combining them with the mesh, or cut a shaped tool out of the mesh with boolean`)
    default:
      throw new Error(`${f.type} does not work on triangle meshes`)
  }
}
