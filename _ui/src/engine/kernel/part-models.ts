// Vendor part meshes (OBJ) placed on the board and sewn into faces for STEP export.

import * as R from 'replicad'
import type { Shape3D } from 'replicad'

import type { Model3D } from '../doc'
import type { ResolvedBoard } from '../pcb/board'
import { parseOBJ, placeModel } from '../pcb/model3d'

/** A vendor mesh placed on the board, as sewn triangle faces. */
export function meshShape(obj: string, model: Model3D, c: ResolvedBoard['components'][number], b: ResolvedBoard): Shape3D {
  const placed = placeModel(parseOBJ(obj), model)
  const oc = R.getOC()
  const sew = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false)
  const rad = (c.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const bottom = c.side === 'bottom'
  const z0 = bottom ? b.z : b.z + b.thickness
  const tr = (x: number, y: number, z: number): [number, number, number] => {
    if (bottom) {
      x = -x
      z = -z
    }
    return [c.at.x + x * cos - y * sin, c.at.y + x * sin + y * cos, z0 + z]
  }
  let n = 0
  for (const g of placed.groups) {
    const p = g.positions
    for (let i = 0; i + 8 < p.length; i += 9) {
      try {
        const f = R.makePolygon([tr(p[i], p[i + 1], p[i + 2]), tr(p[i + 3], p[i + 4], p[i + 5]), tr(p[i + 6], p[i + 7], p[i + 8])])
        sew.Add(f.wrapped)
        f.delete()
        n++
      } catch {
        // degenerate triangle
      }
    }
  }
  if (!n) {
    sew.delete()
    throw new Error('empty model')
  }
  const progress = new oc.Message_ProgressRange()
  sew.Perform(progress)
  const shape = R.cast(sew.SewedShape()) as Shape3D
  progress.delete()
  sew.delete()
  return shape
}
