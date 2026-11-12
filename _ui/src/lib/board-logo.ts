/** Local-only monochrome conversion. Never uploads the user's logo. */
export async function readBoardLogo(file: File, width: number, threshold = 160, invert = false): Promise<{ rows: string[]; preview: string }> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP logo. SVG is not supported yet.')
  if (file.size > 5 * 1024 * 1024) throw new Error('The logo is larger than 5 MiB; resize it before importing.')
  const image = await createImageBitmap(file)
  try {
    if (image.width > 8192 || image.height > 8192) throw new Error('The logo is larger than 8192 pixels; resize it before importing.')
    // Default to roughly 0.15 mm pixels, not photographic detail that
    // standard silkscreen cannot reproduce. Final DFM remains manual.
    const targetWidth = Math.min(256, Math.max(8, Math.floor((Number.isFinite(width) && width > 0 ? width : 12) / 0.15)))
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
