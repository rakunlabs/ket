import { describe, expect, it } from 'vitest'

import { area, offset, stroke } from '../src/engine/pcb/poly'

describe('poly', () => {
  it('offsets like a Minkowski sum with a disk', () => {
    const sq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
    const g = offset([sq], 0.2)
    expect(g).toHaveLength(1)
    // 1 + perimeter·r + πr² (circumscribed disks are a hair larger).
    expect(area(g[0])).toBeGreaterThanOrEqual(1 + 4 * 0.2 + Math.PI * 0.04 - 1e-6)
    expect(area(g[0])).toBeLessThan(1 + 4 * 0.2 + Math.PI * 0.04 + 0.01)
    const s = offset([sq], -0.2)
    expect(area(s[0])).toBeCloseTo(0.36, 6)
  })

  it('strokes a polyline with round ends', () => {
    const t = stroke([{ x: 0, y: 0 }, { x: 10, y: 0 }], 0.5)
    expect(area(t[0])).toBeGreaterThanOrEqual(10 * 0.5 + Math.PI * 0.0625 - 1e-6)
    expect(area(t[0])).toBeLessThan(10 * 0.5 + Math.PI * 0.0625 + 0.01)
  })
})
