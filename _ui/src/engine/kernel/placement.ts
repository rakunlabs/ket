// Resolving vectors and placing shapes (rotate X, Y, Z about the origin, then translate).

import * as R from 'replicad'
import type { Shape3D } from 'replicad'

import type { Vec3E } from '../doc'
import { num } from '../expr'
import { faceCount } from './shapes'
import type { V3 } from './types'

export function vec(v: Vec3E | undefined, params: Map<string, number>, what: string, fallback: V3 = [0, 0, 0]): V3 {
  if (!v) return fallback
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${what} must be [x, y, z]`)
  return [num(v[0], params, `${what}[0]`), num(v[1], params, `${what}[1]`), num(v[2], params, `${what}[2]`)]
}

export function place(s: Shape3D, f: { translate?: Vec3E; rotate?: Vec3E }, params: Map<string, number>, what: string): Shape3D {
  const [rx, ry, rz] = vec(f.rotate, params, `${what}.rotate`)
  const [tx, ty, tz] = vec(f.translate, params, `${what}.translate`)
  if (!rx && !ry && !rz && !tx && !ty && !tz) return s
  // Big shapes (vendor STEP models with hundreds of faces): move them by
  // location, one transform and no copy of the geometry, instead of a copy
  // per rotate and translate.
  if (faceCount(s, 200) > 200) return moveByLocation(s, [rx, ry, rz], [tx, ty, tz])
  if (rx) s = s.rotate(rx, [0, 0, 0], [1, 0, 0])
  if (ry) s = s.rotate(ry, [0, 0, 0], [0, 1, 0])
  if (rz) s = s.rotate(rz, [0, 0, 0], [0, 0, 1])
  if (tx || ty || tz) s = s.translate(tx, ty, tz)
  return s
}

/** Rotates (X, then Y, then Z, degrees, about the origin) and translates a shape by changing its location only. */
export function moveByLocation(s: Shape3D, r: V3, t: V3): Shape3D {
  const oc = R.getOC()
  const total = new oc.gp_Trsf()
  const step = (fn: (tr: InstanceType<typeof oc.gp_Trsf>) => void) => {
    const tr = new oc.gp_Trsf()
    fn(tr)
    // total = tr ∘ total (apply tr after what came before)
    total.PreMultiply(tr)
    tr.delete()
  }
  const axes: V3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  for (let i = 0; i < 3; i++) {
    if (!r[i]) continue
    step((tr) => {
      const o = new oc.gp_Pnt(0, 0, 0)
      const d = new oc.gp_Dir(axes[i][0], axes[i][1], axes[i][2])
      const ax = new oc.gp_Ax1(o, d)
      tr.SetRotation(ax, (r[i] * Math.PI) / 180)
      ax.delete()
      d.delete()
      o.delete()
    })
  }
  if (t[0] || t[1] || t[2])
    step((tr) => {
      const v = new oc.gp_Vec(t[0], t[1], t[2])
      tr.SetTranslation(v)
      v.delete()
    })
  const loc = new oc.TopLoc_Location(total)
  const moved = R.cast(s.wrapped.Moved(loc, false)) as Shape3D
  loc.delete()
  total.delete()
  s.delete()
  return moved
}
