<script lang="ts">
  import { ArrowDownUp, ChevronLeft, ChevronRight, Plus, Search, Trash2, Users, X } from '@lucide/svelte'

  import TopBar from '../components/TopBar.svelte'
  import { account } from '../lib/account.svelte'
  import { api, type ProjectItem } from '../lib/api'
  import { router } from '../lib/router.svelte'
  import { tabs } from '../lib/tabs.svelte'

  const PAGE = 20
  const SORTS = [
    ['updated', 'Last changed'],
    ['name', 'Name'],
    ['created', 'Newest'],
  ] as const
  const FILTERS = [
    ['all', 'All'],
    ['mine', 'Mine'],
    ['shared', 'Shared with me'],
  ] as const

  // The list state lives in the URL, so back/forward and reload keep it.
  // svelte-ignore state_referenced_locally
  const start = router.query
  let q = $state(start.get('q') ?? '')
  let sort = $state(start.get('sort') ?? 'updated')
  let filter = $state(start.get('filter') ?? 'all')
  let page = $state(Math.max(1, Number(start.get('page')) || 1))

  let items = $state<ProjectItem[]>([])
  let total = $state(0)
  let loading = $state(true)
  let error = $state('')

  let name = $state('')
  let creating = $state(false)
  let confirmDelete = $state<string>()
  let searchBox = $state<HTMLInputElement>()

  const pages = $derived(Math.max(1, Math.ceil(total / PAGE)))
  /** Page buttons: first, last and around the current one; null is a gap. */
  const pageList = $derived.by(() => {
    const keep = Array.from({ length: pages }, (_, i) => i + 1).filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 1)
    const out: (number | null)[] = []
    keep.forEach((n, i) => {
      if (i > 0 && n - keep[i - 1] > 1) out.push(null)
      out.push(n)
    })
    return out
  })
  const canCreate = $derived(account.can('projects:write'))

  let seq = 0
  async function load() {
    const mine = ++seq
    loading = true
    try {
      const r = await api.projects({ q: q.trim(), sort, filter: filter === 'all' ? undefined : filter, limit: PAGE, offset: (page - 1) * PAGE })
      if (mine !== seq) return
      items = r.items
      total = r.total
      error = ''
      // A delete can empty the last page.
      if (!r.items.length && page > 1 && r.total > 0) page = Math.ceil(r.total / PAGE)
    } catch (e) {
      if (mine === seq) error = (e as Error).message
    } finally {
      if (mine === seq) loading = false
    }
  }

  // Reload when the query changes; typing waits for a pause.
  let timer: ReturnType<typeof setTimeout> | undefined
  // svelte-ignore state_referenced_locally
  let lastQ = q
  $effect(() => {
    const params = { q: q.trim(), sort: sort === 'updated' ? undefined : sort, filter: filter === 'all' ? undefined : filter, page: page > 1 ? page : undefined }
    router.setQuery(params)
    clearTimeout(timer)
    const typed = q !== lastQ
    lastQ = q
    if (typed) timer = setTimeout(load, 250)
    else void load()
  })

  function setPage(p: number) {
    page = Math.min(pages, Math.max(1, p))
  }

  function resetPage() {
    page = 1
  }

  async function create(e: Event) {
    e.preventDefault()
    const n = name.trim()
    if (!n || creating) return
    creating = true
    try {
      const p = await api.createProject(n)
      router.go(`/p/${p.id}`)
    } catch (err) {
      error = (err as Error).message
      creating = false
    }
  }

  async function remove(p: ProjectItem) {
    confirmDelete = undefined
    try {
      await api.deleteProject(p.id)
      tabs.close(p.id)
      await load()
    } catch (e) {
      error = (e as Error).message
    }
  }

  function ago(iso: string) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)} min ago`
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`
    return new Date(iso).toLocaleDateString()
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement
    if (e.key === '/' && !t.closest('input, textarea, select')) {
      e.preventDefault()
      searchBox?.focus()
    } else if (e.key === 'Escape' && t === searchBox && q) {
      q = ''
      resetPage()
    }
  }

</script>

<svelte:window onkeydown={onKey} />

<div class="flex h-full flex-col">
  <TopBar />

  <main class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto w-full max-w-5xl px-6 py-7">
      <div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1>Projects</h1>
        <span class="num text-[14px] text-ink-3">
          {#if !(loading && !items.length)}{total}{q.trim() ? ` matching “${q.trim()}”` : ''}{/if}
        </span>
        <span class="flex-1"></span>
        {#if canCreate}
          <form class="flex w-full gap-2 sm:w-auto" onsubmit={create}>
            <input class="input sm:w-72" placeholder="New project, e.g. ESP32 enclosure" bind:value={name} aria-label="New project name" />
            <button class="btn btn-primary shrink-0" disabled={!name.trim() || creating}><Plus size={14} /> {creating ? 'Creating…' : 'Create'}</button>
          </form>
        {/if}
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label class="relative w-full sm:w-80">
          <Search size={14} class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3" />
          <input
            bind:this={searchBox}
            class="input pr-8 pl-8"
            type="search"
            placeholder="Search name or description"
            aria-label="Search projects"
            bind:value={q}
            oninput={resetPage}
          />
          {#if q}
            <button
              type="button"
              class="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-1 text-ink-3 hover:bg-hover hover:text-ink"
              aria-label="Clear search"
              onclick={() => {
                q = ''
                resetPage()
                searchBox?.focus()
              }}><X size={13} /></button
            >
          {:else}
            <kbd class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">/</kbd>
          {/if}
        </label>
        <div class="seg" role="radiogroup" aria-label="Show">
          {#each FILTERS as [v, label] (v)}
            <button
              role="radio"
              aria-checked={filter === v}
              onclick={() => {
                filter = v
                resetPage()
              }}>{label}</button
            >
          {/each}
        </div>
        <label class="flex items-center gap-1.5 text-ink-3">
          <ArrowDownUp size={13} />
          <span class="sr-only">Sort by</span>
          <select class="input w-auto" bind:value={sort} onchange={resetPage}>
            {#each SORTS as [v, label] (v)}<option value={v}>{label}</option>{/each}
          </select>
        </label>
      </div>

      {#if error}
        <div class="note danger mb-3 items-center">
          <span class="flex-1">{error}</span>
          <button class="btn py-0.5" onclick={load}>Retry</button>
        </div>
      {/if}

      <section class="panel overflow-hidden" aria-busy={loading}>
        <div class="grid grid-cols-[minmax(0,1fr)_7rem_7rem_2.5rem] border-b border-line-strong bg-surface-2 px-3 py-1 text-xs font-medium text-ink-3 max-sm:hidden">
          <span>Name</span><span class="text-right">Changes</span><span class="text-right">Changed</span><span></span>
        </div>
        {#if loading && !items.length}
          <ul>
            {#each { length: 8 } as _, i (i)}
              <li class="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-0">
                <div class="skeleton h-3 rounded-sm" style="width: {30 + ((i * 17) % 35)}%"></div>
              </li>
            {/each}
          </ul>
        {:else if !items.length}
          <div class="px-6 py-12 text-center">
            <div class="mx-auto mb-3 grid size-6 place-items-center border border-dashed border-line-dash">
              <span class="block size-2.5 translate-x-[5px] -translate-y-[5px] bg-cta"></span>
            </div>
            {#if q.trim() || filter !== 'all'}
              <p class="font-medium">No projects match.</p>
              <p class="mt-1 text-ink-2">
                Try fewer words, or <button class="text-link hover:underline" onclick={() => ((q = ''), (filter = 'all'), resetPage())}>show all projects</button>.
              </p>
            {:else if canCreate}
              <p class="font-medium">No projects yet.</p>
              <p class="mt-1 text-ink-2">Name one above, then ask the assistant to model an enclosure or lay out a board.</p>
            {:else}
              <p class="font-medium">Nothing is shared with you yet.</p>
              <p class="mt-1 text-ink-2">Ask a project owner to share a project with you.</p>
            {/if}
          </div>
        {:else}
          <ul class={['transition-opacity', loading && 'opacity-55']}>
            {#each items as p, i (p.id)}
              <li class={['group grid grid-cols-[minmax(0,1fr)_7rem_7rem_2.5rem] items-center border-b border-line last:border-0 hover:bg-hover max-sm:grid-cols-[minmax(0,1fr)_2.5rem]', i % 2 === 1 && 'bg-surface-2/50']}>
                <a class="flex min-w-0 items-center gap-2.5 px-3 py-2 text-ink hover:no-underline" href={`#/p/${p.id}`}>
                  <span class={['sq', p.sessions > 0 ? 'ok' : 'idle']} title={p.sessions > 0 ? `open in ${p.sessions} ${p.sessions === 1 ? 'tab' : 'tabs'}` : 'not open'}></span>
                  <span class="min-w-0">
                    <span class="flex min-w-0 items-center gap-2">
                      <span class="truncate font-medium">{p.name}</span>
                      {#if p.access && p.access !== 'owner'}<span class="badge"><Users size={10} /> {p.access}</span>{/if}
                      {#if p.sessions > 0}<span class="badge ok">open</span>{/if}
                    </span>
                    {#if p.description}<span class="block truncate text-xs text-ink-3">{p.description}</span>{/if}
                  </span>
                </a>
                <span class="num pr-3 text-right text-ink-2 max-sm:hidden">{p.head}</span>
                <time class="num pr-3 text-right text-ink-2 max-sm:hidden" datetime={p.updated_at} title={new Date(p.updated_at).toLocaleString()}>{ago(p.updated_at)}</time>
                <span class="flex justify-end pr-1.5">
                  {#if p.access === 'owner' && account.can('projects:write')}
                    <button
                      class="btn btn-ghost px-1.5 opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                      title="Delete project"
                      aria-label={`Delete ${p.name}`}
                      onclick={() => (confirmDelete = p.id)}><Trash2 size={14} /></button
                    >
                  {/if}
                </span>
                {#if confirmDelete === p.id}
                  <div class="col-span-full flex items-center gap-2 border-t border-danger-line bg-danger-soft px-3 py-2 text-danger">
                    <span class="flex-1">Delete <b>{p.name}</b> and its whole history? This cannot be undone.</span>
                    <button class="btn" onclick={() => (confirmDelete = undefined)}>Keep</button>
                    <button class="btn btn-danger bg-surface" onclick={() => remove(p)}>Delete project</button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if pages > 1}
        <nav class="mt-3 flex items-center gap-2" aria-label="Pages">
          <span class="num text-ink-3">
            {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, total)} of {total}
          </span>
          <span class="ml-auto flex items-center gap-1">
            <button class="btn px-1.5" disabled={page <= 1} onclick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft size={14} /></button>
            {#each pageList as n, i (n ?? `gap${i}`)}
              {#if n === null}
                <span class="px-1 text-ink-3" aria-hidden="true">…</span>
              {:else}
                <button class={['btn num min-w-8 justify-center px-2', n === page && 'btn-primary']} aria-current={n === page ? 'page' : undefined} onclick={() => setPage(n)}>{n}</button>
              {/if}
            {/each}
            <button class="btn px-1.5" disabled={page >= pages} onclick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight size={14} /></button>
          </span>
        </nav>
      {/if}

    </div>
  </main>
</div>
