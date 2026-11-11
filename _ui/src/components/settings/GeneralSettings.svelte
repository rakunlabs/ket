<script lang="ts">
  import { onMount } from 'svelte'

  import { settings } from '../../lib/settings.svelte'

  let publicURL = $state('')
  let signup = $state(false)
  let defaultRole = $state('editor')
  let saving = $state(false)
  let saved = $state(false)
  let error = $state('')

  function fill() {
    const c = settings.current
    if (!c) return
    publicURL = c.public_url ?? ''
    signup = c.signup
    defaultRole = c.default_role
  }

  onMount(async () => {
    if (!settings.current) await settings.load()
    fill()
  })

  const dirty = $derived.by(() => {
    const c = settings.current
    if (!c) return false
    return publicURL !== (c.public_url ?? '') || signup !== c.signup || defaultRole !== c.default_role
  })

  async function save(e: Event) {
    e.preventDefault()
    if (!settings.current || saving) return
    saving = true
    error = ''
    try {
      await settings.save({
        ...settings.current,
        public_url: publicURL.trim().replace(/\/+$/, ''),
        signup,
        default_role: defaultRole,
      })
      fill()
      saved = true
      setTimeout(() => (saved = false), 2000)
    } catch (err) {
      error = (err as Error).message
    } finally {
      saving = false
    }
  }
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold">Access & server</h2>
  <p class="text-ink-2">Who may create an account, and how people reach this server.</p>
</header>

{#if settings.current}
  <form class="grid gap-6" onsubmit={save}>
    <fieldset class="grid gap-3">
      <legend class="mb-1 font-semibold">Sign-up</legend>
      <label class="flex items-start gap-2.5">
        <input type="checkbox" bind:checked={signup} class="mt-0.5" />
        <span>
          Anyone can create an account on the login page
          <span class="block text-xs text-ink-2">Off: only administrators add people, in Users.</span>
        </span>
      </label>
      <label class="flex items-center gap-3">
        <span>Role of new accounts</span>
        <select class="input w-48" bind:value={defaultRole}>
          {#each settings.roles.filter((r) => r.name !== 'admin') as r (r.name)}
            <option value={r.name}>{r.name}</option>
          {/each}
        </select>
      </label>
      <p class="-mt-1 text-xs text-ink-2">
        {settings.roles.find((r) => r.name === defaultRole)?.description ?? ''}. Projects stay private to their owner until shared.
      </p>
    </fieldset>

    <fieldset class="grid gap-1.5">
      <legend class="mb-1 font-semibold">Public URL</legend>
      <input class="input font-mono" bind:value={publicURL} placeholder="https://ket.example.com" />
      <p class="text-xs text-ink-2">
        How people and MCP clients reach Ket, including any path prefix. Leave empty to use the address each request comes in on (fine on one machine or a LAN). Set it behind
        a reverse proxy. Sign-in links for MCP clients use it after a restart.
      </p>
    </fieldset>

    {#if error}<p class="note danger">{error}</p>{/if}
    <div class="flex items-center gap-3 border-t border-line pt-4">
      <button class="btn btn-primary" disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</button>
      {#if dirty}<button type="button" class="btn" onclick={fill}>Discard</button>{/if}
      {#if saved}<span class="text-ok" role="status">Saved</span>{/if}
    </div>
  </form>
{:else if settings.error}
  <p class="note danger">{settings.error}</p>
{:else}
  <div class="h-40 skeleton rounded-sm"></div>
{/if}
