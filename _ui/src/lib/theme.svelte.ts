// Theme: light, dark or the OS's choice, stored per browser. Canvas
// renderers (3D, board, schematic) read their colours from the CSS
// variables in app.css through css(), and redraw when the theme changes.

type Choice = 'auto' | 'light' | 'dark'

const KEY = 'ket.theme'

function stored(): Choice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

const media = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : undefined

class Theme {
  choice = $state<Choice>(stored())
  /** Bumped on every change, so canvas effects can depend on it. */
  version = $state(0)
  private osDark = $state(media?.matches ?? false)

  constructor() {
    this.apply()
    media?.addEventListener('change', (e) => {
      this.osDark = e.matches
      this.version++
    })
  }

  get dark(): boolean {
    return this.choice === 'dark' || (this.choice === 'auto' && this.osDark)
  }

  set(c: Choice) {
    this.choice = c
    try {
      if (c === 'auto') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, c)
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
    this.apply()
    this.version++
  }

  next() {
    this.set(this.choice === 'auto' ? 'dark' : this.choice === 'dark' ? 'light' : 'auto')
  }

  private apply() {
    if (typeof document === 'undefined') return
    if (this.choice === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = this.choice
  }
}

export const theme = new Theme()

/** A CSS custom property's current value on :root, e.g. css('--view-bg'). */
export function css(name: string, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name).trim()
}

/** A CSS colour as a 0xRRGGBB number for three.js. */
export function hex(name: string): number {
  const v = css(name)
  const m = /^#([0-9a-f]{6})$/i.exec(v)
  if (m) return parseInt(m[1], 16)
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.fillStyle = v
  return parseInt(ctx.fillStyle.slice(1), 16) || 0
}
