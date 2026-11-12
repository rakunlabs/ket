// Face and edge selectors in CadQuery's string syntax (>Z, |Z, ...), plus type, inBox and near filters.

import * as R from 'replicad'
import type { AnyShape, Edge, EdgeFinder, Face, FaceFinder } from 'replicad'

import type { Selector } from '../doc'
import { vec } from './placement'
import type { V3 } from './types'

export const SURFACE_TYPES: Record<string, string> = {
  plane: 'PLANE',
  cylinder: 'CYLINDRE',
  cone: 'CONE',
  sphere: 'SPHERE',
  torus: 'TORUS',
  bspline: 'BSPLINE_SURFACE',
  bezier: 'BEZIER_SURFACE',
  revolution: 'REVOLUTION_SURFACE',
  extrusion: 'EXTRUSION_SURFACE',
  offset: 'OFFSET_SURFACE',
}

export const CURVE_TYPES: Record<string, string> = {
  line: 'LINE',
  circle: 'CIRCLE',
  ellipse: 'ELLIPSE',
  hyperbola: 'HYPERBOLA',
  parabola: 'PARABOLA',
  bezier: 'BEZIER_CURVE',
  bspline: 'BSPLINE_CURVE',
}

export function friendlyType(t: string): string {
  for (const [k, v] of Object.entries({ ...SURFACE_TYPES, ...CURVE_TYPES })) if (v === t) return k
  return t.toLowerCase()
}

export const AXES: Record<string, V3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }

export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const norm = (a: V3) => Math.hypot(a[0], a[1], a[2])

export function centerOf(el: Face | Edge): V3 {
  const [a, b] = el.boundingBox.bounds as [V3, V3]
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
}

export function directionOf(el: Face | Edge, isFace: boolean): V3 | undefined {
  try {
    if (isFace) return (el as Face).normalAt().toTuple() as V3
    return (el as Edge).tangentAt(0.5).toTuple() as V3
  } catch {
    return undefined
  }
}

/**
 * One selector term in CadQuery's string syntax, which models know well:
 *   >Z / <Z   the elements farthest along +Z / -Z (by center)
 *   +Z / -Z   faces whose normal points along +Z / -Z
 *   |Z        faces: normal parallel to Z; edges: edge parallel to Z
 *   #Z        faces: normal perpendicular to Z; edges: edge perpendicular to Z
 *   all
 */
export function termFilter(term: string, all: (Face | Edge)[], isFace: boolean): (el: Face | Edge) => boolean {
  const t = term.trim()
  if (t === 'all' || t === '') return () => true
  if (t.startsWith('not ')) {
    const f = termFilter(t.slice(4), all, isFace)
    return (el) => !f(el)
  }

  const m = /^([<>+\-|#])([XYZ])$/.exec(t)
  if (!m) {
    throw new Error(`unknown selector "${term}": use >Z <Z +Z -Z |Z #Z (any axis X Y Z), "all", "not ...", joined with " and "`)
  }
  const [, op, ax] = m
  const axis = AXES[ax]
  const tol = 1e-3

  switch (op) {
    case '>':
    case '<': {
      const vals = all.map((el) => dot(centerOf(el), axis))
      const ext = op === '>' ? Math.max(...vals) : Math.min(...vals)
      return (el) => Math.abs(dot(centerOf(el), axis) - ext) < tol
    }
    case '+':
    case '-': {
      if (!isFace) throw new Error(`"${term}" applies to faces; for edges use >${ax}, <${ax}, |${ax} or #${ax}`)
      const sign = op === '+' ? 1 : -1
      return (el) => {
        const d = directionOf(el, true)
        return !!d && dot(d, axis) * sign > 1 - tol
      }
    }
    case '|':
      return (el) => {
        const d = directionOf(el, isFace)
        return !!d && Math.abs(Math.abs(dot(d, axis)) / (norm(d) || 1) - 1) < tol
      }
    case '#':
      return (el) => {
        const d = directionOf(el, isFace)
        return !!d && Math.abs(dot(d, axis)) / (norm(d) || 1) < tol
      }
  }

  return () => true
}

/** Elements of shape matched by a selector. */
export function selectElements(shape: AnyShape, sel: Selector | undefined, isFace: boolean, params: Map<string, number>, what: string): (Face | Edge)[] {
  const { all, picked } = selectIndexed(shape, sel, isFace, params, what)
  return picked.map((i) => all[i])
}

/** Like selectElements, but returns indices into one list of elements. */
export function selectIndexed(
  shape: AnyShape,
  sel: Selector | undefined,
  isFace: boolean,
  params: Map<string, number>,
  what = 'selector',
): { all: (Face | Edge)[]; picked: number[] } {
  const all: (Face | Edge)[] = isFace ? shape.faces : shape.edges
  const idx = all.map((_, i) => i)
  if (!sel) return { all, picked: idx }

  let out = idx
  if (sel.where) {
    for (const term of sel.where.split(/\s+and\s+/)) {
      const f = termFilter(term, all, isFace)
      out = out.filter((i) => f(all[i]))
    }
  }
  if (sel.type) {
    const want = (isFace ? SURFACE_TYPES : CURVE_TYPES)[sel.type.toLowerCase()]
    if (!want) {
      throw new Error(`${what}: unknown ${isFace ? 'face' : 'edge'} type "${sel.type}"; use one of ${Object.keys(isFace ? SURFACE_TYPES : CURVE_TYPES).join(', ')}`)
    }
    out = out.filter((i) => all[i].geomType === want)
  }
  if (sel.inBox) {
    const a = vec(sel.inBox[0], params, `${what}.inBox[0]`)
    const b = vec(sel.inBox[1], params, `${what}.inBox[1]`)
    const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])]
    const hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])]
    out = out.filter((i) => {
      const c = centerOf(all[i])
      return c.every((v, k) => v >= lo[k] - 1e-6 && v <= hi[k] + 1e-6)
    })
  }
  if (sel.near) {
    const p = vec(sel.near, params, `${what}.near`)
    const probe = R.makeSphere(0.001).translate(p[0], p[1], p[2])
    out = out.filter((i) => {
      try {
        return R.measureDistanceBetween(all[i], probe) < 0.01
      } catch {
        return false
      }
    })
    probe.delete()
  }

  return { all, picked: out }
}

export function finderOf<T extends FaceFinder | EdgeFinder>(list: (Face | Edge)[]) {
  return (f: T) => (f as FaceFinder & EdgeFinder).inList(list as never) as T
}
