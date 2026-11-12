// Sizes for mechanical features: metric screws (ISO 273 clearance holes,
// ISO 10642 countersunk and ISO 4762 socket head counterbores, tap drills
// for ISO 261 coarse threads) and common brass heat-set inserts for 3D
// printing. Values are nominal; printers usually want +0.1..0.2 mm on
// holes, which the features expose as clearance parameters.

export interface ScrewSize {
  /** Nominal diameter, mm. */
  d: number
  /** Coarse thread pitch, mm. */
  pitch: number
  /** ISO 273 clearance holes. */
  close: number
  normal: number
  /** Tap drill for the coarse thread. */
  tap: number
  /** Socket head cap screw (ISO 4762) head: diameter and height (counterbore). */
  head_d: number
  head_h: number
  /** Countersunk head (ISO 10642, 90°): head diameter. */
  csk_d: number
}

export const SCREWS: Record<string, ScrewSize> = {
  M2: { d: 2, pitch: 0.4, close: 2.2, normal: 2.4, tap: 1.6, head_d: 3.8, head_h: 2, csk_d: 4.4 },
  'M2.5': { d: 2.5, pitch: 0.45, close: 2.7, normal: 2.9, tap: 2.05, head_d: 4.5, head_h: 2.5, csk_d: 5.5 },
  M3: { d: 3, pitch: 0.5, close: 3.2, normal: 3.4, tap: 2.5, head_d: 5.5, head_h: 3, csk_d: 6.72 },
  M4: { d: 4, pitch: 0.7, close: 4.3, normal: 4.5, tap: 3.3, head_d: 7, head_h: 4, csk_d: 8.96 },
  M5: { d: 5, pitch: 0.8, close: 5.3, normal: 5.5, tap: 4.2, head_d: 8.5, head_h: 5, csk_d: 11.2 },
  M6: { d: 6, pitch: 1, close: 6.4, normal: 6.6, tap: 5, head_d: 10, head_h: 6, csk_d: 13.44 },
}

export interface InsertSize {
  /** Hole to melt the insert into, mm (diameter at the top). */
  hole: number
  /** Insert length; the hole is deeper by a little to take the plastic it pushes down. */
  length: number
  /** Boss wall around the hole that holds it, mm (at least). */
  wall: number
}

/** Common short brass heat-set inserts (e.g. CNC Kitchen / Ruthex M*×L). */
export const INSERTS: Record<string, InsertSize> = {
  M2: { hole: 3.2, length: 3, wall: 1.6 },
  'M2.5': { hole: 3.6, length: 4, wall: 1.8 },
  M3: { hole: 4.0, length: 5.7, wall: 2 },
  M4: { hole: 5.6, length: 8.1, wall: 2.4 },
  M5: { hole: 6.4, length: 9.5, wall: 2.6 },
}

export function screw(size: string, what: string): ScrewSize {
  const s = SCREWS[size]
  if (!s) throw new Error(`${what}: unknown screw size "${size}"; use one of ${Object.keys(SCREWS).join(', ')}, or give d`)
  return s
}

export function insert(size: string, what: string): InsertSize {
  const s = INSERTS[size]
  if (!s) throw new Error(`${what}: unknown insert size "${size}"; use one of ${Object.keys(INSERTS).join(', ')}`)
  return s
}
