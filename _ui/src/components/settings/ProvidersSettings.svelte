<script lang="ts">
  import { Bot, Check, Eye, KeyRound, LoaderCircle, Pencil, Plus, Star, Trash2, X, Zap } from '@lucide/svelte'
  import { onMount } from 'svelte'

  import { api, type ProviderIn, type UsageRow } from '../../lib/api'
  import { settings } from '../../lib/settings.svelte'

  /** Presets fill the base URL for common services; any OpenAI-compatible URL works. */
  const PRESETS = [
    { label: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-4.1', vision: true, key: true },
    { label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4', vision: true, key: true },
    { label: 'Ollama (local)', base_url: 'http://localhost:11434/v1', model: 'qwen3:14b', vision: false, key: false },
    { label: 'Other', base_url: '', model: '', vision: false, key: true },
  ]

  type Draft = ProviderIn & { has_key: boolean; clear: boolean }

  /** The provider being edited: its index, or -1 for a new one. */
  let editing = $state<number>()
  let draft = $state<Draft>({ name: '', base_url: '', model: '', vision: false, api_key: '', has_key: false, clear: false })
  let saving = $state(false)
  let formError = $state('')
  let test = $state<{ ok: boolean; message: string; busy?: boolean }>()
  let steps = $state(40)
  let compact = $state(60000)
  let monthly = $state(0)
  let usage = $state<{ rows: UsageRow[]; days: number }>()
  const users = $derived(Object.values((usage?.rows ?? []).reduce((acc, r) => {
    const k = r.user || '(no account)'
    const e = (acc[k] ??= { user: k, requests: 0, tokens: 0, estimated: false })
    e.requests += r.requests
    e.tokens += r.prompt_tokens + r.completion_tokens
    e.estimated ||= !!r.estimated
    return acc
  }, {} as Record<string, { user: string; requests: number; tokens: number; estimated: boolean }>)).sort((a, b) => b.tokens - a.tokens))

  const providers = $derived(settings.current?.providers ?? [])

  onMount(async () => {
    if (!settings.current) await settings.load()
    steps = settings.current?.max_steps ?? 40
    compact = settings.current?.compact_tokens ?? 60000
    monthly = settings.current?.monthly_tokens ?? 0
    try {
      usage = await api.usage(30)
    } catch {
      // older server
    }
  })

  function startNew(preset = PRESETS[0]) {
    editing = -1
    test = undefined
    formError = ''
    let name = preset.label === 'Other' ? '' : preset.label.replace(/ \(local\)$/, '').toLowerCase()
    while (name && providers.some((p) => p.name === name)) name += '-2'
    draft = { name, base_url: preset.base_url, model: preset.model, vision: preset.vision, api_key: '', has_key: false, clear: false }
  }

  function startEdit(i: number) {
    const p = providers[i]
    editing = i
    test = undefined
    formError = ''
    draft = { ...p, api_key: '', clear: false }
  }

  function cancel() {
    editing = undefined
    test = undefined
  }

  async function persist(list: (ProviderIn & { has_key?: boolean })[], clear: string[] = [], defaultProvider = settings.current?.default_provider) {
    await settings.save({ ...settings.current!, providers: list, default_provider: defaultProvider, max_steps: steps, compact_tokens: compact, monthly_tokens: monthly }, clear)
  }

  async function saveDraft(e: Event) {
    e.preventDefault()
    if (saving) return
    formError = ''
    const list = providers.map((p) => ({ ...p })) as (ProviderIn & { has_key?: boolean })[]
    const old = editing! >= 0 ? providers[editing!] : undefined
    const entry = {
      name: draft.name,
      previous_name: old?.name,
      base_url: draft.base_url,
      model: draft.model,
      vision: draft.vision,
      api_key: draft.api_key,
      temperature: draft.temperature,
    }
    if (old) list[editing!] = entry
    else list.push(entry)
    const clear = draft.clear ? [draft.name] : []
    saving = true
    try {
      let def = settings.current?.default_provider
      if (old && def === old.name) def = draft.name
      if (!def && list.length === 1) def = draft.name
      await persist(list, clear, def)
      editing = undefined
    } catch (err) {
      formError = (err as Error).message
    } finally {
      saving = false
    }
  }

  async function remove(i: number) {
    const name = providers[i].name
    if (!confirm(`Remove the provider “${name}”? Chats using it switch to the default.`)) return
    try {
      await persist(
        providers.filter((_, j) => j !== i),
        [],
        settings.current?.default_provider === name ? undefined : settings.current?.default_provider,
      )
    } catch (err) {
      settings.error = (err as Error).message
    }
  }

  async function makeDefault(name: string) {
    try {
      await persist([...providers], [], name)
    } catch (err) {
      settings.error = (err as Error).message
    }
  }

  async function runTest() {
    test = { ok: false, message: '', busy: true }
    try {
      const old = editing !== undefined && editing >= 0 ? providers[editing] : undefined
      test = await api.testProvider({ name: old?.name ?? draft.name, base_url: draft.base_url, model: draft.model, vision: draft.vision, api_key: draft.clear ? undefined : draft.api_key || undefined })
    } catch (err) {
      test = { ok: false, message: (err as Error).message }
    }
  }

  async function saveSteps() {
    try {
      await persist([...providers])
    } catch (err) {
      settings.error = (err as Error).message
    }
  }

  const valid = $derived(draft.name.trim() && draft.model.trim() && /^https?:\/\//.test(draft.base_url.trim()))
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold">AI providers</h2>
  <p class="text-ink-2">The built-in assistant talks to any OpenAI-compatible endpoint. Keys stay on the server, encrypted; nobody can read them back here.</p>
</header>

{#if settings.error}<p class="note danger mb-3">{settings.error}</p>{/if}

{#if settings.loading && !settings.current}
  <div class="h-24 skeleton rounded-sm"></div>
{:else}
  <ul class="panel divide-y divide-line overflow-hidden">
    {#each providers as p, i (p.name)}
      {#if editing === i}
        <li class="corners bg-surface-2 p-4">{@render form()}</li>
      {:else}
        <li class="flex items-center gap-3 px-4 py-3">
          <Bot size={16} class="shrink-0 text-ink-2" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="font-medium">{p.name}</span>
              {#if settings.current?.default_provider === p.name || (!settings.current?.default_provider && i === 0)}
                <span class="badge accent">default</span>
              {/if}
              {#if p.vision}<span class="flex items-center gap-0.5 text-[11px] text-ink-2" title="Sees render screenshots"><Eye size={11} /> vision</span>{/if}
            </div>
            <div class="truncate text-xs text-ink-2">
              <span class="font-mono">{p.model}</span> · {p.base_url}
              · {#if p.has_key}<span class="text-ok">key set</span>{:else}<span class="text-warn">no key</span>{/if}
            </div>
          </div>
          {#if settings.current?.default_provider !== p.name && providers.length > 1}
            <button class="btn btn-ghost px-2 text-xs" onclick={() => makeDefault(p.name)} title="Use when a chat picks none"><Star size={12} /> Make default</button>
          {/if}
          <button class="btn btn-ghost px-1.5" onclick={() => startEdit(i)} aria-label={`Edit ${p.name}`} disabled={editing !== undefined}><Pencil size={14} /></button>
          <button class="btn btn-ghost px-1.5 hover:text-danger" onclick={() => remove(i)} aria-label={`Remove ${p.name}`} disabled={editing !== undefined}><Trash2 size={14} /></button>
        </li>
      {/if}
    {/each}
    {#if editing === -1}
      <li class="corners bg-surface-2 p-4">{@render form()}</li>
    {/if}
    {#if !providers.length && editing === undefined}
      <li class="px-4 py-8 text-center">
        <p class="font-medium">No provider yet</p>
        <p class="mt-1 mb-4 text-ink-2">Add one so people can use the assistant. Pick a service to start from:</p>
        <div class="flex flex-wrap justify-center gap-2">
          {#each PRESETS as preset (preset.label)}
            <button class="btn" onclick={() => startNew(preset)}>{preset.label}</button>
          {/each}
        </div>
      </li>
    {/if}
  </ul>

  {#if providers.length && editing === undefined}
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <span class="text-ink-2">Add a provider:</span>
      {#each PRESETS as preset (preset.label)}
        <button class="btn" onclick={() => startNew(preset)}><Plus size={13} /> {preset.label}</button>
      {/each}
    </div>
  {/if}

  <section class="mt-8 border-t border-line pt-5">
    <h3 class="font-semibold">Assistant limits</h3>
    <label class="mt-2 flex items-center gap-3">
      <span class="text-ink-2">Tool rounds per message</span>
      <input class="input w-24" type="number" min="1" max="500" bind:value={steps} />
      <button class="btn" disabled={steps === settings.current?.max_steps || steps < 1 || steps > 500} onclick={saveSteps}>Save</button>
    </label>
    <p class="mt-1 text-xs text-ink-2">The assistant stops after this many tool-calling rounds and asks to continue. It bounds what one message can cost.</p>
    <label class="mt-3 flex items-center gap-3">
      <span class="text-ink-2">Summarize history past</span>
      <input class="input w-28" type="number" min="4000" max="2000000" step="1000" bind:value={compact} />
      <span class="text-ink-2">tokens</span>
      <button class="btn" disabled={compact === settings.current?.compact_tokens || compact < 4000} onclick={saveSteps}>Save</button>
    </label>
    <p class="mt-1 text-xs text-ink-2">Long conversations get their older turns summarized by the model, so each request stays small. The design itself is always read fresh.</p>
    <label class="mt-3 flex items-center gap-3">
      <span class="text-ink-2">Tokens per user per month</span>
      <input class="input w-32" type="number" min="0" step="10000" bind:value={monthly} />
      <button class="btn" disabled={monthly === settings.current?.monthly_tokens || monthly < 0} onclick={saveSteps}>Save</button>
    </label>
    <p class="mt-1 text-xs text-ink-2">0 means no limit. When a user reaches it the assistant stops and says so until the next month (UTC).</p>
  </section>

  <section class="mt-8 border-t border-line pt-5">
    <h3 class="font-semibold">Usage, last {usage?.days ?? 30} days</h3>
    {#if !usage?.rows.length}
      <p class="mt-2 text-xs text-ink-2">No assistant requests yet.</p>
    {:else}
      <table class="mt-2 w-full text-xs">
        <thead><tr class="text-left text-ink-2"><th class="py-1">User</th><th class="text-right">Requests</th><th class="text-right">Tokens</th>{#if monthly}<th class="text-right">Of monthly limit</th>{/if}</tr></thead>
        <tbody>
          {#each users as u (u.user)}
            <tr class="border-t border-line"><td class="py-1 font-mono">{u.user}</td><td class="num text-right">{u.requests}</td><td class="num text-right">{u.tokens.toLocaleString()}{u.estimated ? ' *' : ''}</td>{#if monthly}<td class="num text-right">{Math.round((u.tokens / monthly) * 100)}%</td>{/if}</tr>
          {/each}
        </tbody>
      </table>
      {#if users.some((u) => u.estimated)}<p class="mt-1 text-xs text-ink-2">* includes estimates for providers that do not report usage.</p>{/if}
    {/if}
  </section>
{/if}

{#snippet form()}
  <form class="grid gap-3" onsubmit={saveDraft}>
    <div class="grid grid-cols-2 gap-3">
      <label class="grid gap-1">
        <span class="text-xs font-medium">Name</span>
        <input class="input" bind:value={draft.name} placeholder="openai" required />
      </label>
      <label class="grid gap-1">
        <span class="text-xs font-medium">Model</span>
        <input class="input font-mono" bind:value={draft.model} placeholder="gpt-4.1" required />
      </label>
    </div>
    <label class="grid gap-1">
      <span class="text-xs font-medium">Base URL</span>
      <input class="input font-mono" bind:value={draft.base_url} placeholder="https://api.openai.com/v1" required />
      <span class="text-xs text-ink-2">The part before <code class="font-mono">/chat/completions</code>.</span>
    </label>
    <label class="grid gap-1">
      <span class="flex items-center gap-1 text-xs font-medium"><KeyRound size={12} /> API key</span>
      {#if draft.has_key && !draft.clear}
        <div class="flex gap-2">
          <input class="input font-mono" type="password" bind:value={draft.api_key} placeholder="•••••••• stored — type to replace" autocomplete="off" />
          <button type="button" class="btn shrink-0" onclick={() => ((draft.clear = true), (draft.api_key = ''))}>Remove key</button>
        </div>
      {:else}
        <input class="input font-mono" type="password" bind:value={draft.api_key} placeholder={draft.clear ? 'The stored key will be removed' : 'sk-… (leave empty for local servers)'} autocomplete="off" />
      {/if}
    </label>
    <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
      <label class="flex items-center gap-2">
        <input type="checkbox" bind:checked={draft.vision} />
        Vision <span class="text-ink-2">— send render screenshots to the model</span>
      </label>
      <label class="flex items-center gap-2">
        <span class="text-ink-2">Temperature</span>
        <input class="input w-22 py-1" type="number" step="0.1" min="0" max="2" bind:value={draft.temperature} placeholder="auto" />
      </label>
    </div>

    {#if test}
      <div class={['note text-xs', test.busy ? '' : test.ok ? 'ok' : 'danger']} role="status">
        {#if test.busy}<LoaderCircle size={13} class="mt-px shrink-0 animate-spin" /> Asking {draft.model}…
        {:else if test.ok}<Check size={13} class="mt-px shrink-0" /> {test.message}
        {:else}<X size={13} class="mt-px shrink-0" /> <span class="break-all">{test.message}</span>{/if}
      </div>
    {/if}
    {#if formError}<p class="note danger">{formError}</p>{/if}

    <div class="flex items-center gap-2">
      <button type="button" class="btn" disabled={!valid || test?.busy} onclick={runTest}><Zap size={13} /> Test connection</button>
      <span class="ml-auto"></span>
      <button type="button" class="btn" onclick={cancel}>Cancel</button>
      <button class="btn btn-primary" disabled={!valid || saving}>{saving ? 'Saving…' : editing === -1 ? 'Add provider' : 'Save'}</button>
    </div>
  </form>
{/snippet}
