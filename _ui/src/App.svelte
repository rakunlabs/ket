<script lang="ts">
  import { onMount, untrack } from 'svelte'

  import TabBar from './components/TabBar.svelte'
  import Toasts from './components/Toasts.svelte'
  import { account } from './lib/account.svelte'
  import { appLink } from './lib/app-link.svelte'
  import { router } from './lib/router.svelte'
  import { tabs } from './lib/tabs.svelte'
  import Projects from './pages/Projects.svelte'
  import Settings from './pages/Settings.svelte'
  import Workspace from './pages/Workspace.svelte'

  onMount(async () => {
    await account.load()
    if (account.me) appLink.start()
  })

  // A project in the address (a link, back/forward) gets a tab.
  $effect(() => {
    const id = router.project
    if (id && !router.settings) untrack(() => tabs.open(id, '', false))
  })

  $effect(() => {
    if (!tabs.active) document.title = 'Ket'
  })
</script>

{#if !account.loaded}
  <div class="grid h-full place-items-center text-ink-2">Loading…</div>
{:else}
  <div class="flex h-full flex-col">
    {#if tabs.list.length}<TabBar />{/if}
    <div class="relative min-h-0 flex-1">
      {#each tabs.list as tab (tab.id)}
        {#if tab.live}
          {@const visible = tabs.active?.id === tab.id}
          <div class={['absolute inset-0', !visible && 'invisible']} inert={!visible}>
            <Workspace {tab} {visible} />
          </div>
        {/if}
      {/each}
      {#if router.settings}
        <div class="absolute inset-0"><Settings /></div>
      {:else if !tabs.active}
        <div class="absolute inset-0"><Projects /></div>
      {/if}
    </div>
  </div>
{/if}

<Toasts />
