<script lang="ts">
  import { Share2, Trash2, Users, X } from '@lucide/svelte'

  import { account } from '../lib/account.svelte'
  import { projectAccess } from '../lib/access.svelte'
  import { api, type Group, type GroupShare, type Member, type Project } from '../lib/api'

  let { project }: { project: Project } = $props()
  const access = projectAccess()

  let open = $state(false)
  let members = $state<Member[]>([])
  let users = $state<Member[]>([])
  let shares = $state<GroupShare[]>([])
  let groups = $state<Group[]>([])
  let pick = $state('')
  let role = $state<'viewer' | 'editor'>('editor')
  let error = $state('')

  async function load() {
    error = ''
    try {
      const r = await api.members(project.id)
      members = r.members
      shares = r.groups ?? []
      if (access.isOwner) [users, groups] = await Promise.all([api.users(), api.groups()])
    } catch (e) {
      error = (e as Error).message
    }
  }

  async function act(fn: () => Promise<void>) {
    error = ''
    try {
      await fn()
      await load()
    } catch (e) {
      error = (e as Error).message
    }
  }

  const candidates = $derived(users.filter((u) => !members.some((m) => m.user_id === u.user_id)))
  const groupCandidates = $derived(groups.filter((g) => !shares.some((x) => x.group_id === g.id)))

  // The picker holds a user id, or "g:" and a group id.
  function share() {
    const target = pick
    pick = ''
    act(() => (target.startsWith('g:') ? api.setProjectGroup(project.id, target.slice(2), role) : api.setMember(project.id, target, role)))
  }
</script>

<button
  class="btn"
  onclick={() => {
    open = true
    load()
  }}
  title={access.isOwner ? 'Share this project' : 'Who has access'}><Share2 size={14} /> Share</button
>

{#if open}
  <div class="fixed inset-0 z-40 grid place-items-center bg-scrim p-6" role="presentation" onclick={(e) => e.target === e.currentTarget && (open = false)}>
    <div class="pop w-full max-w-lg p-4">
      <div class="mb-2 flex items-center">
        <h2 class="font-semibold">Share “{project.name}”</h2>
        <button class="btn btn-ghost ml-auto px-1.5" onclick={() => (open = false)}><X size={15} /></button>
      </div>
      <p class="mb-3 text-ink-2">
        Editors change the design and use the assistant; viewers watch and export. Share with a group to give all its members access. Account roles still apply: a read-only account stays read-only.
      </p>

      {#if access.isOwner}
        <form
          class="mb-3 flex gap-2"
          onsubmit={(e) => {
            e.preventDefault()
            share()
          }}
        >
          <select class="input" bind:value={pick} required>
            <option value="" disabled>Choose a person or group…</option>
            {#if groupCandidates.length}
              <optgroup label="Groups">
                {#each groupCandidates as g (g.id)}<option value={`g:${g.id}`}>{g.name} · {g.members.length} {g.members.length === 1 ? 'person' : 'people'}</option>{/each}
              </optgroup>
            {/if}
            <optgroup label="People">
              {#each candidates as u (u.user_id)}<option value={u.user_id}>{u.username}{u.name && u.name !== u.username ? ` (${u.name})` : ''}</option>{/each}
            </optgroup>
          </select>
          <select class="input w-28 flex-none" bind:value={role}>
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
          </select>
          <button class="btn btn-primary shrink-0" disabled={!pick}>Add</button>
        </form>
      {/if}
      {#if error}<p class="note danger mb-2">{error}</p>{/if}

      <ul class="panel divide-y divide-line">
        {#each members as m (m.user_id)}
          <li class="flex items-center gap-2 px-3 py-2">
            <span class="grid size-6 place-items-center rounded-sm bg-sel text-[11px] font-semibold text-sel-ink ring-1 ring-sel-line">{m.username.slice(0, 1).toUpperCase()}</span>
            <div class="min-w-0 flex-1 truncate">{m.username}{#if m.user_id === account.me?.id}<span class="text-ink-2"> (you)</span>{/if}</div>
            {#if m.role === 'owner' || !access.isOwner}
              <span class="text-xs text-ink-2">{m.role}</span>
            {:else}
              <select class="input w-30 flex-none py-0.5 text-xs" value={m.role} onchange={(e) => act(() => api.setMember(project.id, m.user_id, (e.currentTarget as HTMLSelectElement).value as Member['role']))}>
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
                <option value="owner">make owner</option>
              </select>
            {/if}
            {#if m.role !== 'owner' && (access.isOwner || m.user_id === account.me?.id)}
              <button class="btn btn-ghost px-1.5" title={m.user_id === account.me?.id ? 'Leave' : 'Remove'} onclick={() => act(() => api.removeMember(project.id, m.user_id))}><Trash2 size={14} /></button>
            {/if}
          </li>
        {/each}
        {#each shares as g (g.group_id)}
          <li class="flex items-center gap-2 px-3 py-2">
            <span class="grid size-6 place-items-center rounded-sm border border-line-strong bg-surface-2 text-ink-2"><Users size={13} /></span>
            <div class="min-w-0 flex-1 truncate">{g.name} <span class="text-xs text-ink-3">group</span></div>
            {#if access.isOwner}
              <select class="input w-30 flex-none py-0.5 text-xs" value={g.role} onchange={(e) => act(() => api.setProjectGroup(project.id, g.group_id, (e.currentTarget as HTMLSelectElement).value as GroupShare['role']))}>
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
              </select>
              <button class="btn btn-ghost px-1.5" title="Remove" aria-label={`Stop sharing with ${g.name}`} onclick={() => act(() => api.removeProjectGroup(project.id, g.group_id))}><Trash2 size={14} /></button>
            {:else}
              <span class="text-xs text-ink-2">{g.role}</span>
            {/if}
          </li>
        {/each}
        {#if !members.length && !shares.length}
          <li class="px-3 py-2 text-ink-2">Open to everyone with an account (made before sharing).</li>
        {/if}
      </ul>
    </div>
  </div>
{/if}
