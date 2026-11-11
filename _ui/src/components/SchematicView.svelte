<script lang="ts">
  import { onMount } from 'svelte'

  import { type SchSymbol, route, schematic } from '../engine/pcb/schematic'
  import { projectAccess } from '../lib/access.svelte'
  import { type SchView, drawSchematic, fitSch, renderSchematicPNG, themeSch } from '../lib/sch-draw'
  import { css, theme } from '../lib/theme.svelte'
  import type { Session } from '../lib/session.svelte'

  let { session }: { session: Session } = $props()
  const access = projectAccess()

  let canvas = $state<HTMLCanvasElement>()
  let host: HTMLDivElement
  let size = $state({ w: 0, h: 0 })
  let view = $state<SchView>()

  const sch = $derived(session.doc.pcb ? schematic(session.doc.pcb) : undefined)
  const editable = $derived(access.canEdit)

  /** A wire being drawn: from a pin to the pointer. */
  let wire = $state<{ ref: string; pin: string; x: number; y: number; dir: number; to: { x: number; y: number; dir?: number }; points: [number, number][] }>()
  /** The selected wire, "A|B". */
  let pickedWire = $state<string>()
  /** A symbol being dragged, with its live offset. */
  let moving = $state<{ ref: string; dx: number; dy: number }>()
  let hover = $state<{ ref: string; pin: string }>()
  let error = $state('')

  function toSch(e: { clientX: number; clientY: number }) {
    const r = canvas!.getBoundingClientRect()
    return { x: (e.clientX - r.left - view!.ox) / view!.scale, y: (e.clientY - r.top - view!.oy) / view!.scale }
  }

  function pinAt(x: number, y: number) {
    if (!sch || !view) return undefined
    const tol = Math.max(3, 6 / view.scale)
    for (const s of sch.symbols) {
      for (const p of s.def.pins) {
        if (Math.hypot(s.x + p.x - x, s.y + p.y - y) <= tol) return { s, ref: s.ref, pin: p.number, x: s.x + p.x, y: s.y + p.y, dir: p.dir }
      }
    }
    return undefined
  }

  function symbolAt(x: number, y: number): SchSymbol | undefined {
    return sch?.symbols.find(
      (s) =>
        s.def.rects.some(([rx, ry, rw, rh]) => x >= s.x + rx && x <= s.x + rx + rw && y >= s.y + ry && y <= s.y + ry + rh) ||
        (s.def.lines ?? []).some((l) => {
          const xs = l.filter((_, i) => i % 2 === 0)
          const ys = l.filter((_, i) => i % 2 === 1)
          return x >= s.x + Math.min(...xs) - 2 && x <= s.x + Math.max(...xs) + 2 && y >= s.y + Math.min(...ys) - 2 && y <= s.y + Math.max(...ys) + 2
        }),
    )
  }

  async function act(cmd: string, args: unknown) {
    error = ''
    try {
      await session.run(cmd, args)
    } catch (e) {
      error = (e as Error).message
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!session.visible || (e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return
    if (e.key === 'Escape') {
      wire = undefined
      pickedWire = undefined
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && pickedWire && editable) {
      const [a, b] = pickedWire.split('|')
      pickedWire = undefined
      void act('remove_wires', { wires: [[a, b]] })
    }
  }

  const snap10 = (v: number) => Math.round(v / 10) * 10


  function wireAt(x: number, y: number) {
    if (!sch || !view) return undefined
    const tol = Math.max(2, 5 / view.scale)
    for (const w of sch.wires) {
      for (let i = 0; i + 1 < w.path.length; i++) {
        const [ax, ay] = w.path[i]
        const [bx, by] = w.path[i + 1]
        const l2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2))
        if (Math.hypot(ax + t * (bx - ax) - x, ay + t * (by - ay) - y) <= tol) return w
      }
    }
    return undefined
  }

  onMount(() => {
    session.schematicRenderer = async (px) => {
      if (!session.doc.pcb) throw new Error('no board yet')
      return { images: [{ mime: 'image/png', data: renderSchematicPNG(schematic(session.doc.pcb), px) }] }
    }
    const ro = new ResizeObserver(() => (size = { w: host.clientWidth, h: host.clientHeight }))
    ro.observe(host)
    return () => ro.disconnect()
  })

  export function frame() {
    if (sch) view = fitSch(sch, size.w, size.h)
  }

  // Refit when the drawing grows or shrinks (parts added or removed).
  let fitted = ''
  $effect(() => {
    void theme.version
    themeSch()
    if (!canvas || !sch || !size.w) return
    const key = `${sch.symbols.length}:${sch.width}x${sch.height}:${size.w}x${size.h}`
    if (key !== fitted) {
      fitted = key
      view = fitSch(sch, size.w, size.h)
    }
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    if (!view) view = fitSch(sch, size.w, size.h)
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const shown = moving ? { ...sch, symbols: sch.symbols.map((x) => (x.ref === moving!.ref ? { ...x, x: x.x + moving!.dx, y: x.y + moving!.dy } : x)) } : sch
    const hl = new Set<string>(session.selected ? [session.selected] : [])
    if (pickedWire) hl.add(pickedWire)
    drawSchematic(ctx, size.w, size.h, shown, view, hl)
    const X = (x: number) => view!.ox + x * view!.scale
    const Y = (y: number) => view!.oy + y * view!.scale
    if (hover && editable) {
      const sym = shown.symbols.find((x) => x.ref === hover!.ref)
      const pin = sym?.def.pins.find((p) => p.number === hover!.pin)
      if (sym && pin) {
        ctx.strokeStyle = css('--sch-hl')
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(X(sym.x + pin.x), Y(sym.y + pin.y), Math.max(4, 3 * view.scale), 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    if (wire) {
      // Orthogonal rubber band: horizontal, then vertical.
      ctx.strokeStyle = css('--sch-net')
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 3])
      // Same routing as the stored wire; a free end points back at the last point.
      const last = wire.points.at(-1) ?? [wire.x, wire.y]
      const toDir = wire.to.dir ?? (Math.abs(wire.to.x - last[0]) >= Math.abs(wire.to.y - last[1]) ? (wire.to.x > last[0] ? 180 : 0) : wire.to.y > last[1] ? 90 : 270)
      const path = route({ x: wire.x, y: wire.y, dir: wire.dir }, { x: snap10(wire.to.x), y: snap10(wire.to.y), dir: toDir }, wire.points)
      ctx.beginPath()
      path.forEach(([px, py], i) => (i ? ctx.lineTo(X(px), Y(py)) : ctx.moveTo(X(px), Y(py))))
      ctx.stroke()
      ctx.setLineDash([])
    }
  })

  function onWheel(e: WheelEvent) {
    if (!view) return
    e.preventDefault()
    const r = canvas!.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    const k = Math.exp(-e.deltaY * 0.0015)
    const scale = Math.min(40, Math.max(0.2, view.scale * k))
    view = { scale, ox: px - ((px - view.ox) * scale) / view.scale, oy: py - ((py - view.oy) * scale) / view.scale }
  }

  let drag: { x: number; y: number; v: SchView; moved: boolean; symbol?: SchSymbol } | undefined

  function onDown(e: PointerEvent) {
    if (!view) return
    const at = toSch(e)
    // Pins are handled on release (click); a body drag moves the symbol.
    const sym = editable && !pinAt(at.x, at.y) ? symbolAt(at.x, at.y) : undefined
    drag = { x: e.clientX, y: e.clientY, v: view, moved: false, symbol: sym }
    canvas!.setPointerCapture(e.pointerId)
  }

  function onMove(e: PointerEvent) {
    const at = view ? toSch(e) : undefined
    if (at) {
      const p = pinAt(at.x, at.y)
      hover = p ? { ref: p.ref, pin: p.pin } : undefined
      if (wire) wire = { ...wire, to: p ? { x: p.x, y: p.y, dir: p.dir } : at }
    }
    if (!drag) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    if (Math.hypot(dx, dy) > 3) drag.moved = true
    if (drag.symbol && drag.moved) {
      const k = view!.scale
      moving = { ref: drag.symbol.ref, dx: Math.round(dx / k / 10) * 10, dy: Math.round(dy / k / 10) * 10 }
    } else if (!drag.symbol) view = { ...drag.v, ox: drag.v.ox + dx, oy: drag.v.oy + dy }
  }

  async function onUp(e: PointerEvent) {
    const d = drag
    drag = undefined
    if (!d || !sch || !view) return
    if (d.symbol && moving) {
      const m = moving
      const s = d.symbol
      await act('place_symbol', { moves: [{ ref: s.ref, at: [s.x + m.dx, s.y + m.dy] }] })
      moving = undefined
      return
    }
    moving = undefined
    if (d.moved) return
    const at = toSch(e)
    const pin = pinAt(at.x, at.y)
    if (pin && editable) {
      const id = `${pin.ref}.${pin.pin}`
      if (e.shiftKey) {
        wire = undefined
        if (pin.s.nets[pin.pin]) await act('disconnect', { pins: [id] })
        return
      }
      if (!wire) {
        pickedWire = undefined
        wire = { ref: pin.ref, pin: pin.pin, x: pin.x, y: pin.y, dir: pin.dir, to: { x: pin.x, y: pin.y }, points: [] }
        return
      }
      const from = `${wire.ref}.${wire.pin}`
      const points = wire.points
      wire = undefined
      if (from !== id) await act('wire_pins', { pins: [from, id], ...(points.length ? { points } : {}) })
      return
    }
    if (wire && editable) {
      // A click on empty space while wiring adds a bend point.
      wire = { ...wire, points: [...wire.points, [snap10(at.x), snap10(at.y)]] }
      return
    }
    const w = wireAt(at.x, at.y)
    pickedWire = w ? `${w.a}|${w.b}` : undefined
    session.selected = w ? undefined : symbolAt(at.x, at.y)?.ref
  }
</script>

<svelte:window onkeydown={onKey} />

<div bind:this={host} class="absolute inset-0 bg-[var(--sch-bg)]">
  {#if !sch || sch.symbols.length === 0}
    <div class="grid h-full place-items-center text-ink-2">
      <div class="max-w-sm text-center">No parts yet. The schematic is drawn from the board's parts and nets.</div>
    </div>
  {:else}
    <canvas
      bind:this={canvas}
      class={['block size-full', hover && editable ? 'cursor-crosshair' : moving ? 'cursor-grabbing' : '']}
      style="width: {size.w}px; height: {size.h}px"
      onwheel={onWheel}
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={onUp}
    ></canvas>
    <div class="pointer-events-none absolute right-2 bottom-2 left-2 w-fit max-w-[calc(100%-1rem)] border border-line bg-surface/90 px-2 py-0.5 text-[11px] text-ink-2">
      {sch.symbols.length} parts · {session.doc.pcb?.nets.length ?? 0} nets · labels join pins of the same net
      {#if editable}· click a pin, (click to bend,) click another pin to wire · click a wire then Delete to remove it · shift-click a pin to disconnect · drag a part to move it{/if}
    </div>
    {#if wire}
      <div class="pop pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 px-2 py-1 text-xs">
        Wiring from <b>{wire.ref}.{wire.pin}</b>: click another pin, or empty space to bend (Esc cancels)
      </div>
    {/if}
    {#if pickedWire}
      <div class="pop pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 px-2 py-1 text-xs">
        Wire <b>{pickedWire.replace('|', ' — ')}</b>: Delete removes it
      </div>
    {/if}
    {#if error}
      <div class="note danger absolute top-2 right-2 max-w-md py-1 text-xs">{error}</div>
    {/if}
  {/if}
</div>
