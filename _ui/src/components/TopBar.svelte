<script lang="ts">
  import { Settings } from '@lucide/svelte'
  import type { Snippet } from 'svelte'

  import { account } from '../lib/account.svelte'
  import { router } from '../lib/router.svelte'
  import AccountMenu from './AccountMenu.svelte'
  import Logo from './Logo.svelte'
  import ThemeToggle from './ThemeToggle.svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<header class="flex h-12 shrink-0 items-center gap-3 border-b border-line-strong bg-sidebar px-4">
  <a href="#/" class="flex items-center gap-2 rounded-sm text-ink hover:no-underline" aria-label="Ket projects">
    <Logo size={22} />
    <span class="text-[15px] font-semibold tracking-tight">Ket</span>
  </a>
  {@render children?.()}
  <span class="ml-auto flex items-center gap-1">
    <ThemeToggle />
    {#if account.can('settings:write')}
      <a href="#/settings" class={['btn btn-ghost hover:no-underline', router.settings && 'on']} aria-current={router.settings ? 'page' : undefined}>
        <Settings size={14} /> Settings
      </a>
    {/if}
    <AccountMenu />
  </span>
</header>
