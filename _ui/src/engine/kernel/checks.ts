// Evaluating one check of the document: expr, min_distance, no_overlap,
// inside, volume, and the printability checks overhang and min_wall.

import type { Check } from '../doc'
import { num } from '../expr'
import type { Kernel } from '../kernel'
import { overhangs, thinWalls } from './printability'
import { bodyBox, bodyVolume, kernelMessage } from './shapes'
import type { CheckResult } from './types'

const box = (b: [number[], number[]]) => `[${b[0].join(', ')}]..[${b[1].join(', ')}]`

export function runCheck(k: Kernel, c: Check): CheckResult {
  const p = k.parameters
  const base = { name: c.name, kind: c.kind, note: c.note }
  try {
    switch (c.kind) {
      case 'expr': {
        const v = num(c.expr, p, `check ${c.name}`)
        return { ...base, ok: v !== 0, detail: v !== 0 ? `${c.expr} holds` : `${c.expr} is false` }
      }
      case 'min_distance': {
        const min = num(c.min, p, `check ${c.name}.min`)
        const d = k.pair('distance', c.a, c.b, () => k.distanceOf(c.a, c.b), min)
        const exact = !k.boxApart(c.a, c.b, min)
        return { ...base, ok: d >= min - 1e-6, detail: `distance ${c.a}↔${c.b} ${exact ? '=' : '≥'} ${d.toFixed(3)} mm (min ${min})` }
      }
      case 'no_overlap': {
        const v = k.pair('overlap', c.a, c.b, () => k.overlapOf(c.a, c.b).volume)
        const allow = c.allow ?? 0
        if (v < 1e-6) return { ...base, ok: true, detail: `${c.a} and ${c.b} do not overlap` }
        return { ...base, ok: v <= allow + 1e-6, detail: `${c.a} and ${c.b} overlap by ${v.toFixed(3)} mm³${allow ? ` (allowed ${allow})` : ''}` }
      }
      case 'inside': {
        // inner must lie fully within outer (a body that stands for the
        // free space, e.g. a cavity), keeping margin to every side of
        // outer's bounding box.
        const margin = num(c.margin, p, `check ${c.name}.margin`, 0)
        const [si, so] = [k.body(c.inner), k.body(c.outer)]
        const [ilo, ihi] = bodyBox(si)
        const [olo, ohi] = bodyBox(so)
        const vi = bodyVolume(si)
        si.delete()
        so.delete()
        const within = k.overlapOf(c.inner, c.outer).volume
        // Mesh volumes carry float rounding: allow a tiny fraction of the inner volume.
        const tol = Math.max(1e-6, vi * 1e-6)
        const outside = Math.max(0, vi - within)
        const gaps = [0, 1, 2].flatMap((i) => [ilo[i] - olo[i], ohi[i] - ihi[i]])
        const minGap = Math.min(...gaps)
        const ok = minGap >= margin - 1e-6 && outside < tol
        const axis = ['-X', '+X', '-Y', '+Y', '-Z', '+Z'][gaps.indexOf(minGap)]
        return {
          ...base,
          ok,
          detail:
            (outside >= tol ? `${outside.toFixed(3)} mm³ of ${c.inner} is outside ${c.outer}; ` : '') +
            `smallest gap ${minGap.toFixed(3)} mm on ${axis} (margin ${margin})`,
        }
      }
      case 'volume': {
        const s = k.body(c.target)
        const v = bodyVolume(s)
        s.delete()
        const min = c.min !== undefined ? num(c.min, p, `check ${c.name}.min`) : -Infinity
        const max = c.max !== undefined ? num(c.max, p, `check ${c.name}.max`) : Infinity
        return { ...base, ok: v >= min && v <= max, detail: `volume ${v.toFixed(2)} mm³` }
      }
      case 'overhang': {
        const angle = num(c.angle, p, `check ${c.name}.angle`, 45)
        if (!(angle > 0 && angle < 90)) throw new Error(`angle must be between 0 and 90 degrees from vertical (got ${angle})`)
        const allow = num(c.max_area, p, `check ${c.name}.max_area`, 0)
        const axis = c.axis ?? '+Z'
        const m = k.meshOf(c.target)
        let r: ReturnType<typeof overhangs>
        try {
          r = overhangs(m.triMesh(), angle, axis)
        } finally {
          m.delete()
        }
        const ok = r.area <= allow + 1e-6
        if (r.area < 1e-6) return { ...base, ok, detail: `no overhang steeper than ${angle}° printing ${axis}` }
        const where = r.regions.slice(0, 3).map((g) => `${g.value} mm² in ${box(g.box)}`).join('; ')
        return {
          ...base,
          ok,
          detail:
            `${r.area.toFixed(2)} mm² overhangs more than ${angle}° printing ${axis}${allow ? ` (allowed ${allow})` : ''}, ${r.regions.length} region${r.regions.length === 1 ? '' : 's'}: ${where}` +
            (ok ? '' : '. Chamfer it to 45°, turn the part (axis), plan support, or allow the area with max_area'),
        }
      }
      case 'min_wall': {
        const min = num(c.min, p, `check ${c.name}.min`)
        if (!(min > 0)) throw new Error('min must be > 0')
        const m = k.meshOf(c.target)
        let r: ReturnType<typeof thinWalls>
        try {
          r = thinWalls(m.triMesh(), min)
        } finally {
          m.delete()
        }
        const how = `sampled ${r.samples} points ${r.spacing} mm apart; approximate`
        if (!r.regions.length) return { ...base, ok: true, detail: `no wall thinner than ${min} mm found${r.thinnest !== undefined ? ` (thinnest ${r.thinnest} mm)` : ''} (${how})` }
        const where = r.regions.slice(0, 3).map((g) => `${g.value} mm in ${box(g.box)}`).join('; ')
        return {
          ...base,
          ok: false,
          detail: `walls thinner than ${min} mm: ${where}${r.regions.length > 3 ? ` and ${r.regions.length - 3} more` : ''} (${how}). Thicken them, or extend an opening to the edge instead of leaving a thin strip`,
        }
      }
    }
  } catch (e) {
    return { ...base, ok: false, detail: `cannot evaluate: ${kernelMessage(e)}` }
  }
  return { ...base, ok: false, detail: 'unknown check kind' }
}
