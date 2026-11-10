<script lang="ts">
  import { Copy, Info, KeyRound, LogOut, Settings, Trash2, UserCog, X } from '@lucide/svelte'

  import { account } from '../lib/account.svelte'
  import { api } from '../lib/api'

  let open = $state(false)
  let tokensOpen = $state(false)
  let tokens = $state<Awaited<ReturnType<typeof api.tokens>>>([])
  let name = $state('')
  let days = $state(90)
  let created = $state<string>()
  let error = $state('')
  let tokenDialog = $state<HTMLDialogElement>()
  let loading = $state(false)
  let creating = $state(false)
  let revoking = $state('')
  let accountButton = $state<HTMLButtonElement>()

  $effect(() => {
    if (tokensOpen) tokenDialog?.showModal()
    else tokenDialog?.close()
  })

  async function loadTokens() {
    loading = true
    try {
      tokens = await api.tokens()
    } finally {
      loading = false
    }
  }

  async function showTokens() {
    open = false
    tokensOpen = true
    created = undefined
    error = ''
    tokens = []
    try {
      await loadTokens()
    } catch (err) {
      error = (err as Error).message
    }
  }

  async function createToken(e: Event) {
    e.preventDefault()
    if (creating) return
    creating = true
    error = ''
    try {
      const t = await api.createToken(name.trim(), days)
      created = t.token
      name = ''
      await loadTokens()
    } catch (err) {
      error = (err as Error).message
    } finally {
      creating = false
    }
  }

  async function revokeToken(id: string) {
    if (revoking) return
    revoking = id
    error = ''
    try {
      await api.deleteToken(id)
      await loadTokens()
    } catch (err) {
      error = (err as Error).message
    } finally {
      revoking = ''
    }
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(created!)
    } catch {
      error = 'Could not copy the token. Select it and copy it manually.'
    }
  }

  async function logout() {
    await api.logout()
    location.reload()
  }

  const me = $derived(account.me)
</script>

{#if me?.auth}
  <div class="relative">
    <button bind:this={accountButton} class="btn btn-ghost px-2" onclick={() => (open = !open)} title={me.roles?.join(', ')}>
      <span class="grid size-6 place-items-center rounded-sm bg-sel text-[11px] font-semibold text-sel-ink ring-1 ring-sel-line">{(me.username ?? '?').slice(0, 1).toUpperCase()}</span>
      <span class="max-w-28 truncate">{me.username}</span>
    </button>
    {#if open}
      <div class="pop absolute top-full right-0 z-30 mt-1 w-56 py-1">
        <div class="mb-1 border-b border-line px-3 pt-1.5 pb-2 text-xs text-ink-2">Signed in as <b class="text-ink">{me.username}</b><br />{me.roles?.join(', ')}</div>
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover"
          onclick={showTokens}><KeyRound size={14} /> MCP tokens</button
        >
        {#if account.can('settings:write')}
          <a class="flex items-center gap-2 px-3 py-1.5 text-ink hover:bg-hover hover:no-underline" href="#/settings" onclick={() => (open = false)}><Settings size={14} /> Settings</a>
        {/if}
        {#if account.can('users:read')}
          <a class="flex items-center gap-2 px-3 py-1.5 text-ink hover:bg-hover hover:no-underline" href="#/settings/users" onclick={() => (open = false)}><UserCog size={14} /> Users</a>
        {/if}
        <a class="flex items-center gap-2 px-3 py-1.5 text-ink hover:bg-hover hover:no-underline" href="#/settings/about" onclick={() => (open = false)}><Info size={14} /> About &amp; MCP setup</a>
        <button class="flex w-full items-center gap-2 border-t border-line px-3 py-1.5 text-left hover:bg-hover" onclick={logout}><LogOut size={14} /> Sign out</button>
      </div>
    {/if}
  </div>

  <dialog
    bind:this={tokenDialog}
    class="pop mx-auto mt-[min(10dvh,5rem)] mb-auto max-h-[calc(100dvh-min(10dvh,5rem)-1rem)] w-[calc(100%-2rem)] max-w-lg overflow-hidden p-0 text-ink backdrop:bg-scrim open:flex open:flex-col"
    aria-labelledby="mcp-tokens-title"
    onclose={() => {
      tokensOpen = false
      accountButton?.focus()
    }}
    onclick={(e) => {
      if (e.target !== e.currentTarget) return
      const bounds = e.currentTarget.getBoundingClientRect()
      if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) tokensOpen = false
    }}
  >
    <div class="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
      <h2 id="mcp-tokens-title" class="font-semibold">MCP access tokens</h2>
      <button class="btn btn-ghost ml-auto shrink-0 px-1.5" aria-label="Close MCP access tokens" onclick={() => (tokensOpen = false)}><X size={15} /></button>
    </div>
    <div class="min-h-0 overflow-y-auto overscroll-contain p-4" data-token-scroll>
      <p class="mb-3 text-ink-2">
        Clients like Claude Code sign in by themselves (OAuth). For scripts or clients that can't, create a token and send it as
        <code class="text-xs">Authorization: Bearer …</code>.
      </p>
      <p class="mb-3 text-xs text-ink-2">Only your tokens are listed here. Apps can share a client registration, but each sign-in has its own token and your account's permissions.</p>
      <form class="mb-3 grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_auto]" onsubmit={createToken}>
        <input class="input col-span-2 sm:col-span-1" aria-label="Token name" placeholder="Name, e.g. laptop script" bind:value={name} required />
        <select class="input" aria-label="Token lifetime" bind:value={days}>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={365}>1 year</option>
          <option value={0}>never</option>
        </select>
        <button class="btn btn-primary shrink-0" disabled={!name.trim() || creating}>{creating ? 'Creating…' : 'Create'}</button>
      </form>
      {#if error}<p class="note danger mb-2" role="alert">{error}</p>{/if}
      {#if created}
        <div class="note ok mb-3 flex-col">
          <div class="text-xs">Copy it now; it is not shown again.</div>
          <div class="flex items-center gap-2">
            <code class="min-w-0 flex-1 break-all text-xs text-ink select-all">{created}</code>
            <button class="btn shrink-0 px-1.5" aria-label="Copy access token" onclick={copyToken}><Copy size={13} /></button>
          </div>
        </div>
      {/if}
      <ul class="panel divide-y divide-line" aria-label="Your access tokens" aria-busy={loading}>
        {#each tokens as t (t.id)}
          <li class="flex items-center gap-2 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="truncate">{t.name || t.client_id || 'token'}</div>
              <div class="text-xs text-ink-2">{t.client_id ? 'OAuth session' : 'personal'} · created {new Date(t.created_at).toLocaleDateString()}</div>
            </div>
            <button
              class="btn btn-ghost shrink-0 px-1.5"
              title="Revoke"
              aria-label={`Revoke ${t.name || t.client_id || 'token'}`}
              disabled={!!revoking}
              onclick={() => revokeToken(t.id)}><Trash2 size={14} /></button
            >
          </li>
        {:else}
          <li class="px-3 py-2 text-ink-2">{loading ? 'Loading your tokens…' : error ? 'Could not load your tokens. Close and reopen this window to retry.' : 'No tokens.'}</li>
        {/each}
      </ul>
    </div>
  </dialog>
{/if}
