<script lang="ts">
  import { onDestroy, onMount } from 'svelte'

  import { Box, Eye, Focus, LoaderCircle, Move3d, Pause, Play, RotateCcw, Ruler, Scan, Sparkles, Square, X } from '@lucide/svelte'

  import { projectAccess } from '../lib/access.svelte'
  import { boardModels } from '../lib/models'
  import { Player } from '../lib/player.svelte'
  import { theme } from '../lib/theme.svelte'
  import { type Pick, type Shading, type SnapKind, Scene3D } from '../lib/scene'
  import type { Session } from '../lib/session.svelte'

  let { session }: { session: Session } = $props()
  const access = projectAccess()

  const SHADING_KEY = 'ket.shading'
  const SHADINGS: { id: Shading; label: string; title: string; icon: typeof Box }[] = [
    { id: 'normal', label: 'Normal', title: 'CAD view: plain colors and edges (Alt+1)', icon: Box },
    { id: 'realistic', label: 'Realistic', title: 'Materials, decals and reflections as the product looks (Alt+2)', icon: Sparkles },
    { id: 'wireframe', label: 'Wire', title: 'Edges only (Alt+3)', icon: Scan },
    { id: 'xray', label: 'X-ray', title: 'See-through bodies, to look inside (Alt+4)', icon: Eye },
  ]
  function savedShading(): Shading {
    try {
      const v = localStorage.getItem(SHADING_KEY)
      if (v && SHADINGS.some((s) => s.id === v)) return v as Shading
    } catch {
      // Storage blocked.
    }
    return 'normal'
  }
  let shading = $state<Shading>(savedShading())
  function setShading(s: Shading) {
    shading = s
    try {
      localStorage.setItem(SHADING_KEY, s)
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
  }
  $effect(() => {
    scene?.setShading(shading)
  })

  // Playback (display only): poses meshes; the document changes only on "keep".
  const player = new Player((p) => scene?.setPoses(p))
  const SPEEDS = [0.25, 0.5, 1, 2, 4]
  async function play() {
    if (player.paused) return player.resume()
    try {
      const plan = (await session.run('get_motion', {})) as import('../engine/motion').MotionPlan
      await player.start(plan, session.meshes)
    } catch (e) {
      player.error = (e as Error).message
    }
  }
  async function keep() {
    const name = player.param
    const v = Math.round(player.value * 1000) / 1000
    player.reset()
    if (name && access.canEdit) await session.run('set_parameters', { parameters: [{ name, expr: v }] })
  }
  // A rebuild invalidates the poses: stop.
  $effect(() => {
    void session.meshes
    player.reset()
  })
  onDestroy(() => player.reset())

  let canvas: HTMLCanvasElement
  let host: HTMLDivElement
  let scene = $state<Scene3D>()
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

  /** Inspect: pull the assembly apart (explode slider) and drag bodies
   *  around to look at them. Display only: the document never changes. */
  let inspecting = $state(false)
  let explode = $state(0)
  let movedCount = $state(0)
  const hasExplode = $derived(!!session.doc.explode?.steps.length)
  function toggleInspect() {
    inspecting = !inspecting
    if (inspecting) {
      ruler = false
      clearRuler()
      if (hasExplode && explode === 0) explode = 1
    } else {
      // Leaving inspect puts the assembly back together.
      resetInspect()
    }
  }
  function resetInspect() {
    scene?.resetMoved()
    movedCount = 0
    explode = 0
  }
  $effect(() => {
    scene?.setExplode(explode)
  })

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
    } else if (e.key === 'Escape' && inspecting) toggleInspect()
    else if (e.key === 'm' && !e.ctrlKey && !e.metaKey) toggleRuler()
    else if (e.key === 'e' && !e.ctrlKey && !e.metaKey) toggleInspect()
    else if (e.key === 'f' && !e.ctrlKey && !e.metaKey) scene?.frame()
    else if (e.key === ' ' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      if (player.playing) player.pause()
      else void play()
    }
    else if (e.altKey && /^Digit[1-4]$/.test(e.code)) {
      e.preventDefault()
      setShading(SHADINGS[+e.code.slice(5) - 1].id)
    }
  }

  onMount(() => {
    scene = new Scene3D(canvas)
    scene.setShading(shading)
    scene.onMoved = () => (movedCount = scene?.movedCount ?? 0)
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
    scene?.setCopper(session.doc.pcb, session.board)
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
    const name = scene?.pick(e.clientX, e.clientY)?.name
    if (inspecting) {
      scene?.inspect(name)
      return
    }
    session.selected = name
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

  {#if !session.ready}
    <div class="absolute inset-0 grid place-items-center bg-bg/70" role="status" aria-live="polite">
      <div class="pop corners flex items-center gap-2.5 px-4 py-3 text-ink-2">
        <LoaderCircle size={16} class="shrink-0 animate-spin motion-reduce:animate-none" />
        <div>
          <div class="font-medium text-ink">{session.building ? 'Building the model' : 'Loading the design'}</div>
          {#if session.building && session.doc.features.length}
            <div class="text-xs">{session.doc.features.length} features; imported parts take a few seconds the first time</div>
          {/if}
        </div>
      </div>
    </div>
  {:else if empty}
    <div class="pointer-events-none absolute inset-0 grid place-items-center">
      <div class="pop corners max-w-sm p-4 text-center text-ink-2">
        <div class="mb-1 font-medium text-ink">Empty design</div>
        Ask the assistant, e.g. <em>“Make an enclosure for a 50 × 26 mm board with a USB-C opening on the left.”</em>
      </div>
    </div>
  {/if}

  <div class="absolute top-2 left-2 flex gap-1">
    <div class="flex border border-line-strong bg-surface/90" role="radiogroup" aria-label="Shading">
      {#each SHADINGS as s (s.id)}
        {@const Icon = s.icon}
        <button
          role="radio"
          aria-checked={shading === s.id}
          class={['flex items-center gap-1 px-2 py-1 text-xs', shading === s.id ? 'bg-sel text-sel-ink' : 'text-ink-2 hover:bg-hover hover:text-ink']}
          title={s.title}
          onclick={() => setShading(s.id)}
        >
          <Icon size={13} /><span class="hidden lg:inline">{s.label}</span>
        </button>
      {/each}
    </div>
    <button class="btn px-2" onclick={() => scene?.frame()} title="Fit the model in view (F)">
      <Focus size={14} />
    </button>
    <button class={['btn px-2', ruler && 'on']} aria-pressed={ruler} onclick={toggleRuler} title="Measure between two points (M)">
      <Ruler size={14} />
      {#if ruler}<span class="text-xs">{points.length === 1 ? 'click the second point' : 'click a point'}</span>{/if}
    </button>
    {#if ruler}
      <span class="self-center border border-line bg-surface/90 px-2 py-0.5 text-[11px] text-ink-2">snaps to corners, midpoints, centers and edges · <kbd>Alt</kbd> free point · <kbd>Esc</kbd> clear</span>
    {/if}
    <button class={['btn px-2', inspecting && 'on']} aria-pressed={inspecting} onclick={toggleInspect} title="Inspect: pull the parts apart and drag them around to look; the design does not change (E)">
      <Move3d size={14} />
      {#if inspecting}<span class="text-xs">inspect</span>{/if}
    </button>
    {#if inspecting || (hasExplode && explode > 0)}
      <div class="flex items-center gap-2 border border-line bg-surface/90 px-2 py-0.5 text-[11px] text-ink-2">
        {#if hasExplode}
          <label class="flex items-center gap-1.5">
            explode
            <input type="range" min="0" max="1" step="0.01" bind:value={explode} class="h-1 w-28 accent-[var(--text)]" aria-label="Explode" />
          </label>
        {/if}
        {#if inspecting}<span>click a part, drag the arrows</span>{/if}
        {#if movedCount || explode > 0}
          <button class="btn btn-ghost px-1 py-0 text-[11px]" onclick={resetInspect} title="Put everything back"><RotateCcw size={12} /> reset</button>
        {/if}
        <span class="text-ink-3">view only</span>
      </div>
    {/if}
  </div>

  {#if !empty}
    <div class="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 border border-line-strong bg-surface/95 px-1.5 py-1 text-xs shadow-[var(--shadow-pop)]">
      {#if player.playing}
        <button class="btn btn-ghost px-1.5" onclick={() => player.pause()} title="Pause (Space)"><Pause size={14} /></button>
      {:else}
        <button class="btn btn-ghost px-1.5" onclick={play} title="Play the motion (Space)"><Play size={14} /></button>
      {/if}
      <button class="btn btn-ghost px-1.5" disabled={!player.playing && !player.paused} onclick={() => player.reset()} title="Stop and put everything back"><Square size={13} /></button>
      <div class="mx-1 flex border border-line" role="radiogroup" aria-label="Speed">
        {#each SPEEDS as s (s)}
          <button role="radio" aria-checked={player.speed === s} class={['px-1.5 py-0.5 font-mono text-[11px]', player.speed === s ? 'bg-sel text-sel-ink' : 'text-ink-2 hover:bg-hover']} onclick={() => (player.speed = s)}>{s}×</button>
        {/each}
      </div>
      {#if player.param && (player.playing || player.paused)}
        <span class="num w-28 font-mono text-[11px] text-ink-2">{player.param} = {player.value.toFixed(1)}</span>
        {#if access.canEdit}<button class="btn btn-ghost px-1.5 text-[11px]" onclick={keep} title="Stop and set the parameter to this value">keep</button>{/if}
      {:else if player.time > 0 || player.playing}
        <span class="num font-mono text-[11px] text-ink-2">{player.time.toFixed(1)} s</span>
      {/if}
      {#if player.error}<span class="max-w-72 truncate text-[11px] text-warn" title={player.error}>{player.error}</span>{/if}
    </div>
  {/if}

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
          {#if session.doc.materials?.length}
            <label class="mt-2 flex items-center gap-2">
              <span class="w-12 text-ink-3">material</span>
              <select
                class="input flex-1 px-1 py-0.5 text-[11px]"
                value={feature.material ?? ''}
                onchange={async (e) => {
                  appearanceError = ''
                  try {
                    await session.run('assign_material', { names: [feature.name], material: e.currentTarget.value || null })
                  } catch (err) {
                    appearanceError = (err as Error).message
                  }
                }}
              >
                <option value="">none (plain color)</option>
                {#each session.doc.materials as m (m.name)}<option value={m.name}>{m.name}</option>{/each}
              </select>
            </label>
          {/if}
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
