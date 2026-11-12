// Board build-up and controlled impedance. Presets follow JLCPCB's published
// standard stackups (values as listed on their impedance calculator page;
// check the current ones before ordering). Impedance uses the closed-form
// IPC-2141 / Wadell approximations: good to a few percent for usual
// geometries, which is enough to choose a width; the manufacturer's field
// solver decides.

import type { LayerCount, Stackup } from '../doc'

export const STACKUP_PRESETS: Record<string, { layers: LayerCount; note: string; stackup: Stackup }> = {
  'jlcpcb-2l-1.6': {
    layers: 2,
    note: 'JLCPCB 2 layers, 1.6 mm FR-4, 1 oz outer',
    stackup: { copper: [35, 35], dielectric: [{ thickness: 1.51, er: 4.5, kind: 'core' }], mask: { thickness: 15, er: 3.8 } },
  },
  'jlcpcb-4l-7628': {
    layers: 4,
    note: 'JLCPCB 4 layers JLC04161H-7628, 1.6 mm (prepreg 7628 0.2104 mm, εr 4.4)',
    stackup: {
      copper: [35, 15.2, 15.2, 35],
      dielectric: [
        { thickness: 0.2104, er: 4.4, kind: 'prepreg' },
        { thickness: 1.065, er: 4.6, kind: 'core' },
        { thickness: 0.2104, er: 4.4, kind: 'prepreg' },
      ],
      mask: { thickness: 15, er: 3.8 },
    },
  },
  'jlcpcb-4l-3313': {
    layers: 4,
    note: 'JLCPCB 4 layers JLC04161H-3313, 1.6 mm (prepreg 3313 0.0994 mm, εr 4.1): thinner prepreg for narrower 50 Ω tracks',
    stackup: {
      copper: [35, 15.2, 15.2, 35],
      dielectric: [
        { thickness: 0.0994, er: 4.1, kind: 'prepreg' },
        { thickness: 1.265, er: 4.6, kind: 'core' },
        { thickness: 0.0994, er: 4.1, kind: 'prepreg' },
      ],
      mask: { thickness: 15, er: 3.8 },
    },
  },
  'jlcpcb-6l-3313': {
    layers: 6,
    note: 'JLCPCB 6 layers JLC06161H-3313, 1.6 mm',
    stackup: {
      copper: [35, 15.2, 15.2, 15.2, 15.2, 35],
      dielectric: [
        { thickness: 0.0994, er: 4.1, kind: 'prepreg' },
        { thickness: 0.55, er: 4.6, kind: 'core' },
        { thickness: 0.1088, er: 4.1, kind: 'prepreg' },
        { thickness: 0.55, er: 4.6, kind: 'core' },
        { thickness: 0.0994, er: 4.1, kind: 'prepreg' },
      ],
      mask: { thickness: 15, er: 3.8 },
    },
  },
}

/** Total thickness of a stackup, mm (copper and dielectrics, mask excluded). */
export function stackupThickness(s: Stackup): number {
  return s.copper.reduce((a, c) => a + c / 1000, 0) + s.dielectric.reduce((a, d) => a + d.thickness, 0)
}

export function checkStackup(s: Stackup, layers: LayerCount): string | undefined {
  if (s.copper.length !== layers) return `the stackup has ${s.copper.length} copper layers, the board ${layers}; give one copper thickness per layer`
  if (s.dielectric.length !== layers - 1) return `a ${layers}-layer stackup needs ${layers - 1} dielectrics (between each pair of copper layers), not ${s.dielectric.length}`
  if (s.copper.some((c) => !(c > 0 && c < 500))) return 'copper thickness is in µm and must be between 0 and 500 (35 µm = 1 oz)'
  if (s.dielectric.some((d) => !(d.thickness > 0 && d.thickness < 5 && d.er >= 1 && d.er < 20))) return 'each dielectric needs thickness > 0 mm and εr ≥ 1'
  return undefined
}

export type Geometry = 'microstrip' | 'stripline' | 'diff_microstrip' | 'diff_stripline'

export interface ImpedanceInput {
  geometry: Geometry
  /** Track width, mm. */
  w: number
  /** Copper thickness, mm. */
  t: number
  /** Height of the track above its reference plane, mm (microstrip), or the plane spacing (stripline: total between planes). */
  h: number
  er: number
  /** Edge-to-edge gap of a differential pair, mm. */
  s?: number
}

/** Characteristic (single-ended) or differential impedance, Ω. */
export function impedance(i: ImpedanceInput): number {
  const { w, t, h, er } = i
  if (i.geometry === 'microstrip' || i.geometry === 'diff_microstrip') {
    // IPC-2141 surface microstrip (valid 0.1 < w/h < 2, 1 < εr < 15).
    const z0 = (87 / Math.sqrt(er + 1.41)) * Math.log((5.98 * h) / (0.8 * w + t))
    if (i.geometry === 'microstrip') return z0
    // IPC-2141 edge-coupled microstrip.
    return 2 * z0 * (1 - 0.48 * Math.exp((-0.96 * (i.s ?? 0)) / h))
  }
  // Symmetric stripline between two planes h apart (IPC-2141).
  const z0 = (60 / Math.sqrt(er)) * Math.log((1.9 * h) / (0.8 * w + t))
  if (i.geometry === 'stripline') return z0
  // IPC-2141 edge-coupled stripline.
  return 2 * z0 * (1 - 0.347 * Math.exp((-2.9 * (i.s ?? 0)) / h))
}

/** The width (mm) that gives target Ω, by bisection on the closed form; undefined when out of reach. */
export function widthFor(target: number, base: Omit<ImpedanceInput, 'w'>): number | undefined {
  // Impedance falls as w grows.
  let lo = 0.02
  let hi = 10
  const f = (w: number) => impedance({ ...base, w })
  if (f(lo) < target || f(hi) > target) return undefined
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2
    if (f(mid) > target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * The geometry of a track on a layer of the stackup: microstrip on an outer
 * layer over the next copper, stripline on an inner one between its
 * neighbours (the planes either side, assumed solid).
 */
export function layerGeometry(s: Stackup, layerIndex: number): { kind: 'microstrip' | 'stripline'; h: number; er: number; t: number; asymmetric?: boolean } {
  const n = s.copper.length
  const t = s.copper[layerIndex] / 1000
  if (layerIndex === 0 || layerIndex === n - 1) {
    const d = s.dielectric[layerIndex === 0 ? 0 : n - 2]
    return { kind: 'microstrip', h: d.thickness, er: d.er, t }
  }
  const above = s.dielectric[layerIndex - 1]
  const below = s.dielectric[layerIndex]
  // Plane to plane: both dielectrics plus the track's copper; εr weighted by thickness.
  const h = above.thickness + below.thickness + t
  const er = (above.er * above.thickness + below.er * below.thickness) / (above.thickness + below.thickness)
  // Very unequal dielectrics either side: the symmetric formula is only a rough guide.
  const asymmetric = Math.abs(above.thickness - below.thickness) > 0.25 * Math.max(above.thickness, below.thickness)
  return { kind: 'stripline', h, er, t, ...(asymmetric ? { asymmetric } : {}) }
}
