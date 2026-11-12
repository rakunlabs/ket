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
    drawBoard(ctx, size.w, size.h, pcb, st, view, { side, ratsnest: true, selected: session.selected, highlight: new Set([...(session.selected ? [session.selected] : []), ...(session.focusTarget?.objects ?? [])]), violations: session.focusTarget?.view === 'pcb' && session.focusTarget.at ? [{ at: session.focusTarget.at }] : [] })
  })

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

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') placing = '' }} />

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
      <button class={['btn py-[3px] text-xs', showAppearance && 'on']} aria-pressed={showAppearance} onclick={() => { showAppearance = !showAppearance; showBom = false; placing = '' }}><Palette size={13} /> Appearance</button>
    </div>
    {#if showAppearance}<BoardArtworkPanel {session} {side} onclose={() => { showAppearance = false; placing = '' }} onplace={(name) => { placing = name; side = session.doc.pcb?.artwork?.find((art) => art.name === name)?.side ?? side; showAppearance = false }} />{/if}
    {#if showBom && session.doc.pcb.components.length}<BomPanel {session} onclose={() => (showBom = false)} />{/if}
    <div class="theme-dark num pointer-events-none absolute bottom-2 left-2 border border-line bg-surface/90 px-2 py-0.5 font-mono text-[11px] text-ink-2">
      {#if placing}<span class="text-ink">Click board to place {placing} · Esc cancels · </span>{/if}
      {#if cursor}[{cursor[0].toFixed(2)}, {cursor[1].toFixed(2)}] ·{/if}
      {#if r}routed {r.routed}/{r.total}{/if}
      · {session.doc.pcb.tracks.length} tracks · {session.doc.pcb.vias.length} vias
    </div>
  {/if}
</div>
