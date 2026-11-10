<script lang="ts">
  import { Check, Pencil, Plus, Search, Trash2, Users, X } from '@lucide/svelte'
  import { onMount } from 'svelte'

  import { account } from '../../lib/account.svelte'
  import { api, type AdminUser, type Group } from '../../lib/api'

  let groups = $state<Group[]>([])
  let people = $state<AdminUser[]>([])
  let loading = $state(true)
  let error = $state('')

  /** Inline editor: a group id, "new", or nothing. */
  let editing = $state<string>()
  let form = $state({ name: '', description: '', members: [] as string[] })
  let filter = $state('')
  let busy = $state(false)
  let formError = $state('')
  let confirmDelete = $state<string>()

  const canWrite = $derived(account.can('users:write'))
  const shownPeople = $derived.by(() => {
    const w = filter.trim().toLowerCase()
    return people.filter((u) => !w || `${u.username} ${u.name ?? ''} ${u.email ?? ''}`.toLowerCase().includes(w))
  })

  async function load() {
    try {
      ;[groups, people] = await Promise.all([api.groups(), api.adminUsers()])
      people.sort((a, b) => a.username.localeCompare(b.username))
      error = ''
    } catch (e) {
      error = (e as Error).message
    } finally {
      loading = false
    }
  }

  onMount(load)

  function start(g?: Group) {
    editing = g?.id ?? 'new'
    formError = ''
    filter = ''
    form = { name: g?.name ?? '', description: g?.description ?? '', members: g?.members.map((m) => m.user_id) ?? [] }
  }

  function toggle(id: string) {
    form.members = form.members.includes(id) ? form.members.filter((x) => x !== id) : [...form.members, id]
  }

  async function submit(e: Event) {
    e.preventDefault()
    busy = true
    formError = ''
    try {
      await api.saveGroup(editing === 'new' ? undefined : editing, { name: form.name.trim(), description: form.description.trim(), members: form.members })
      editing = undefined
      await load()
    } catch (err) {
      formError = (err as Error).message
    } finally {
      busy = false
    }
  }

  async function remove(g: Group) {
    confirmDelete = undefined
    try {
      await api.deleteGroup(g.id)
      await load()
    } catch (err) {
      error = (err as Error).message
    }
  }
</script>

<header class="mb-5 flex items-end gap-3">
  <div class="mr-auto">
    <h2 class="text-lg font-semibold">Groups</h2>
    <p class="text-ink-2">Share a project with a group to give everyone in it access. SSO providers can fill groups from their claims.</p>
  </div>
  {#if canWrite && editing !== 'new'}<button class="btn btn-primary" onclick={() => start()}><Plus size={14} /> New group</button>{/if}
</header>

{#if error}<p class="note danger mb-3">{error}</p>{/if}

<ul class="panel divide-y divide-line overflow-hidden">
  {#if editing === 'new'}
    <li class="corners bg-surface-2 p-4">{@render editor()}</li>
  {/if}
  {#if loading}
    {#each { length: 2 } as _, i (i)}<li class="h-14 skeleton"></li>{/each}
  {/if}
  {#each groups as g (g.id)}
    {#if editing === g.id}
      <li class="corners bg-surface-2 p-4">{@render editor()}</li>
    {:else}
      <li class="flex items-center gap-3 px-4 py-2.5">
        <span class="grid size-7 shrink-0 place-items-center rounded-sm border border-line-strong bg-surface-2 text-ink-2"><Users size={14} /></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="font-medium">{g.name}</span>
            <span class="badge num">{g.members.length} {g.members.length === 1 ? 'member' : 'members'}</span>
          </div>
          <div class="truncate text-xs text-ink-2">
            {[g.description, g.members.map((m) => m.username).join(', ')].filter(Boolean).join(' · ') || 'No members yet'}
          </div>
        </div>
        {#if canWrite}
          {#if confirmDelete === g.id}
            <span class="flex shrink-0 items-center gap-1.5 text-xs">
              Delete {g.name}? Projects shared with it lose that share.
              <button class="btn btn-danger py-0.5" onclick={() => remove(g)}>Delete</button>
              <button class="btn py-0.5" onclick={() => (confirmDelete = undefined)}>Keep</button>
            </span>
          {:else}
            <span class="flex shrink-0">
              <button class="btn btn-ghost px-1.5" title="Edit" aria-label={`Edit ${g.name}`} onclick={() => start(g)}><Pencil size={14} /></button>
              <button class="btn btn-ghost px-1.5 hover:text-danger" title="Delete" aria-label={`Delete ${g.name}`} onclick={() => (confirmDelete = g.id)}><Trash2 size={14} /></button>
            </span>
          {/if}
        {/if}
      </li>
    {/if}
  {:else}
    {#if !loading && editing !== 'new'}
      <li class="px-4 py-8 text-center text-ink-2">
        <p class="font-medium text-ink">No groups yet.</p>
        <p class="mt-1">Make one for a team, then share projects with it from the project's Share button.</p>
      </li>
    {/if}
  {/each}
</ul>

{#snippet editor()}
  <form class="grid gap-3" onsubmit={submit}>
    <div class="grid grid-cols-2 gap-3">
      <label class="grid gap-1">
        <span class="text-xs font-medium">Name</span>
        <input class="input" bind:value={form.name} required maxlength="64" placeholder="e.g. Hardware team" autocomplete="off" />
      </label>
      <label class="grid gap-1">
        <span class="text-xs font-medium">Description</span>
        <input class="input" bind:value={form.description} placeholder="Optional" autocomplete="off" />
      </label>
    </div>
    <fieldset>
      <legend class="mb-1 flex w-full items-center gap-2 text-xs font-medium">
        Members <span class="num font-normal text-ink-3">{form.members.length} selected</span>
      </legend>
      {#if people.length > 8}
        <label class="relative mb-2 block">
          <Search size={13} class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3" />
          <input class="input pl-8" type="search" placeholder="Filter people" bind:value={filter} aria-label="Filter people" />
        </label>
      {/if}
      <div class="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto">
        {#each shownPeople as u (u.id)}
          {@const on = form.members.includes(u.id)}
          <button
            type="button"
            class={['flex min-w-0 items-center gap-2 border px-2 py-1.5 text-left', on ? 'border-sel-line bg-sel text-sel-ink' : 'border-line-strong bg-surface hover:bg-hover']}
            aria-pressed={on}
            onclick={() => toggle(u.id)}
          >
            <span class={['grid size-3.5 shrink-0 place-items-center border', on ? 'border-cta-edge bg-cta text-cta-ink' : 'border-control bg-surface']}>
              {#if on}<Check size={10} strokeWidth={3} />{/if}
            </span>
            <span class="min-w-0 truncate"><span class="font-medium">{u.username}</span> <span class={['text-xs', on ? 'text-sel-ink' : 'text-ink-3']}>{u.name ?? ''}</span></span>
          </button>
        {/each}
      </div>
    </fieldset>
    {#if formError}<p class="note danger">{formError}</p>{/if}
    <div class="flex justify-end gap-2">
      <button type="button" class="btn" onclick={() => (editing = undefined)}><X size={13} /> Cancel</button>
      <button class="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? 'Saving…' : editing === 'new' ? 'Create group' : 'Save'}</button>
    </div>
  </form>
{/snippet}
