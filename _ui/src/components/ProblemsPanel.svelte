<script lang="ts">
  import { Bot, CircleAlert, Focus, RefreshCw } from '@lucide/svelte'

  import type { DesignProblem, designProblems } from '../engine/problems'
  import type { Session } from '../lib/session.svelte'
  import { toasts } from '../lib/toasts'

  let { session, onrepair }: { session: Session; onrepair?: (problem: DesignProblem) => void } = $props()
  type Report = Awaited<ReturnType<typeof designProblems>> & { total: number; truncated: boolean }
  let report = $state<Report>()
  let busy = $state(false)
  let error = $state('')
  let filter = $state('all')
  let severity = $state('all')
  let lastDoc: unknown
  let seq = 0
  const stale = $derived(!!report && lastDoc !== session.doc)
  const found = $derived(report?.problems.filter((p) => (filter === 'all' || p.domain === filter) && (severity === 'all' || p.severity === severity)) ?? [])

  async function refresh() {
    const request = ++seq, doc = session.doc
    busy = true
    error = ''
    try {
      const result = await session.run('get_problems', { limit: 200 }) as Report
      if (request !== seq) return
      report = result
      lastDoc = doc
    } catch (e) { if (request === seq) error = (e as Error).message }
    finally { if (request === seq) busy = false }
  }

  $effect(() => {
    void session.doc
    void session.recovery
    if (!session.ready || session.building) return
    const timer = setTimeout(refresh, 250)
    return () => { clearTimeout(timer); seq++ }
  })

  async function focus(problem: DesignProblem) {
    try { await session.run('focus_problem', { id: problem.id }) }
    catch (e) { toasts.show((e as Error).message, 'error') }
  }
</script>

<section aria-label="Design problems" class="text-xs">
  <header class="space-y-2 border-b border-line px-3 py-3">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold">Design problems</h2>
      <button class="btn btn-ghost px-1.5" aria-label="Refresh design problems" disabled={busy || session.building} onclick={refresh}><RefreshCw size={14} /></button>
    </div>
    {#if report}<p class="text-ink-2" role="status">{report.counts.errors} errors · {report.counts.warnings} warnings{stale ? ' · Out of date' : ''}</p>{/if}
    <div class="grid grid-cols-2 gap-2">
      <label class="space-y-1"><span>Area</span><select class="input text-xs" aria-label="Problem area" bind:value={filter}><option value="all">All areas</option><option value="cad">CAD</option><option value="pcb">PCB</option><option value="electrical">Electrical</option><option value="manufacturing">Manufacturing</option><option value="history">History</option></select></label>
      <label class="space-y-1"><span>Severity</span><select class="input text-xs" aria-label="Problem severity" bind:value={severity}><option value="all">All issues</option><option value="error">Errors</option><option value="warning">Warnings</option></select></label>
    </div>
    <p class="text-ink-3">The same report is available to AI through <code>get_problems</code>.</p>
  </header>
  {#if busy}<p class="px-3 py-2 text-ink-2" role="status">Checking the current design…</p>{/if}
  {#if error}<p class="note danger m-2 text-xs" role="alert">{error}</p>{/if}
  <ul class="divide-y divide-line">
    {#each found as problem (problem.id)}
      <li class="space-y-2 px-3 py-3">
        <div class="flex items-start gap-2"><CircleAlert size={14} class={['mt-0.5 shrink-0', problem.severity === 'error' ? 'text-danger' : 'text-warn']} /><div class="min-w-0"><p class="font-medium break-words">{problem.message}</p><p class="mt-1 text-[11px] text-ink-3">{problem.domain} · {problem.severity} · {problem.rule}</p></div></div>
        <p class="break-words text-ink-2">{problem.fix}</p>
        <div class="flex flex-wrap gap-1">
          <button class="btn text-xs" disabled={busy || stale} onclick={() => focus(problem)}><Focus size={12} /> Locate</button>
          {#if onrepair && problem.domain !== 'history'}<button class="btn text-xs" disabled={busy || stale || !!session.recovery} onclick={() => onrepair?.(problem)}><Bot size={12} /> Ask AI to repair</button>{/if}
        </div>
      </li>
    {:else}
      {#if report && !busy}<li class="px-3 py-4 text-ink-2">{report.problems.length ? 'No issues match these filters.' : 'No errors or warnings found in the declared checks.'}</li>{/if}
    {/each}
  </ul>
  {#if report?.truncated}<p class="note warn m-2 text-xs">Showing the first 200 issues. AI can page through all results with get_problems.</p>{/if}
  <p class="border-t border-line px-3 py-3 text-ink-3">Passing checks does not certify circuit function, physical fit or manufacturer DFM. Unknown electrical pin types remain unverified.</p>
</section>
