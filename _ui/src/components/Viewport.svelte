<script lang="ts">
  import { onDestroy, onMount } from 'svelte'

  import { Eye, Ruler, X } from '@lucide/svelte'

  import { projectAccess } from '../lib/access.svelte'
  import { boardModels } from '../lib/models'
  import { theme } from '../lib/theme.svelte'
  import { type Pick, type SnapKind, Scene3D } from '../lib/scene'
  import type { Session } from '../lib/session.svelte'

  let { session }: { session: Session } = $props()
  const access = projectAccess()

  let canvas: HTMLCanvasElement
  let host: HTMLDivElement
  let scene: Scene3D | undefined
  let hover = $state<Pick>()
  let ro: ResizeObserver | undefined

  /** Ruler: two picked points (snapped to vertices, edge midpoints, arc
   *  centers and edges; Alt picks a free surface point), and the answer. */
  let ruler = $state(false)
  let points = $state<[number, number, number][]>([])
  let snapAt = $state<{ x: number; y: number; kind: SnapKind }>()
  const SNAP_LABEL: Record<SnapKind, string> = { vertex: 'vertex', midpoint: 'midpoint', center: 'center', edge: 'on edge' }
  let label = $state<{ x: number; y: number; text: string }>()
  /** Facts about the selected body. */
  let info = $state<Record<string, unknown>>()

  $effect(() => {
    const name = session.selected
    info = undefined
    if (!name || !session.meshes.some((m) => m.name === name)) return
    let stale = false
    session
      .run('measure', { name })
      .then((r) => {
        if (!stale) info = r as Record<string, unknown>
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  })

  function clearRuler() {
    points = []
    label = undefined
    snapAt = undefined
    scene?.setMeasure([])
    scene?.showSnap(undefined)
  }

  function toggleRuler() {
    ruler = !ruler
    clearRuler()
  }

  function rulerPick(e: PointerEvent): Pick | undefined {
    return e.altKey ? scene?.pick(e.clientX, e.clientY) : scene?.pickSnap(e.clientX, e.clientY)
  }

  async function measurePoint(p: Pick) {
    points = points.length >= 2 ? [p.point] : [...points, p.point]
    scene?.setMeasure(points)
    label = undefined
    if (points.length < 2) return
    const [a, b] = points
    const r = (await session.run('measure_between', { a, b })) as { distance: number; delta: number[] }
    const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
    const at = scene!.toScreen(mid)
    label = { ...at, text: `${r.distance} mm  (Δ ${r.delta.map((v) => Math.abs(v)).join(' × ')})` }
  }

  function onKey(e: KeyboardEvent) {
    if (!session.visible || (e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return
    if (e.key === 'Escape' && ruler) {
      if (points.length) clearRuler()
      else ruler = false
    } else if (e.key === 'm' && !e.ctrlKey && !e.metaKey) toggleRuler()
  }

  onMount(() => {
    scene = new Scene3D(canvas)
    session.renderer = (opts) => scene!.renderViews(opts)
    ro = new ResizeObserver(() => scene?.resize(host.clientWidth, host.clientHeight))
    ro.observe(host)
    scene.resize(host.clientWidth, host.clientHeight)
  })

  onDestroy(() => {
    ro?.disconnect()
    session.renderer = undefined
    scene?.dispose()
  })

  $effect(() => {
    scene?.setMeshes(session.meshes)
  })

  $effect(() => {
    if (scene) scene.paused = !session.visible
  })

  $effect(() => {
    void theme.version
    scene?.applyTheme()
  })

  $effect(() => {
    scene?.setSketches(session.sketchLines)
  })

  $effect(() => {
    const b = session.board?.board
    if (!scene) return
    if (!b) {
      scene.setParts([])
      return
    }
    let stale = false
    void boardModels(b).then((parts) => {
      if (!stale) scene?.setParts(parts)
    })
    return () => {
      stale = true
    }
  })

  $effect(() => {
    scene?.select(session.selected)
  })

  export function frame() {
    scene?.frame()
  }

  let down: { x: number; y: number } | undefined

  function onPointerDown(e: PointerEvent) {
    down = { x: e.clientX, y: e.clientY }
  }

  function onPointerUp(e: PointerEvent) {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
    if (ruler) {
      const p = rulerPick(e)
      if (p) void measurePoint(p)
      return
    }
    session.selected = scene?.pick(e.clientX, e.clientY)?.name
  }

  function onMove(e: PointerEvent) {
    if (e.buttons) return
    if (ruler) {
      hover = rulerPick(e)
      scene?.showSnap(hover)
      const r = canvas.getBoundingClientRect()
      snapAt = hover?.snap ? { x: e.clientX - r.left, y: e.clientY - r.top, kind: hover.snap } : undefined
      return
    }
    hover = scene?.pick(e.clientX, e.clientY)
  }

  // Appearance of the selected body (set_appearance; display only).
  const feature = $derived(session.doc.features.find((f) => f.name === session.selected))
  const SWATCHES = ['#a9aaa2', '#3a3a36', '#f2f2ee', '#c4372f', '#d6a100', '#2f8a56', '#4a7fc9', '#7a4fc9']
  let appearanceError = $state('')

  async function appearance(args: { color?: string | null; opacity?: number | null }) {
    if (!feature) return
    appearanceError = ''
    try {
      await session.run('set_appearance', { names: [feature.name], ...args })
    } catch (e) {
      appearanceError = (e as Error).message
    }
  }

  let opacityTimer: ReturnType<typeof setTimeout> | undefined
  let opacityDraft = $state<number>()
  function onOpacity(v: number) {
    opacityDraft = v
    clearTimeout(opacityTimer)
    // One op per gesture, not one per slider step.
    opacityTimer = setTimeout(() => {
      void appearance({ opacity: v >= 1 ? null : v }).then(() => (opacityDraft = undefined))
    }, 250)
  }

  const empty = $derived(session.doc.features.length === 0 && (session.doc.sketches?.length ?? 0) === 0 && !session.doc.pcb)
</script>

<svelte:window onkeydown={onKey} />

<div bind:this={host} class="absolute inset-0">
  <canvas
    bind:this={canvas}
    class="block size-full"
    onpointerdown={onPointerDown}
    onpointerup={onPointerUp}
    onpointermove={onMove}
    onpointerleave={() => {
      hover = undefined
      snapAt = undefined
      scene?.showSnap(undefined)
    }}
  ></canvas>

  {#if empty}
    <div class="pointer-events-none absolute inset-0 grid place-items-center">
      <div class="pop corners max-w-sm p-4 text-center text-ink-2">
        <div class="mb-1 font-medium text-ink">Empty design</div>
        Ask the assistant, e.g. <em>“Make an enclosure for a 50 × 26 mm board with a USB-C opening on the left.”</em>
      </div>
    </div>
  {/if}

  <div class="absolute top-2 left-2 flex gap-1">
    <button class={['btn px-2', ruler && 'on']} aria-pressed={ruler} onclick={toggleRuler} title="Measure between two points (M)">
      <Ruler size={14} />
      {#if ruler}<span class="text-xs">{points.length === 1 ? 'click the second point' : 'click a point'}</span>{/if}
    </button>
    {#if ruler}
      <span class="self-center border border-line bg-surface/90 px-2 py-0.5 text-[11px] text-ink-2">snaps to corners, midpoints, centers and edges · <kbd>Alt</kbd> free point · <kbd>Esc</kbd> clear</span>
    {/if}
  </div>

  {#if snapAt}
    <div class="pointer-events-none absolute translate-x-3 translate-y-3 border border-line-strong bg-surface px-1.5 py-px text-[11px] text-ink-2" style="left: {snapAt.x}px; top: {snapAt.y}px">
      {SNAP_LABEL[snapAt.kind]}
    </div>
  {/if}

  {#if label}
    <div class="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-sm border border-cta-line bg-cta px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-cta-ink shadow-[var(--shadow-pop)]" style="left: {label.x}px; top: {label.y - 6}px">
      {label.text}
    </div>
  {/if}

  {#if info && !ruler}
    {@const size = info.size as number[]}
    <div class="pop corners absolute top-2 right-2 w-60 p-2.5 text-xs">
      <div class="mb-1 flex items-center">
        <b class="truncate">{info.name}</b>
        <button class="btn btn-ghost ml-auto px-1 py-0" onclick={() => (session.selected = undefined)}><X size={12} /></button>
      </div>
      <div class="num grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink">
        <span class="text-ink-3">size</span><span>{size.join(' × ')} mm</span>
        <span class="text-ink-3">volume</span><span>{info.volume} mm³</span>
        <span class="text-ink-3">area</span><span>{info.area} mm²</span>
        {#if info.center_of_mass}<span class="text-ink-3">center</span><span>[{(info.center_of_mass as number[]).join(', ')}]</span>{/if}
      </div>
      {#if feature && access.canEdit}
        {@const current = feature.color ?? ''}
        {@const op = opacityDraft ?? feature.opacity ?? 1}
        <div class="mt-2.5 border-t border-line pt-2">
          <div class="mb-1.5 flex items-center gap-1 text-ink-3"><Eye size={12} /> Appearance <span class="ml-auto text-[10px]">display only</span></div>
          <div class="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Color">
            {#each SWATCHES as c (c)}
              <button
                role="radio"
                aria-checked={current === c}
                aria-label={c}
                title={c}
                class={['size-5 border', current === c ? 'border-ink ring-2 ring-cta-edge ring-offset-1 ring-offset-surface' : 'border-control']}
                style="background: {c}"
                onclick={() => appearance({ color: c })}
              ></button>
            {/each}
            <label class="relative size-5 cursor-pointer border border-control" title="Pick a color" style="background: conic-gradient(#c4372f, #d6a100, #2f8a56, #4a7fc9, #7a4fc9, #c4372f)">
              <input type="color" class="absolute inset-0 cursor-pointer opacity-0" value={current || '#a9aaa2'} onchange={(e) => appearance({ color: e.currentTarget.value })} aria-label="Custom color" />
            </label>
            {#if current}<button class="btn btn-ghost ml-auto px-1 py-0 text-[11px]" onclick={() => appearance({ color: null })}>reset</button>{/if}
          </div>
          <label class="mt-2 flex items-center gap-2">
            <span class="w-12 text-ink-3">opacity</span>
            <input type="range" min="0.1" max="1" step="0.05" value={op} oninput={(e) => onOpacity(+e.currentTarget.value)} class="h-1 flex-1 accent-[var(--text)]" aria-label="Opacity" />
            <span class="num w-8 text-right font-mono text-[11px]">{Math.round(op * 100)}%</span>
          </label>
          {#if appearanceError}<p class="mt-1 text-danger">{appearanceError}</p>{/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if hover}
    <div class="num pointer-events-none absolute bottom-2 left-2 border border-line bg-surface/90 px-2 py-0.5 font-mono text-[11px] text-ink-2">
      {hover.name}{hover.snap ? ` · ${SNAP_LABEL[hover.snap]}` : hover.face >= 0 ? ` · face ${hover.face}` : ''} · [{hover.point.join(', ')}]
    </div>
  {/if}

  {#if session.error}
    <div class="note danger absolute top-2 left-1/2 -translate-x-1/2 shadow-[var(--shadow-pop)]">
      {session.error}
    </div>
  {/if}
</div>
