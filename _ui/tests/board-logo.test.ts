import { describe, expect, it } from 'vitest'

import { svgSize } from '../src/lib/board-logo'

describe('SVG logo size', () => {
  it('reads width and height in px and real units', () => {
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"></svg>')).toEqual({ width: 120, height: 40 })
    const mm = svgSize('<svg width="25.4mm" height="12.7mm"/>')
    expect(mm.width).toBeCloseTo(96)
    expect(mm.height).toBeCloseTo(48)
  })

  it('falls back to the viewBox and keeps its aspect ratio', () => {
    expect(svgSize('<svg viewBox="0 0 200 100"><path d="M0 0h10v10z"/></svg>')).toEqual({ width: 200, height: 100 })
    expect(svgSize('<svg width="100%" height="100%" viewBox="0,0,30,10"/>')).toEqual({ width: 30, height: 10 })
    expect(svgSize('<svg width="60" viewBox="0 0 30 10"/>')).toEqual({ width: 60, height: 20 })
  })

  it('says what is missing', () => {
    expect(() => svgSize('<html></html>')).toThrow(/no <svg> element/)
    expect(() => svgSize('<svg width="100%"/>')).toThrow(/width and height, or a viewBox/)
  })
})
