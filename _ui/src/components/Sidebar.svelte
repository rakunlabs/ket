<script lang="ts">
  import { AlertTriangle, Box, CheckCircle2, CircleX, EyeOff, History, Layers, ListChecks, Palette, PenTool, SlidersHorizontal } from '@lucide/svelte'

  import { effectiveParameters, inputsOf } from '../engine/doc'
  import type { CheckResult } from '../engine/kernel'
  import { projectAccess } from '../lib/access.svelte'
  import type { Session } from '../lib/session.svelte'
  import type { DesignProblem } from '../engine/problems'
  import ProblemsPanel from './ProblemsPanel.svelte'

  let { session, onrepair }: { session: Session; onrepair?: (problem: DesignProblem) => void } = $props()
  const access = projectAccess()

  let tab = $state<'model' | 'history' | 'problems'>('model')
  let checks = $state<CheckResult[]>()
  let checking = $state(false)
  let editing = $state<string>()
  let editValue = $state('')
  let paramError = $state('')

  const status = $derived(new Map(session.build?.features.map((f) => [f.name, f]) ?? []))
  const used = $derived(new Set(session.doc.features.flatMap(inputsOf)))

  async function useConfiguration(name: string) {
    try {
      await session.run('use_configuration', name ? { name } : {})
    } catch (e) {
      paramError = (e as Error).message
    }
  }

  async function runChecks() {
    checking = true
    try {
      const r = (await session.run('run_checks', {})) as { checks: CheckResult[] }
      checks = r.checks
    } finally {
      checking = false
    }
  }

  // Re-run checks after each build when there are some.
  $effect(() => {
    if (session.build && session.doc.checks.length) void runChecks()
    else checks = []
  })

  function startEdit(name: string, expr: unknown) {
    editing = name
    editValue = String(expr)
    paramError = ''
  }

  async function saveParam(name: string) {
    const v = editValue.trim()
    if (!v) return
    const expr = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
    try {
      // With a configuration active, the edit belongs to it; the base value stays.
      const conf = session.doc.configuration
      if (conf) await session.run('set_configuration', { name: conf, values: { [name]: expr } })
      else await session.run('set_parameters', { parameters: [{ name, expr }] })
      editing = undefined
    } catch (e) {
      paramError = (e as Error).message
    }
  }

  function author(a: string) {
    if (a.startsWith('ai:')) return 'AI'
    if (a.startsWith('mcp')) return 'MCP'
    return 'you'
  }
</script>

<aside class="flex w-72 shrink-0 flex-col border-r border-line-strong bg-sidebar">
  <div class="flex border-b border-line-strong bg-surface-2 px-1">
    {#each [['model', 'Model', Layers], ['problems', 'Problems', AlertTriangle], ['history', 'History', History]] as const as [id, label, Icon] (id)}
      <button
        class={['-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 font-medium', tab === id ? 'border-sel-ink bg-sel text-sel-ink' : 'border-transparent text-ink-2 hover:text-ink']}
        onclick={() => (tab = id)}
      >
        <Icon size={14} />{label}
      </button>
    {/each}
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if tab === 'model'}
      {#if session.doc.meta.description}
        <p class="border-b border-line px-3 py-2 text-xs text-ink-2">{session.doc.meta.description}</p>
      {/if}

      <div class="panel-title flex items-center gap-1.5"><SlidersHorizontal size={12} /> Parameters</div>
      {#if session.build?.parameterError}
        <p class="note danger mx-3 mb-1 py-1 text-xs">{session.build.parameterError}</p>
      {/if}
      {#if session.doc.configurations?.length}
        <label class="flex items-center gap-2 px-3 pb-1.5 text-xs">
          <span class="text-ink-2">Configuration</span>
          <select class="input min-w-0 flex-1 px-1.5 py-0.5 text-xs" aria-label="Configuration" disabled={!access.canEdit} value={session.doc.configuration ?? ''} onchange={(e) => useConfiguration(e.currentTarget.value)}>
            <option value="">Base parameters</option>
            {#each session.doc.configurations as c (c.name)}<option value={c.name} title={c.note ?? ''}>{c.name}</option>{/each}
          </select>
        </label>
      {/if}
      {#if session.doc.parameters.length === 0}
        <p class="px-3 pb-2 text-xs text-ink-2">None yet.</p>
      {/if}
      <ul class="px-1.5 pb-2">
        {#each effectiveParameters(session.doc) as p (p.name)}
          {@const value = session.build?.parameters[p.name]}
          {@const overridden = !!session.doc.configuration && session.doc.configurations?.find((c) => c.name === session.doc.configuration)?.values[p.name] !== undefined}
          <li class="rounded px-1.5 py-1 hover:bg-hover">
            {#if editing === p.name}
              <form
                class="flex items-center gap-1"
                onsubmit={(e) => {
                  e.preventDefault()
                  saveParam(p.name)
                }}
              >
                <span class="w-24 shrink-0 truncate font-mono text-xs">{p.name}</span>
                <!-- svelte-ignore a11y_autofocus -->
                <input class="input px-1.5 py-0.5 font-mono text-xs" bind:value={editValue} autofocus onblur={() => (editing = undefined)} onkeydown={(e) => e.key === 'Escape' && (editing = undefined)} />
              </form>
              {#if paramError}<p class="mt-1 text-xs text-danger">{paramError}</p>{/if}
            {:else}
              <button class="flex w-full items-center gap-2 text-left" title={p.description ?? 'Click to edit'} disabled={!access.canEdit} onclick={() => startEdit(p.name, p.expr)}>
                <span class={['min-w-0 flex-1 truncate font-mono text-xs', overridden && 'font-semibold']}>{p.name}{#if overridden}<span class="ml-1 font-sans text-[10px] font-normal text-link" title="Set by the configuration">cfg</span>{/if}</span>
                {#if typeof p.expr === 'string'}
                  <span class="max-w-24 truncate font-mono text-[11px] text-ink-3">{p.expr}</span>
                {/if}
                <span class="font-mono text-xs font-medium">{value ?? '?'}</span>
              </button>
            {/if}
          </li>
        {/each}
      </ul>

      <div class="panel-title flex items-center gap-1.5"><PenTool size={12} /> Sketches</div>
      {#if (session.doc.sketches?.length ?? 0) === 0}
        <p class="px-3 pb-2 text-xs text-ink-2">None yet.</p>
      {/if}
      <ul class="px-1.5 pb-2">
        {#each session.doc.sketches ?? [] as s (s.name)}
          {@const st = session.build?.sketches?.find((x) => x.name === s.name)}
          <li>
            <button
              class={['flex w-full items-center gap-2 rounded px-1.5 py-1 text-left', session.selected === s.name ? 'bg-sel text-sel-ink' : 'hover:bg-hover']}
              onclick={() => (session.selected = session.selected === s.name ? undefined : s.name)}
              title={st?.message ?? ''}
            >
              {#if st && !st.ok}
                <CircleX size={13} class="shrink-0 text-danger" />
              {:else if st && st.dof > 0}
                <AlertTriangle size={13} class="shrink-0 text-warn" />
              {:else}
                <span class="sq ok" title="Solved"></span>
              {/if}
              <span class="min-w-0 flex-1 truncate">{s.name}</span>
              <span class={['font-mono text-[11px]', session.selected === s.name ? 'text-sel-ink' : 'text-ink-3']}>{s.plane}{st ? ` · ${st.dof ? `${st.dof} dof` : 'fixed'}` : ''}</span>
            </button>
            {#if session.selected === s.name && st}
              <div class="mx-1.5 mb-1 rounded bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-ink-3">
                <div>{s.points.length} points · {s.entities.length} entities · {s.constraints.length} constraints · {st.loops} loop(s)</div>
                {#if st.message}<div class={st.ok ? 'text-warn' : 'text-danger'}>{st.message}</div>{/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>

      <div class="panel-title flex items-center gap-1.5"><Box size={12} /> Features</div>
      {#if session.doc.features.length === 0}
        <p class="px-3 pb-2 text-xs text-ink-2">None yet.</p>
      {/if}
      <ul class="px-1.5 pb-2">
        {#each session.doc.features as f (f.name)}
          {@const st = status.get(f.name)}
          {@const body = !used.has(f.name) && !f.hidden}
          <li>
            <button
              class={['flex w-full items-center gap-2 rounded px-1.5 py-1 text-left', session.selected === f.name ? 'bg-sel text-sel-ink' : 'hover:bg-hover']}
              onclick={() => (session.selected = session.selected === f.name ? undefined : f.name)}
              title={st?.error ?? f.note ?? ''}
            >
              {#if st && !st.ok}
                <CircleX size={13} class="shrink-0 text-danger" />
              {:else if st?.warnings?.length}
                <AlertTriangle size={13} class="shrink-0 text-warn" />
              {:else if f.hidden}
                <EyeOff size={13} class={['shrink-0', session.selected === f.name ? 'text-sel-ink' : 'text-ink-2']} />
              {:else}
                <span class={['sq', body ? 'bg-ink-2' : 'idle opacity-50']} title={body ? 'Visible body' : 'Used by another feature'}></span>
              {/if}
              <span class={['min-w-0 flex-1 truncate', !body && session.selected !== f.name && 'text-ink-2']}>{f.name}</span>
              <span class={['font-mono text-[11px]', session.selected === f.name ? 'text-sel-ink' : 'text-ink-3']}>{f.type}{f.type === 'boolean' ? ` ${f.op}` : ''}</span>
            </button>
            {#if session.selected === f.name && st}
              <div class="mx-1.5 mb-1 border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-ink-3">
                {#if st.error}<div class="text-danger">{st.error}</div>{/if}
                {#each st.warnings ?? [] as w}<div class="text-warn">{w}</div>{/each}
                {#if st.bbox}<div>bbox [{st.bbox[0].join(', ')}] → [{st.bbox[1].join(', ')}]</div>{/if}
                {#if st.volume !== undefined}<div>volume {st.volume} mm³ · {st.faces} faces</div>{/if}
                {#if f.note}<div class="mt-1 font-sans text-ink">{f.note}</div>{/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>

      <div class="panel-title flex items-center gap-1.5"><Palette size={12} /> Materials <span class="ml-auto text-[10px] font-normal normal-case text-ink-3">display only</span></div>
      {#if (session.doc.materials?.length ?? 0) === 0}
        <p class="px-3 pb-2 text-xs text-ink-2">None yet. Ask for a look, e.g. <em>“brushed aluminum case, rubber feet”</em>.</p>
      {/if}
      <ul class="px-1.5 pb-2">
        {#each session.doc.materials ?? [] as m (m.name)}
          {@const users = session.doc.features.filter((f) => f.material === m.name).map((f) => f.name)}
          {@const maps = Object.entries(m.maps ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}${v?.pattern ? ` (${v.pattern})` : ' (image)'}`)}
          <li class="rounded px-1.5 py-1 hover:bg-hover" title={m.note ?? ''}>
            <div class="flex items-center gap-2">
              <span
                class="size-3.5 shrink-0 border border-control"
                style="background: {m.color}; box-shadow: inset 0 0 0 1px rgba(255,255,255,{(m.metalness ?? 0) * 0.5}), inset -3px -3px 4px rgba(0,0,0,{0.4 - (m.roughness ?? 0.6) * 0.3})"
              ></span>
              <span class="min-w-0 flex-1 truncate">{m.name}</span>
              <span class="font-mono text-[11px] text-ink-3">M {(m.metalness ?? 0).toFixed(1)} · R {(m.roughness ?? 0.6).toFixed(1)}</span>
            </div>
            <div class="truncate pl-5.5 text-[11px] text-ink-3">
              {users.length ? users.join(', ') : 'not assigned'}{maps.length ? ` · ${maps.join(', ')}` : ''}{m.uv ? ` · uv ${m.uv.projection} ${m.uv.scale ?? 10} mm` : ''}
            </div>
          </li>
        {/each}
      </ul>
      {#if session.doc.decals?.length}
        {@const counts = session.doc.decals.reduce((m, d) => m.set(d.target, (m.get(d.target) ?? 0) + 1), new Map<string, number>())}
        <div class="px-3 pb-2 text-[11px] text-ink-3">
          <span class="text-ink-2">Decals:</span>
          {[...counts].map(([t, n]) => `${n} on ${t}`).join(' · ')}
        </div>
      {/if}
      {#each session.build?.appearance ?? [] as p}
        <p class="note warn mx-3 mb-1 py-1 text-[11px]">{p}</p>
      {/each}

      <div class="panel-title flex items-center gap-1.5"><ListChecks size={12} /> Checks</div>
      {#if session.doc.checks.length === 0}
        <p class="px-3 pb-3 text-xs text-ink-2">No requirements yet. The assistant adds them before modelling.</p>
      {/if}
      <ul class="px-1.5 pb-3">
        {#each session.doc.checks as c (c.name)}
          {@const r = checks?.find((x) => x.name === c.name)}
          <li class="flex items-start gap-2 rounded px-1.5 py-1" title={c.note ?? ''}>
            {#if !r}
              <span class="mt-[5px] sq idle" title="Not run yet"></span>
            {:else if r.ok}
              <CheckCircle2 size={13} class="mt-0.5 shrink-0 text-ok" />
            {:else}
              <CircleX size={13} class="mt-0.5 shrink-0 text-danger" />
            {/if}
            <div class="min-w-0">
              <div class="truncate">{c.name}</div>
              {#if r}<div class="text-[11px] text-ink-3">{r.detail}</div>{/if}
            </div>
          </li>
        {/each}
      </ul>
    {:else if tab === 'problems'}
      <ProblemsPanel {session} {onrepair} />
    {:else}
      <ul class="py-1">
        {#each [...session.log].reverse() as e (e.seq)}
          <li class="flex gap-2 px-3 py-1.5">
            <span class="num w-6 shrink-0 text-right font-mono text-[11px] text-ink-3">{e.seq}</span>
            <div class="min-w-0">
              <div class="break-words">{e.summary}</div>
              <div class="text-[11px] text-ink-3">{author(e.author)} · {e.cmd}</div>
            </div>
          </li>
        {:else}
          <li class="px-3 py-2 text-xs text-ink-2">No changes yet.</li>
        {/each}
        {#if session.top > session.head}
          <li class="px-3 py-1.5 text-[11px] text-ink-3">{session.top - session.head} undone change(s) can be redone</li>
        {/if}
      </ul>
    {/if}
  </div>
</aside>
