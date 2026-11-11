<script lang="ts">
  import { Bot, ChevronLeft, Download, Focus, Redo2, Undo2, Upload } from '@lucide/svelte'
  import { onDestroy, onMount } from 'svelte'

  import Chat from '../components/Chat.svelte'
  import AccountMenu from '../components/AccountMenu.svelte'
  import Logo from '../components/Logo.svelte'
  import ThemeToggle from '../components/ThemeToggle.svelte'
  import ProposalBar from '../components/ProposalBar.svelte'
  import ShareDialog from '../components/ShareDialog.svelte'
  import { account } from '../lib/account.svelte'
  import Sidebar from '../components/Sidebar.svelte'
  import BoardView from '../components/BoardView.svelte'
  import SchematicView from '../components/SchematicView.svelte'
  import Viewport from '../components/Viewport.svelte'
  import { api, type Project, type ProviderInfo } from '../lib/api'
  import { ProjectAccess, provideAccess } from '../lib/access.svelte'
  import { Session } from '../lib/session.svelte'
  import { type Tab, tabs } from '../lib/tabs.svelte'

  let { tab, visible }: { tab: Tab; visible: boolean } = $props()

  // App keys this component by tab, so the project never changes here.
  // svelte-ignore state_referenced_locally
  const projectID = tab.id
  const session = new Session(projectID)
  const access = new ProjectAccess()
  provideAccess(access)
  let project = $state<Project>()
  let loadError = $state('')
  // The assistant panel starts closed; the choice is kept per browser.
  const CHAT_KEY = 'ket.chat'
  let showChat = $state(chatOpen())

  function chatOpen(): boolean {
    try {
      return localStorage.getItem(CHAT_KEY) === 'open'
    } catch {
      return false
    }
  }
  let providers = $state<ProviderInfo[]>([])
  const canChat = $derived(account.can('ai:use') && access.canEdit && providers.length > 0)

  function toggleChat() {
    showChat = !showChat
    try {
      if (showChat) localStorage.setItem(CHAT_KEY, 'open')
      else localStorage.removeItem(CHAT_KEY)
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
  }
  let viewport = $state<Viewport>()
  let boardView = $state<BoardView>()
  let mode = $state<'3d' | 'pcb' | 'sch'>('3d')
  let schView = $state<SchematicView>()
  const modes = ['3d', 'pcb', 'sch'] as const

  onMount(async () => {
    try {
      project = await api.project(projectID)
      access.access = project.access
      tabs.rename(projectID, project.name)
      if (account.can('ai:use')) providers = await api.providers().catch(() => [])
      await session.open()
    } catch (e) {
      loadError = (e as Error).message
    }
  })

  onDestroy(() => {
    session.close()
    tab.agent = false
  })

  $effect(() => {
    session.visible = visible
    if (visible) document.title = `${project?.name || tab.name || 'Project'} · Ket`
  })

  function onKey(e: KeyboardEvent) {
    if (!visible) return
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, [contenteditable]')) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) session.redo()
      else session.undo()
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      session.redo()
    } else if (e.key === 'f') {
      if (mode === 'pcb') boardView?.frame()
      else if (mode === 'sch') schView?.frame()
      else viewport?.frame()
    } else if (e.key === 'Tab' && !e.ctrlKey) {
      e.preventDefault()
      mode = modes[(modes.indexOf(mode) + 1) % modes.length]
    }
  }

  async function exportAs(format: 'step' | 'stl') {
    try {
      await session.run('export', { format, filename: `${project?.name ?? 'model'}.${format}` })
    } catch (e) {
      alert((e as Error).message)
    }
  }

  async function exportFab() {
    try {
      await session.run('export_fab', { filename: `${project?.name ?? 'board'}-fab.zip` })
    } catch (e) {
      if (confirm(`${(e as Error).message}\n\nExport anyway?`)) await session.run('export_fab', { force: true, filename: `${project?.name ?? 'board'}-fab.zip` })
    }
  }

  let projectInput: HTMLInputElement
  let fileBusy = $state(false)
  let fileMessage = $state('')
  let fileError = $state(false)
  let manufacturer = $state<'jlcpcb' | 'pcbway'>('jlcpcb')
  let quantity = $state(5)
  const quoteUrl = $derived(manufacturer === 'jlcpcb' ? 'https://jlcpcb.com/quote' : 'https://www.pcbway.com/orderonline.aspx')
  async function fileAction(action: () => Promise<unknown>, message: string) {
    fileBusy = true
    fileMessage = ''
    fileError = false
    try {
      await action()
      fileMessage = message
    } catch (e) {
      fileError = true
      fileMessage = (e as Error).message
    } finally { fileBusy = false }
  }
  async function openProjectFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    await fileAction(async () => {
      if (file.size > 25 * 1024 * 1024) throw new Error('This .ket file is larger than 25 MiB.')
      await session.run('import_project', { data: await file.text() })
    }, 'Project imported. Remote models may need network access on first open.')
  }

  const failed = $derived(session.build?.features.filter((f) => !f.ok).length ?? 0)
  let now = $state(Date.now())
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(t)
  })

  const activityFresh = $derived(session.activity && session.activity.author !== 'user' && now - session.activity.at < 4000)
  $effect(() => {
    tab.agent = !!activityFresh
  })
</script>

<svelte:window onkeydown={onKey} />

<div class="flex h-full flex-col">
  <header class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-line-strong bg-sidebar px-2 py-1">
    <a class="btn btn-ghost px-1.5 text-ink" href="#/" title="All projects" aria-label="All projects"><ChevronLeft size={16} /></a>
    <Logo size={20} />
    <span class="min-w-0 truncate font-semibold">{project?.name ?? '…'}</span>
    <span class="badge" title={session.connected ? 'Connected: changes sync live' : 'Reconnecting…'}>
      <span class={['sq', session.connected ? 'ok live' : 'idle']}></span>{session.connected ? 'live' : 'offline'}
    </span>
    {#if session.building}<span class="badge"><span class="sq idle live"></span>building</span>{/if}
    {#if !access.canEdit}<span class="badge">read-only</span>{/if}
    {#if failed}<span class="badge danger"><span class="sq danger"></span>{failed} failed</span>{/if}
    {#if activityFresh && session.activity}
      <span class="badge accent max-w-80 truncate">
        <Bot size={11} />{session.activity.author.startsWith('mcp') ? 'MCP' : 'AI'}: {session.activity.text}
      </span>
    {/if}

    <div class="ml-auto flex flex-wrap items-center justify-end gap-1">
      <button class="btn btn-ghost px-1.5" title="Undo (Ctrl+Z)" disabled={session.head === 0} onclick={() => session.undo()}>
        <Undo2 size={15} />
      </button>
      <button class="btn btn-ghost px-1.5" title="Redo (Ctrl+Shift+Z)" disabled={session.head >= session.top} onclick={() => session.redo()}>
        <Redo2 size={15} />
      </button>
      <span class="mx-1 h-5 w-px bg-line-strong"></span>
      <div class="seg" role="radiogroup" aria-label="View">
        {#each [['3d', '3D'], ['pcb', 'PCB'], ['sch', 'SCH']] as const as [m, label] (m)}
          <button role="radio" aria-checked={mode === m} onclick={() => (mode = m)} title="Tab switches views">{label}</button>
        {/each}
      </div>
      <button class="btn btn-ghost px-1.5" title="Fit view (F)" onclick={() => (mode === 'pcb' ? boardView?.frame() : mode === 'sch' ? schView?.frame() : viewport?.frame())}><Focus size={15} /></button>
      <details class="relative">
        <summary class="btn cursor-pointer">Project file</summary>
        <div class="pop absolute right-0 top-full z-30 mt-1 w-72 space-y-2 bg-surface p-3">
          <p class="text-xs text-ink-2">Editable .ket file, including CAD, PCB and routing. Remote assets remain URL references.</p>
          <button class="btn w-full" disabled={fileBusy || !session.ready || session.building} onclick={() => fileAction(() => session.run('export_project', { filename: `${project?.name ?? 'project'}.ket` }), 'Project file downloaded.')}><Download size={14} /> Save Ket project</button>
          {#if access.canEdit}
            <button class="btn w-full" disabled={fileBusy || !session.ready || session.building} onclick={() => projectInput.click()}><Upload size={14} /> Import Ket into empty project</button>
          {/if}
        </div>
      </details>
      {#if session.doc.pcb}
        <details class="relative">
          <summary class="btn cursor-pointer">Manufacture</summary>
          <div class="pop absolute right-0 top-full z-30 mt-1 w-80 space-y-3 bg-surface p-3">
            <p class="text-xs text-ink-2">Download a checked prototype package. Upload, quote confirmation and payment stay with you.</p>
            <label class="flex items-center justify-between gap-2 text-xs">Manufacturer
              <select class="input" bind:value={manufacturer}><option value="jlcpcb">JLCPCB</option><option value="pcbway">PCBWay</option></select>
            </label>
            <label class="flex items-center justify-between gap-2 text-xs">Quantity
              <input class="input w-24" type="number" min="1" max="100000" step="1" bind:value={quantity} />
            </label>
            <button class="btn w-full" disabled={fileBusy || session.building || !Number.isInteger(quantity) || quantity < 1 || quantity > 100000} onclick={() => fileAction(() => session.run('export_manufacturing', { manufacturer, quantity, filename: `${project?.name ?? 'board'}-${manufacturer}-prototype.zip` }), 'Prototype package downloaded. Review its ORDERING.md and manufacturing.json before ordering.')}><Download size={14} /> {fileBusy ? 'Preparing package…' : 'Download checked package'}</button>
            <a class="text-xs underline" href={quoteUrl} target="_blank" rel="noopener noreferrer">Open manufacturer quote page (new tab)</a>
          </div>
        </details>
      {/if}
      {#if session.doc.pcb}<button class="btn" onclick={() => exportFab()}><Download size={14} /> Gerber</button>{/if}
      <button class="btn" onclick={() => exportAs('step')}><Download size={14} /> STEP</button>
      <button class="btn" onclick={() => exportAs('stl')}><Download size={14} /> STL</button>
      {#if canChat}
        <button class={['btn', showChat && 'on']} aria-pressed={showChat} onclick={toggleChat}>
          <Bot size={14} /> Assistant
        </button>
      {/if}
      {#if project}<ShareDialog {project} />{/if}
      <ThemeToggle />
      <AccountMenu />
    </div>
  </header>

  <ProposalBar {session} />
  <input bind:this={projectInput} class="hidden" type="file" accept=".ket,application/json" onchange={openProjectFile} aria-label="Import Ket project file" />
  {#if fileMessage}
    <div class={['note mx-2 my-1 text-xs', fileError && 'danger']} role={fileError ? 'alert' : 'status'}>{fileMessage}</div>
  {/if}

  {#if loadError}
    <div class="note danger m-6">{loadError}</div>
  {:else}
    <div class="flex min-h-0 flex-1">
      <Sidebar {session} />
      <main class="relative min-w-0 flex-1">
        <div class={['absolute inset-0', mode !== '3d' && 'invisible']}><Viewport bind:this={viewport} {session} /></div>
        <div class={['absolute inset-0', mode !== 'pcb' && 'invisible']}><BoardView bind:this={boardView} {session} /></div>
        <div class={['absolute inset-0', mode !== 'sch' && 'invisible']}><SchematicView bind:this={schView} {session} /></div>
      </main>
      {#if showChat && canChat}
        <Chat {session} {projectID} {providers} />
      {/if}
    </div>
  {/if}
</div>
