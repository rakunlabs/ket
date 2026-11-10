<script lang="ts">
  import { Bot, Cpu, Info, LogIn, ShieldCheck, UsersRound, User } from '@lucide/svelte'

  import TopBar from '../components/TopBar.svelte'
  import ProvidersSettings from '../components/settings/ProvidersSettings.svelte'
  import GeneralSettings from '../components/settings/GeneralSettings.svelte'
  import UsersSettings from '../components/settings/UsersSettings.svelte'
  import GroupsSettings from '../components/settings/GroupsSettings.svelte'
  import SSOSettings from '../components/settings/SSOSettings.svelte'
  import AboutSettings from '../components/settings/AboutSettings.svelte'
  import { account } from '../lib/account.svelte'
  import { router } from '../lib/router.svelte'

  const TABS = [
    { id: 'ai', label: 'AI providers', icon: Bot, perm: 'settings:write' },
    { id: 'users', label: 'Users', icon: User, perm: 'users:read' },
    { id: 'groups', label: 'Groups', icon: UsersRound, perm: 'users:read' },
    { id: 'sso', label: 'Sign-in providers', icon: LogIn, perm: 'settings:write' },
    { id: 'general', label: 'Access & server', icon: ShieldCheck, perm: 'settings:write' },
    { id: 'pcb', label: 'PCB tools', icon: Cpu, perm: 'settings:write' },
    { id: 'about', label: 'About & MCP', icon: Info, perm: '' },
  ] as const

  const tabs = $derived(TABS.filter((t) => !t.perm || account.can(t.perm)))
  const tab = $derived(tabs.find((t) => t.id === router.settings) ?? tabs[0])
</script>

<div class="flex h-full flex-col">
  <TopBar />
  {#if !tabs.length}
    <div class="grid flex-1 place-items-center text-ink-2">Settings are for administrators.</div>
  {:else}
    <div class="flex min-h-0 flex-1">
      <nav class="w-56 shrink-0 border-r border-line-strong bg-sidebar p-2" aria-label="Settings">
        <h1 class="px-2 pt-1.5 pb-2 text-[15px] font-semibold">Settings</h1>
        {#each tabs as t (t.id)}
          <a
            href={`#/settings/${t.id}`}
            class={['flex items-center gap-2 border-l-2 px-2 py-1.5 hover:no-underline', tab?.id === t.id ? 'border-sel-ink bg-sel font-medium text-sel-ink' : 'border-transparent text-ink-2 hover:bg-hover hover:text-ink']}
            aria-current={tab?.id === t.id ? 'page' : undefined}
          >
            <t.icon size={14} />
            {t.label}
          </a>
        {/each}
      </nav>
      <main class="min-w-0 flex-1 overflow-y-auto">
        <div class="mx-auto max-w-3xl px-8 py-6">
          {#key tab?.id}
            {#if tab?.id === 'ai'}<ProvidersSettings />
            {:else if tab?.id === 'users'}<UsersSettings />
            {:else if tab?.id === 'groups'}<GroupsSettings />
            {:else if tab?.id === 'sso'}<SSOSettings />
            {:else if tab?.id === 'general'}<GeneralSettings section="general" />
            {:else if tab?.id === 'pcb'}<GeneralSettings section="pcb" />
            {:else if tab?.id === 'about'}<AboutSettings />
            {/if}
          {/key}
        </div>
      </main>
    </div>
  {/if}
</div>
