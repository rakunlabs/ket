<script lang="ts">
  let showBom = $state(false)
  import { onDestroy, onMount, untrack } from 'svelte'
  import { Palette } from '@lucide/svelte'

  import { type View, drawBoard, fitView, renderBoardPNG, toBoard } from '../lib/board-draw'
  import type { Session } from '../lib/session.svelte'
  import BomPanel from './BomPanel.svelte'
  import BoardArtworkPanel from './BoardArtworkPanel.svelte'
  import { projectAccess } from '../lib/access.svelte'
  import { toasts } from '../lib/toasts'

  let { session }: { session: Session } = $props()

  let canvas = $state<HTMLCanvasElement>()!
  let host: HTMLDivElement
  let view = $state<View>()
  let side = $state<'top' | 'bottom'>('top')
  let cursor = $state<[number, number]>()
  let size = $state({ w: 0, h: 0 })
  let ro: ResizeObserver | undefined
  let showAppearance = $state(false)
  let placing = $state('')
  const access = projectAccess()

  // Interactive routing: click a pad to start, click to add legs (each planned around
  // obstacles by route_leg), V for a via and the other layer, double-click or Enter to
  // commit as one batch, Esc to drop it. Nothing is saved until it is committed.
  type Leg = { layer: string; points: [number, number][] }
  let routing = $state(false)
  let wire = $state<{ net: string; layer: string; width: number; legs: Leg[]; vias: [number, number][]; at: [number, number]; busy: boolean; note?: string }>()
  let preview = $state<Leg>()
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  const layers = $derived(session.doc.pcb ? (session.doc.pcb.layers === 6 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'B.Cu'] : session.doc.pcb.layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu']) : [])

  function padAt(x: number, y: number) {
    const st = session.board
    if (!st) return undefined
    const inside = (poly: { x: number; y: number }[]) => {
      let ok = false
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [a, c] = [poly[i], poly[j]]
        if (a.y > y !== c.y > y && x < ((c.x - a.x) * (y - a.y)) / (c.y - a.y) + a.x) ok = !ok
      }
      return ok
    }
    const want = side === 'bottom' ? 'B.Cu' : 'F.Cu'
    return st.board.pads.find((p) => p.net && inside(p.outline) && p.layers.includes(want)) ?? st.board.pads.find((p) => p.net && inside(p.outline))
  }

  async function plan(to: [number, number]): Promise<Leg | undefined> {
    if (!wire) return undefined
    const r = (await session.run('route_leg', { net: wire.net, layer: wire.layer, a: wire.at, b: to, width: wire.width })) as { ok: boolean; points?: [number, number][]; note?: string }
    if (!r.ok || !r.points) {
      wire.note = r.note
      return undefined
    }
    wire.note = undefined
    return { layer: wire.layer, points: r.points }
  }

  function schedulePreview(to: [number, number]) {
    clearTimeout(previewTimer)
    if (!wire || wire.busy) return
    previewTimer = setTimeout(async () => {
      const leg = await plan(to).catch(() => undefined)
      if (wire) preview = leg
    }, 120)
  }

  async function routeClick(at: [number, number]) {
    if (!session.doc.pcb) return
    if (!wire) {
      const pad = padAt(at[0], at[1])
      if (!pad?.net) return toasts.show('Start on a pad that has a net', 'error')
      const layer = pad.layers.includes(side === 'bottom' ? 'B.Cu' : 'F.Cu') ? (side === 'bottom' ? 'B.Cu' : 'F.Cu') : pad.layers[0]
      const cls = session.doc.pcb.classes.find((c) => c.name === session.doc.pcb!.nets.find((n) => n.name === pad.net)?.class)
      wire = { net: pad.net, layer, width: cls?.track ?? 0.25, legs: [], vias: [], at: [pad.center.x, pad.center.y], busy: false }
      return
    }
    // Ending on a pad of the net: snap to its centre and finish.
    const pad = padAt(at[0], at[1])
    const end: [number, number] = pad && pad.net === wire.net ? [pad.center.x, pad.center.y] : at
    wire.busy = true
    const leg = await plan(end).catch((e) => (toasts.show((e as Error).message, 'error'), undefined))
    if (!wire) return
    wire.busy = false
    if (!leg) return
    wire.legs = [...wire.legs, leg]
    wire.at = leg.points[leg.points.length - 1]
    preview = undefined
    if (pad && pad.net === wire.net) await commit()
  }

  function addVia() {
    if (!wire) return
    // A through via: on to the opposite outer layer (from an inner layer, back to the top). Pick an inner layer from the list.
    const bottom = layers[layers.length - 1]
    wire.vias = [...wire.vias, wire.at]
    wire.layer = wire.layer === 'F.Cu' ? bottom : 'F.Cu'
    preview = undefined
  }

  async function commit() {
    const w = wire
    wire = undefined
    preview = undefined
    if (!w || !w.legs.length) return
    // Consecutive legs on one layer join into one track.
    const tracks: Leg[] = []
    for (const l of w.legs) {
      const last = tracks[tracks.length - 1]
      if (last && last.layer === l.layer) last.points = [...last.points, ...l.points.slice(1)]
      else tracks.push({ layer: l.layer, points: [...l.points] })
    }
    const steps = [
      ...tracks.map((t) => ({ cmd: 'add_track', args: { net: w.net, layer: t.layer, width: w.width, points: t.points } })),
      ...w.vias.map((at) => ({ cmd: 'add_via', args: { net: w.net, at } })),
    ]
    try {
      await session.run('batch', { steps })
    } catch (e) {
      toasts.show((e as Error).message, 'error')
    }
  }

  function cancelRoute() {
    wire = undefined
    preview = undefined
    clearTimeout(previewTimer)
  }

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')) return
    if (e.key === 'Escape') {
      placing = ''
      if (wire) cancelRoute()
      else routing = false
      return
    }
    if (!access.canEdit || !session.doc.pcb) return
    if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      routing = !routing
      cancelRoute()
    } else if (routing && wire && (e.key === 'v' || e.key === 'V')) addVia()
    else if (routing && wire && e.key === 'Enter') void commit()
    else if (routing && wire && e.key === 'Backspace') {
      const legs = wire.legs.slice(0, -1)
      wire.legs = legs
      wire.at = legs.length ? legs[legs.length - 1].points[legs[legs.length - 1].points.length - 1] : wire.at
      e.preventDefault()
    }
  }
  $effect(() => {
    const target = session.focusTarget
    if (target?.view !== 'pcb') return
    if (target.side) side = target.side
    if (target.at) view = { scale: Math.max(untrack(() => view?.scale) ?? 10, 20), cx: target.at[0], cy: target.at[1] }
  })

  onMount(() => {
    ro = new ResizeObserver(() => {
      size = { w: host.clientWidth, h: host.clientHeight }
    })
    ro.observe(host)
    session.boardRenderer = async (o) => {
      const st = await session.boardForRender(true)
      if (!st || !session.doc.pcb) throw new Error('no board yet')
      const data = await renderBoardPNG(session.doc.pcb, st, o.size, {
        side: o.side,
        ratsnest: o.ratsnest,
        highlight: new Set(o.highlight ?? []),
        violations: o.violations,
      })
      return { images: [{ mime: 'image/png', data }] }
    }
  })

  onDestroy(() => {
    ro?.disconnect()
  })

  export function frame() {
    if (session.board) view = fitView(session.board, size.w, size.h)
  }

  $effect(() => {
    const st = session.board
    const pcb = session.doc.pcb
    if (!canvas || !st || !pcb || !size.w) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    if (!view) view = fitView(st, size.w, size.h)
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawBoard(ctx, size.w, size.h, pcb, st, view, { side, ratsnest: true, selected: session.selected, highlight: new Set([...(session.selected ? [session.selected] : []), ...(session.focusTarget?.objects ?? []), ...(wire ? [wire.net] : [])]), violations: session.focusTarget?.view === 'pcb' && session.focusTarget.at ? [{ at: session.focusTarget.at }] : [] })
    if (wire) drawWire(ctx, view)
  })

  function drawWire(ctx: CanvasRenderingContext2D, v: View) {
    if (!wire) return
    const flip = side === 'bottom' ? -1 : 1
    const X = (x: number) => size.w / 2 + (x - v.cx) * v.scale * flip
    const Y = (y: number) => size.h / 2 - (y - v.cy) * v.scale
    const stroke = (l: Leg, dash: boolean) => {
      ctx.strokeStyle = l.layer === 'F.Cu' ? 'rgba(232, 160, 60, 0.95)' : l.layer === 'B.Cu' ? 'rgba(90, 150, 230, 0.95)' : 'rgba(120, 200, 120, 0.95)'
      ctx.lineWidth = Math.max(1.5, wire!.width * v.scale)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.setLineDash(dash ? [6, 4] : [])
      ctx.beginPath()
      l.points.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))))
      ctx.stroke()
      ctx.setLineDash([])
    }
    for (const l of wire.legs) stroke(l, false)
    if (preview) stroke(preview, true)
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    for (const [x, y] of wire.vias) {
      ctx.beginPath()
      ctx.arc(X(x), Y(y), Math.max(3, 0.3 * v.scale), 0, Math.PI * 2)
      ctx.fill()
    }
  }

  function onWheel(e: WheelEvent) {
    if (!view) return
    e.preventDefault()
    const r = canvas.getBoundingClientRect()
    const [bx, by] = toBoard(view, size.w, size.h, e.clientX - r.left, e.clientY - r.top, side)
    const k = Math.exp(-e.deltaY * 0.0015)
    const scale = Math.min(400, Math.max(1, view.scale * k))
    // Keep the point under the cursor fixed.
    const flip = side === 'bottom' ? -1 : 1
    view = { scale, cx: bx - ((e.clientX - r.left - size.w / 2) / scale) * flip, cy: by + (e.clientY - r.top - size.h / 2) / scale }
  }

  let drag: { x: number; y: number; v: View; moved: boolean } | undefined

  function onDown(e: PointerEvent) {
    if (!view) return
    drag = { x: e.clientX, y: e.clientY, v: view, moved: false }
    canvas.setPointerCapture(e.pointerId)
  }

  function onMove(e: PointerEvent) {
    const r = canvas.getBoundingClientRect()
    if (view) cursor = toBoard(view, size.w, size.h, e.clientX - r.left, e.clientY - r.top, side)
    if (routing && wire && cursor && !drag?.moved) schedulePreview(cursor)
    if (!drag) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    if (Math.hypot(dx, dy) > 3) drag.moved = true
    const flip = side === 'bottom' ? -1 : 1
    view = { ...drag.v, cx: drag.v.cx - (dx / drag.v.scale) * flip, cy: drag.v.cy + dy / drag.v.scale }
  }

  function onUp(e: PointerEvent) {
    if (drag && !drag.moved && placing && view && access.canEdit) {
      const r = canvas.getBoundingClientRect()
      const at = toBoard(view, size.w, size.h, e.clientX - r.left, e.clientY - r.top, side)
      void session.run('update_board_artwork', { name: placing, at }).catch((error) => toasts.show((error as Error).message, 'error'))
      placing = ''
      drag = undefined
      canvas.releasePointerCapture(e.pointerId)
      return
    }
    if (drag && !drag.moved && routing && cursor && access.canEdit) {
      drag = undefined
      canvas.releasePointerCapture(e.pointerId)
      if (e.detail >= 2 && wire) void commit()
      else void routeClick(cursor)
      return
    }
    if (drag && !drag.moved && cursor && session.board) {
      const [x, y] = cursor
      const hit = session.board.board.components.find((c) => {
        const xs = c.courtyard.map((p) => p.x)
        const ys = c.courtyard.map((p) => p.y)
        return c.side === side && x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys)
      })
      session.selected = hit?.ref
    }
    drag = undefined
    canvas.releasePointerCapture(e.pointerId)
  }

  const r = $derived(session.board?.ratsnest)
</script>

<svelte:window onkeydown={onKey} />

<div bind:this={host} class="absolute inset-0 bg-[var(--board-bg)]">
  {#if !session.doc.pcb}
    <div class="theme-dark grid h-full place-items-center bg-transparent text-ink-3">
      <div class="max-w-sm text-center">
        <div class="mb-1 font-medium text-ink">No board yet</div>
        Ask the assistant, e.g. <em>“Make a 40 × 25 mm board with USB-C power and a 3.3 V LDO.”</em>
      </div>
    </div>
  {:else}
    <canvas
      bind:this={canvas}
      class="block size-full cursor-crosshair"
      style="width: {size.w}px; height: {size.h}px"
      onwheel={onWheel}
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={onUp}
    ></canvas>
    <div class="theme-dark absolute top-2 left-2 flex gap-2 bg-transparent">
      <div class="seg" role="radiogroup" aria-label="Side">
        {#each ['top', 'bottom'] as const as s (s)}
          <button role="radio" aria-checked={side === s} onclick={() => (side = s)}>{s}</button>
        {/each}
      </div>
      {#if session.doc.pcb.components.length}
        <button class={['btn py-[3px] text-xs', showBom && 'on']} aria-pressed={showBom} onclick={() => { showBom = !showBom; showAppearance = false }}>BOM</button>
      {/if}
      {#if access.canEdit && session.doc.pcb.nets.length}
        <button class={['btn py-[3px] text-xs', routing && 'on']} aria-pressed={routing} title="Route by hand (R): click a pad, click on, V for a via, double-click or Enter to finish, Esc cancels" onclick={() => { routing = !routing; cancelRoute() }}>Route</button>
        {#if routing}
          <select class="input py-[2px] text-xs" aria-label="Routing layer" value={wire?.layer ?? (side === 'bottom' ? 'B.Cu' : 'F.Cu')} onchange={(e) => { if (wire) { wire.layer = e.currentTarget.value; preview = undefined } }}>
            {#each layers as l (l)}<option value={l}>{l}</option>{/each}
          </select>
        {/if}
      {/if}
      <button class={['btn py-[3px] text-xs', showAppearance && 'on']} aria-pressed={showAppearance} onclick={() => { showAppearance = !showAppearance; showBom = false; placing = '' }}><Palette size={13} /> Appearance</button>
    </div>
    {#if showAppearance}<BoardArtworkPanel {session} {side} onclose={() => { showAppearance = false; placing = '' }} onplace={(name) => { placing = name; side = session.doc.pcb?.artwork?.find((art) => art.name === name)?.side ?? side; showAppearance = false }} />{/if}
    {#if showBom && session.doc.pcb.components.length}<BomPanel {session} onclose={() => (showBom = false)} />{/if}
    <div class="theme-dark num pointer-events-none absolute bottom-2 left-2 border border-line bg-surface/90 px-2 py-0.5 font-mono text-[11px] text-ink-2">
      {#if placing}<span class="text-ink">Click board to place {placing} · Esc cancels · </span>{/if}
      {#if routing}<span class="text-ink">{wire ? `Routing ${wire.net} on ${wire.layer}${wire.legs.length ? ` · ${wire.legs.length} leg(s)` : ''} · V via · Enter or double-click finishes · Backspace undoes a leg · Esc drops` : 'Route: click a pad to start · Esc leaves'}{wire?.note ? ` · ${wire.note}` : ''} · </span>{/if}
      {#if cursor}[{cursor[0].toFixed(2)}, {cursor[1].toFixed(2)}] ·{/if}
      {#if r}routed {r.routed}/{r.total}{/if}
      · {session.doc.pcb.tracks.length} tracks · {session.doc.pcb.vias.length} vias
    </div>
  {/if}
</div>
