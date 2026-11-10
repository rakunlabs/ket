<script lang="ts">
  import { Bot, LayoutGrid, Moon, X } from '@lucide/svelte'

  import { router } from '../lib/router.svelte'
  import { tabs } from '../lib/tabs.svelte'

  let dragging = $state<number>()

  function onAux(e: MouseEvent, id: string) {
    if (e.button === 1) {
      e.preventDefault()
      tabs.close(id)
    }
  }

  function onKey(e: KeyboardEvent) {
    // Alt+1..9 switches tabs, Alt+0 goes to the project list.
    if (!e.altKey || e.ctrlKey || e.metaKey || !/^Digit\d$/.test(e.code)) return
    const n = Number(e.code.slice(5))
    e.preventDefault()
    if (n === 0) router.go('/')
    else if (tabs.list[n - 1]) router.go(`/p/${tabs.list[n - 1].id}`)
  }
</script>

<svelte:window onkeydown={onKey} />

<nav class="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line-strong bg-bg" aria-label="Open projects">
  <a
    href="#/"
    class={['tab shrink-0 px-2.5', !tabs.active && !router.settings && 'current']}
    title="All projects (Alt+0)"
    aria-current={!tabs.active && !router.settings ? 'page' : undefined}
  >
    <LayoutGrid size={14} /><span class="sr-only">All projects</span>
  </a>
  {#each tabs.list as tab, i (tab.id)}
    {@const current = tabs.active?.id === tab.id}
    <div
      role="presentation"
      class={['tab group min-w-0 max-w-56', current && 'current', dragging === i && 'opacity-50']}
      draggable="true"
      ondragstart={(e) => {
        dragging = i
        e.dataTransfer?.setData('text/plain', tab.id)
      }}
      ondragover={(e) => e.preventDefault()}
      ondrop={(e) => {
        e.preventDefault()
        if (dragging !== undefined) tabs.move(dragging, i)
        dragging = undefined
      }}
      ondragend={() => (dragging = undefined)}
      onauxclick={(e) => onAux(e, tab.id)}
    >
      <a
        href={`#/p/${tab.id}`}
        class="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-3 text-inherit hover:no-underline"
        aria-current={current ? 'page' : undefined}
        title={`${tab.name || 'Project'}${i < 9 ? ` (Alt+${i + 1})` : ''}${tab.live ? '' : ' · asleep, opens on click'}`}
      >
        {#if tab.agent}
          <Bot size={12} class="shrink-0 text-link" aria-label="An agent is working here" />
        {:else if !tab.live}
          <Moon size={12} class="shrink-0 text-ink-3" aria-label="Asleep" />
        {/if}
        <span class="truncate">{tab.name || '…'}</span>
      </a>
      <button
        class={['mr-1 grid size-5 shrink-0 place-items-center rounded-sm text-ink-2 hover:bg-hover hover:text-ink', !current && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100']}
        title="Close tab (middle click)"
        aria-label={`Close ${tab.name || 'project'}`}
        onclick={() => tabs.close(tab.id)}
      >
        <X size={12} />
      </button>
    </div>
  {/each}
</nav>

<style>
  .tab {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12.5px;
    color: var(--text-2);
    border-right: 1px solid var(--border);
    margin-bottom: -1px;
    border-bottom: 1px solid transparent;
    white-space: nowrap;
    user-select: none;
  }
  a.tab:hover,
  .tab:hover {
    color: var(--text);
    background: var(--row-hover);
    text-decoration: none;
  }
  .tab.current {
    color: var(--text);
    font-weight: 500;
    background: var(--sidebar);
    border-bottom-color: var(--sidebar);
    box-shadow: inset 0 2px 0 var(--cta);
  }
</style>
