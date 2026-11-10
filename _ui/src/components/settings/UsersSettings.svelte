<script lang="ts">
  import { Ban, Check, KeyRound, Link2Off, LogIn, Pencil, Plus, RotateCcw, Search, Trash2, X } from '@lucide/svelte'
  import { onMount } from 'svelte'

  import { account } from '../../lib/account.svelte'
  import { api, type AdminUser, type Group, type LinkedIdentity } from '../../lib/api'
  import { settings } from '../../lib/settings.svelte'

  let users = $state<AdminUser[]>([])
  let loading = $state(true)
  let error = $state('')
  let q = $state('')

  /** Inline editor: a user id, "new", or nothing. */
  let editing = $state<string>()
  let form = $state({ username: '', name: '', email: '', password: '', roles: [] as string[], groups: [] as string[] })
  let groups = $state<Group[]>([])
  let links = $state<LinkedIdentity[]>([])
  let busy = $state(false)
  let formError = $state('')
  let confirmDelete = $state<string>()

  const canWrite = $derived(account.can('users:write'))
  const shown = $derived.by(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return users.filter((u) => words.every((w) => `${u.username} ${u.name ?? ''} ${u.email ?? ''} ${u.roles.join(' ')}`.toLowerCase().includes(w)))
  })

  async function load() {
    try {
      ;[users, groups] = await Promise.all([api.adminUsers(), api.groups()])
      users.sort((a, b) => a.username.localeCompare(b.username))
      error = ''
    } catch (e) {
      error = (e as Error).message
    } finally {
      loading = false
    }
  }

  onMount(async () => {
    if (!settings.roles.length) await settings.load()
    await load()
  })

  function startNew() {
    editing = 'new'
    formError = ''
    links = []
    form = { username: '', name: '', email: '', password: '', roles: [settings.current?.default_role ?? 'editor'], groups: [] }
  }

  async function startEdit(u: AdminUser) {
    editing = u.id
    formError = ''
    links = []
    form = { username: u.username, name: u.name ?? '', email: u.email ?? '', password: '', roles: [...u.roles], groups: [] }
    try {
      const a = await api.userAccess(u.id)
      if (editing === u.id) {
        form.groups = a.groups
        links = a.identities
      }
    } catch (err) {
      formError = (err as Error).message
    }
  }

  function groupsOf(u: AdminUser) {
    return groups.filter((g) => g.members.some((m) => m.user_id === u.id))
  }

  async function unlink(l: LinkedIdentity) {
    try {
      await api.unlinkIdentity(editing!, l.provider, l.subject)
      links = links.filter((x) => x !== l)
    } catch (err) {
      formError = (err as Error).message
    }
  }

  async function submit(e: Event) {
    e.preventDefault()
    busy = true
    formError = ''
    try {
      if (editing === 'new') {
        const created = (await api.adminUser('POST', undefined, { username: form.username.trim(), password: form.password, name: form.name.trim(), email: form.email.trim(), roles: form.roles })) as AdminUser
        if (form.groups.length) await api.setUserGroups(created.id, form.groups)
      } else {
        await api.setUserGroups(editing!, form.groups)
        await api.adminUser('PATCH', editing, {
          name: form.name.trim(),
          email: form.email.trim(),
          roles: form.roles,
          ...(form.password ? { password: form.password } : {}),
        })
      }
      editing = undefined
      await load()
    } catch (err) {
      formError = (err as Error).message
    } finally {
      busy = false
    }
  }

  async function act(fn: () => Promise<unknown>) {
    error = ''
    try {
      await fn()
      await load()
    } catch (err) {
      error = (err as Error).message
    }
  }

  function toggleRole(r: string) {
    form.roles = form.roles.includes(r) ? form.roles.filter((x) => x !== r) : [...form.roles, r]
  }

  const when = (v: AdminUser['created_at']) => (v ? new Date(typeof v === 'number' ? v : v).toLocaleDateString() : '')
</script>

<header class="mb-5 flex items-end gap-3">
  <div class="mr-auto">
    <h2 class="text-lg font-semibold">Users</h2>
    <p class="text-ink-2">Accounts, their roles and groups. Project access is shared per project by its owner, with people or groups.</p>
  </div>
  {#if canWrite && editing !== 'new'}<button class="btn btn-primary" onclick={startNew}><Plus size={14} /> Add user</button>{/if}
</header>

{#if error}<p class="note danger mb-3">{error}</p>{/if}

{#if users.length > 8}
  <label class="relative mb-3 block">
    <Search size={14} class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-2" />
    <input class="input pl-8" type="search" placeholder="Search users" bind:value={q} aria-label="Search users" />
  </label>
{/if}

<ul class="panel divide-y divide-line overflow-hidden">
  {#if editing === 'new'}
    <li class="corners bg-surface-2 p-4">{@render editor()}</li>
  {/if}
  {#if loading}
    {#each { length: 3 } as _, i (i)}<li class="h-14 skeleton"></li>{/each}
  {/if}
  {#each shown as u (u.id)}
    {#if editing === u.id}
      <li class="corners bg-surface-2 p-4">{@render editor()}</li>
    {:else}
      <li class={['flex items-center gap-3 px-4 py-2.5', u.disabled && 'opacity-60']}>
        <span class="grid size-7 shrink-0 place-items-center rounded-sm bg-sel text-[11px] font-semibold text-sel-ink ring-1 ring-sel-line">{u.username.slice(0, 1).toUpperCase()}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="font-medium">{u.username}</span>
            {#if u.id === account.me?.id}<span class="text-xs text-ink-2">you</span>{/if}
            {#if u.disabled}<span class="badge"><span class="sq idle"></span>disabled</span>{/if}
          </div>
          <div class="truncate text-xs text-ink-2">
            {[u.name, u.email, groupsOf(u).length && `in ${groupsOf(u).map((g) => g.name).join(', ')}`, when(u.created_at) && `since ${when(u.created_at)}`].filter(Boolean).join(' · ')}
          </div>
        </div>
        <span class="flex shrink-0 gap-1">
          {#each u.roles as r (r)}
            <span class={['badge', r === 'admin' && 'accent']}>{r}</span>
          {/each}
        </span>
        {#if canWrite}
          {#if confirmDelete === u.id}
            <span class="flex shrink-0 items-center gap-1.5 text-xs">
              Delete {u.username}?
              <button class="btn btn-danger py-0.5" onclick={() => ((confirmDelete = undefined), act(() => api.adminUser('DELETE', u.id)))}>Delete</button>
              <button class="btn py-0.5" onclick={() => (confirmDelete = undefined)}>Keep</button>
            </span>
          {:else}
            <span class="flex shrink-0">
              <button class="btn btn-ghost px-1.5" title="Edit" aria-label={`Edit ${u.username}`} onclick={() => startEdit(u)}><Pencil size={14} /></button>
              {#if u.id !== account.me?.id}
                <button
                  class="btn btn-ghost px-1.5"
                  title={u.disabled ? 'Enable' : 'Disable: signs them out and blocks sign-in'}
                  aria-label={`${u.disabled ? 'Enable' : 'Disable'} ${u.username}`}
                  onclick={() => act(() => api.adminUser('PATCH', u.id, { disabled: !u.disabled }))}
                  >{#if u.disabled}<RotateCcw size={14} />{:else}<Ban size={14} />{/if}</button
                >
                <button class="btn btn-ghost px-1.5 hover:text-danger" title="Delete" aria-label={`Delete ${u.username}`} onclick={() => (confirmDelete = u.id)}><Trash2 size={14} /></button>
              {/if}
            </span>
          {/if}
        {/if}
      </li>
    {/if}
  {:else}
    {#if !loading && q}<li class="px-4 py-6 text-center text-ink-2">No user matches “{q}”.</li>{/if}
  {/each}
</ul>

{#snippet editor()}
  <form class="grid gap-3" onsubmit={submit}>
    <div class="grid grid-cols-2 gap-3">
      <label class="grid gap-1">
        <span class="text-xs font-medium">Username</span>
        <input class="input" bind:value={form.username} required disabled={editing !== 'new'} autocomplete="off" />
      </label>
      <label class="grid gap-1">
        <span class="flex items-center gap-1 text-xs font-medium"><KeyRound size={12} /> {editing === 'new' ? 'Password' : 'New password'}</span>
        <input class="input" type="password" bind:value={form.password} minlength="8" autocomplete="new-password" placeholder={editing === 'new' ? 'Empty: signs in with SSO only' : 'Leave empty to keep'} />
      </label>
      <label class="grid gap-1">
        <span class="text-xs font-medium">Name</span>
        <input class="input" bind:value={form.name} autocomplete="off" />
      </label>
      <label class="grid gap-1">
        <span class="text-xs font-medium">Email</span>
        <input class="input" type="email" bind:value={form.email} autocomplete="off" />
      </label>
    </div>
    <fieldset>
      <legend class="mb-1 text-xs font-medium">Roles</legend>
      <div class="flex flex-wrap gap-2">
        {#each settings.roles as r (r.name)}
          <button
            type="button"
            class={['flex items-center gap-1.5 border px-2.5 py-1.5 text-left', form.roles.includes(r.name) ? 'border-sel-line bg-sel text-sel-ink' : 'border-line-strong bg-surface hover:bg-hover']}
            aria-pressed={form.roles.includes(r.name)}
            onclick={() => toggleRole(r.name)}
          >
            <span class={['grid size-3.5 place-items-center border', form.roles.includes(r.name) ? 'border-cta-edge bg-cta text-cta-ink' : 'border-line-strong bg-surface']}>
              {#if form.roles.includes(r.name)}<Check size={10} strokeWidth={3} />{/if}
            </span>
            <span><span class="font-medium">{r.name}</span> <span class={['text-xs', form.roles.includes(r.name) ? 'text-sel-ink' : 'text-ink-2']}>{r.description ?? ''}</span></span>
          </button>
        {/each}
      </div>
    </fieldset>
    {#if groups.length}
      <fieldset>
        <legend class="mb-1 text-xs font-medium">Groups</legend>
        <div class="flex flex-wrap gap-2">
          {#each groups as g (g.id)}
            {@const on = form.groups.includes(g.id)}
            <button
              type="button"
              class={['flex items-center gap-1.5 border px-2.5 py-1 text-left', on ? 'border-sel-line bg-sel text-sel-ink' : 'border-line-strong bg-surface hover:bg-hover']}
              aria-pressed={on}
              onclick={() => (form.groups = on ? form.groups.filter((x) => x !== g.id) : [...form.groups, g.id])}
            >
              <span class={['grid size-3.5 place-items-center border', on ? 'border-cta-edge bg-cta text-cta-ink' : 'border-control bg-surface']}>
                {#if on}<Check size={10} strokeWidth={3} />{/if}
              </span>
              {g.name}
            </button>
          {/each}
        </div>
      </fieldset>
    {/if}
    {#if links.length}
      <fieldset>
        <legend class="mb-1 text-xs font-medium">Signs in with</legend>
        <ul class="panel divide-y divide-line">
          {#each links as l (l.provider + l.subject)}
            <li class="flex items-center gap-2 px-3 py-1.5 text-xs">
              <LogIn size={13} class="text-ink-3" />
              <span class="font-medium">{l.provider}</span>
              <span class="min-w-0 flex-1 truncate text-ink-2">{l.email || l.subject} · last {new Date(l.last_login).toLocaleDateString()}</span>
              <button type="button" class="btn btn-ghost px-1.5 py-0.5 hover:text-danger" title="Unlink: the next sign-in with it is treated as new" onclick={() => unlink(l)}><Link2Off size={13} /> Unlink</button>
            </li>
          {/each}
        </ul>
      </fieldset>
    {/if}
    {#if formError}<p class="note danger">{formError}</p>{/if}
    <div class="flex justify-end gap-2">
      <button type="button" class="btn" onclick={() => (editing = undefined)}><X size={13} /> Cancel</button>
      <button class="btn btn-primary" disabled={busy || !form.username.trim() || !form.roles.length}>{busy ? 'Saving…' : editing === 'new' ? 'Add user' : 'Save'}</button>
    </div>
  </form>
{/snippet}
