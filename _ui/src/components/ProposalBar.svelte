<script lang="ts">
  import { Check, GitBranch, X } from '@lucide/svelte'

  import { diffDocs } from '../engine/diff'
  import type { Session } from '../lib/session.svelte'

  let { session }: { session: Session } = $props()

  let busy = $state(false)
  let error = $state('')
  let open = $state(false)

  const changes = $derived(session.mainDoc && session.branch ? diffDocs(session.mainDoc, session.doc) : [])

  async function act(fn: () => Promise<void>) {
    busy = true
    error = ''
    try {
      await fn()
    } catch (e) {
      error = (e as Error).message
    } finally {
      busy = false
    }
  }
</script>

{#if session.proposal}
  <div class="hatched relative z-10 flex items-center gap-2 border-b border-sel-line bg-sel px-3 py-1.5 text-[13px] text-sel-ink">
    <GitBranch size={14} class="shrink-0" />
    <span class="font-medium">Proposal</span>
    <span class="truncate">{session.proposal.name}</span>
    {#if session.branch}
      <button class="underline-offset-2 hover:underline" onclick={() => (open = !open)}>
        {changes.length} change{changes.length === 1 ? '' : 's'}
      </button>
      <button class="hover:underline" onclick={() => session.switchBranch(undefined)}>view current design</button>
    {:else}
      <button class="underline-offset-2 hover:underline" onclick={() => session.switchBranch(session.proposal!.id)}>review</button>
    {/if}
    {#if error}<span class="truncate text-danger">{error}</span>{/if}
    <span class="ml-auto"></span>
    <button class="btn btn-danger bg-surface" disabled={busy} onclick={() => act(() => session.reject())}><X size={13} /> Reject</button>
    <button class="btn btn-primary" disabled={busy || !session.branch} onclick={() => act(() => session.accept())} title={session.branch ? '' : 'Open the proposal to accept it'}>
      <Check size={13} /> Accept
    </button>

    {#if open && session.branch}
      <div class="absolute top-full left-3 mt-1 max-h-80 w-[420px] overflow-y-auto pop p-2 text-ink">
        {#each changes as c, i (i)}
          <div class="flex gap-2 py-0.5 text-xs">
            <span class={['w-14 shrink-0 font-mono', c.kind === 'added' ? 'text-ok' : c.kind === 'removed' ? 'text-danger' : 'text-warn']}>{c.kind}</span>
            <span class="font-medium">{c.what}</span>
            {#if c.detail}<span class="truncate text-ink-2">{c.detail}</span>{/if}
          </div>
        {:else}
          <div class="text-xs text-ink-2">No changes yet.</div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
