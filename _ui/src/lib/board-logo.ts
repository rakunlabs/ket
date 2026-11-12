/** Local-only monochrome conversion. Never uploads the user's logo. */
export async function readBoardLogo(file: File, width: number, threshold = 160, invert = false): Promise<{ rows: string[]; preview: string }> {
  const svg = isSVG(file)
  if (!svg && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP or SVG logo.')
  if (file.size > 5 * 1024 * 1024) throw new Error('The logo is larger than 5 MiB; resize it before importing.')
  // Default to roughly 0.15 mm pixels, not photographic detail that
  // standard silkscreen cannot reproduce. Final DFM remains manual.
  const targetWidth = Math.min(256, Math.max(8, Math.floor((Number.isFinite(width) && width > 0 ? width : 12) / 0.15)))
  const image = svg ? await svgImage(await file.text(), targetWidth) : await createImageBitmap(file)
  try {
    if (image.width > 8192 || image.height > 8192) throw new Error('The logo is larger than 8192 pixels; resize it before importing.')
    const scale = Math.min(targetWidth / image.width, 256 / image.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const rows: string[] = []
    let count = 0
    for (let y = 0; y < canvas.height; y++) {
      let row = ''
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4
        const alpha = pixels.data[i + 3]! / 255
        const light = 0.2126 * pixels.data[i]! + 0.7152 * pixels.data[i + 1]! + 0.0722 * pixels.data[i + 2]!
        const ink = alpha >= 0.5 && (invert ? light >= threshold : light < threshold)
        row += ink ? '#' : '.'
        if (ink) count++
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = ink ? 0 : 255
        pixels.data[i + 3] = 255
      }
      rows.push(row)
    }
    if (!count) throw new Error('No printable pixels. Adjust the threshold or enable Invert.')
    ctx.putImageData(pixels, 0, 0)
    return { rows, preview: canvas.toDataURL('image/png') }
  } finally {
    image.close()
  }
}

function isSVG(file: File): boolean {
  return file.type === 'image/svg+xml' || (!file.type && /\.svg$/i.test(file.name))
}

/**
 * The drawing size of an SVG: width/height in user units (px, or a unit
 * converted to px), else the viewBox. Percentages and missing sizes fall
 * back to the viewBox; without either the SVG cannot be scaled.
 */
export function svgSize(text: string): { width: number; height: number } {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0]
  if (!root) throw new Error('This file is not an SVG image (no <svg> element).')
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1]
  const px: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }
  const length = (v: string | undefined) => {
    const m = v && /^\s*([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(v)
    return m ? Number(m[1]) * px[(m[2] ?? '').toLowerCase()]! : undefined
  }
  const box = attr('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const vb = box?.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 ? { width: box[2]!, height: box[3]! } : undefined
  let w = length(attr('width'))
  let h = length(attr('height'))
  if (w && !h && vb) h = (w * vb.height) / vb.width
  if (h && !w && vb) w = (h * vb.width) / vb.height
  if (w && h) return { width: w, height: h }
  if (vb) return vb
  throw new Error('The SVG has no size: give its <svg> element width and height, or a viewBox.')
}

/**
 * An SVG drawn by the browser through an <img> (no scripts run, nothing
 * external loads), at a resolution with room for the threshold to work on
 * smooth edges.
 */
async function svgImage(text: string, targetWidth: number): Promise<ImageBitmap> {
  const { width, height } = svgSize(text)
  const k = (targetWidth * 4) / width
  const w = Math.max(1, Math.min(4096, Math.round(width * k)))
  const h = Math.max(1, Math.min(4096, Math.round(height * k)))
  // Fix the drawing size so the browser does not fall back to 300 × 150.
  const sized = text.replace(/<svg\b([^>]*)>/i, (_all, attrs: string) => {
    const rest = attrs.replace(/\s(width|height)\s*=\s*["'][^"']*["']/gi, '')
    return `<svg${rest} width="${w}" height="${h}"${/\sviewBox\s*=/i.test(attrs) ? '' : ` viewBox="0 0 ${width} ${height}"`}>`
  })
  const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    try {
      await img.decode()
    } catch {
      throw new Error('The browser could not draw this SVG; save it again as plain SVG, or export a PNG.')
    }
    return await createImageBitmap(img, { resizeWidth: w, resizeHeight: h })
  } finally {
    URL.revokeObjectURL(url)
  }
}
