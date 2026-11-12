// A cross-section as a picture: each body's cut outlines filled (holes stay
// open, even-odd), on a millimetre grid with a scale, so walls, pockets and
// clearances can be seen and read. Runs where there is a canvas (browser
// main thread or worker); the section query falls back to numbers without.

export interface SectionBody {
  name: string
  color?: string
  /** Closed loops in plane coordinates (mm); holes are loops inside loops. */
  loops: [number, number][][]
}

const PALETTE = ['#8a8f98', '#b5651d', '#2f6fb0', '#2e8b57', '#a23b72', '#c49a00', '#5b5ea6', '#c0392b']

/** PNG (base64) of the cut, size px on its long side. */
export async function drawSection(bodies: SectionBody[], axes: [string, string], title: string, size = 900): Promise<string | undefined> {
  if (typeof OffscreenCanvas === 'undefined') return undefined
  const pts = bodies.flatMap((b) => b.loops.flat())
  if (!pts.length) return undefined
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const pad = Math.max(x1 - x0, y1 - y0) * 0.04 + 1
  x0 -= pad
  y0 -= pad
  x1 += pad
  y1 += pad
  const w = x1 - x0
  const h = y1 - y0
  const head = 34
  const legend = 22 * Math.min(bodies.length, 8) + 10
  const scale = (size - 20) / Math.max(w, h)
  const cw = Math.ceil(w * scale) + 20
  const ch = Math.ceil(h * scale) + 20 + head + legend
  const canvas = new OffscreenCanvas(cw, ch)
  const g = canvas.getContext('2d')!
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, cw, ch)
  const X = (x: number) => 10 + (x - x0) * scale
  // v grows up in the picture.
  const Y = (y: number) => head + 10 + (y1 - y) * scale

  // Grid: 1, 5 or 10 mm lines so that they stay a few pixels apart; labels every major line.
  const step = [1, 2, 5, 10, 20, 50, 100].find((s) => s * scale >= 12) ?? 100
  const major = step * 5
  g.lineWidth = 1
  for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
    g.strokeStyle = Math.abs(gx % major) < 1e-9 ? '#d0d4da' : '#eef0f3'
    g.beginPath()
    g.moveTo(X(gx), head + 10)
    g.lineTo(X(gx), head + 10 + h * scale)
    g.stroke()
  }
  for (let gy = Math.ceil(y0 / step) * step; gy <= y1; gy += step) {
    g.strokeStyle = Math.abs(gy % major) < 1e-9 ? '#d0d4da' : '#eef0f3'
    g.beginPath()
    g.moveTo(10, Y(gy))
    g.lineTo(10 + w * scale, Y(gy))
    g.stroke()
  }
  g.fillStyle = '#7a808a'
  g.font = '11px system-ui, sans-serif'
  for (let gx = Math.ceil(x0 / major) * major; gx <= x1; gx += major) g.fillText(String(+gx.toFixed(2)), X(gx) + 2, head + 10 + h * scale - 3)
  for (let gy = Math.ceil(y0 / major) * major; gy <= y1; gy += major) g.fillText(String(+gy.toFixed(2)), 12, Y(gy) - 2)

  bodies.forEach((b, i) => {
    const color = b.color ?? PALETTE[i % PALETTE.length]
    g.beginPath()
    for (const ring of b.loops) {
      ring.forEach(([x, y], k) => (k ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))))
      g.closePath()
    }
    g.globalAlpha = 0.55
    g.fillStyle = color
    g.fill('evenodd')
    g.globalAlpha = 1
    g.strokeStyle = color
    g.lineWidth = 1.2
    g.stroke()
  })

  g.fillStyle = '#222'
  g.font = '15px system-ui, sans-serif'
  g.fillText(title, 10, 22)
  g.font = '12px system-ui, sans-serif'
  g.fillStyle = '#555'
  g.fillText(`${axes[0]} →   ${axes[1]} ↑   grid ${step} mm`, cw - 190, 22)
  bodies.slice(0, 8).forEach((b, i) => {
    const y = head + 20 + h * scale + 10 + i * 22
    g.fillStyle = b.color ?? PALETTE[i % PALETTE.length]
    g.fillRect(10, y, 14, 14)
    g.fillStyle = '#333'
    g.fillText(b.name, 30, y + 12)
  })

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
