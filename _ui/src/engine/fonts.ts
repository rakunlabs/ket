// Fonts for text features. Text outlines become geometry, so the same font
// must be loaded wherever the kernel runs (worker, tests): the worker loads
// the bundled files by URL, tests read them from disk.

import * as R from 'replicad'

import type { FontName } from './doc'

export const FONT_FILES: Record<FontName, string> = {
  regular: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff',
  bold: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff',
}

const loaded = new Map<FontName, { capHeight: number }>()

export async function registerFont(name: FontName, data: ArrayBuffer) {
  const font = await R.loadFont(data, name, true)
  const os2 = font.tables.os2 as { sCapHeight?: number } | undefined
  loaded.set(name, { capHeight: (os2?.sCapHeight || font.unitsPerEm * 0.7) / font.unitsPerEm })
}

/** Cap height as a fraction of the font size, or undefined when not loaded. */
export function fontMetrics(name: FontName): { capHeight: number } | undefined {
  return loaded.get(name)
}
