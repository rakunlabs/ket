// Loads and caches EasyEDA 3D part models for the viewport and renders.

import type { Footprint } from '../engine/doc'
import type { ResolvedBoard } from '../engine/pcb/board'
import { type ModelMesh, parseOBJ, placeModel } from '../engine/pcb/model3d'
import { base } from './api'

const objs = new Map<string, Promise<ReturnType<typeof parseOBJ> | undefined>>()

function loadOBJ(uuid: string) {
  let p = objs.get(uuid)
  if (!p) {
    p = fetch(`${base}/api/v1/models/${uuid}`)
      .then(async (r) => (r.ok ? parseOBJ(await r.text()) : undefined))
      .catch(() => undefined)
    objs.set(uuid, p)
  }
  return p
}

export interface PlacedModel {
  ref: string
  mesh: ModelMesh
  /** Component transform: position, rotation (deg), side, board top z. */
  at: { x: number; y: number }
  rotation: number
  side: 'top' | 'bottom'
  z: number
}

const placed = new Map<string, ModelMesh | null>()

async function meshFor(fp: Footprint): Promise<ModelMesh | undefined> {
  if (!fp.model) return undefined
  const key = JSON.stringify(fp.model)
  if (placed.has(key)) return placed.get(key) ?? undefined
  const groups = await loadOBJ(fp.model.uuid)
  const mesh = groups ? placeModel(groups, fp.model) : null
  placed.set(key, mesh)
  return mesh ?? undefined
}

/** Models for every part that has one; parts without one are skipped. */
export async function boardModels(b: ResolvedBoard): Promise<PlacedModel[]> {
  const out: PlacedModel[] = []
  await Promise.all(
    b.components.map(async (c) => {
      // The kernel shows the part's own STEP/STL model as part_<ref>.
      if (c.model) return
      const mesh = await meshFor(c.footprint)
      if (!mesh) return
      out.push({ ref: c.ref, mesh, at: c.at, rotation: c.rotation, side: c.side, z: c.side === 'top' ? b.z + b.thickness : b.z })
    }),
  )
  return out
}
