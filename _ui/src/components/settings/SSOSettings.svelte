<script lang="ts">
  import { ChevronDown, ChevronRight, Copy, KeyRound, LogIn, Pencil, Plus, Trash2, X } from '@lucide/svelte'
  import { onMount } from 'svelte'

  import { api, type Group, type SSOProvider, type SSOView } from '../../lib/api'
  import { settings } from '../../lib/settings.svelte'

  /** Starting points; any OAuth2 / OpenID Connect provider works. */
  const PRESETS: { label: string; name: string; fill: Partial<SSOProvider> }[] = [
    { label: 'Google', name: 'google', fill: { display_name: 'Google', issuer_url: 'https://accounts.google.com' } },
    {
      label: 'Microsoft Entra ID',
      name: 'microsoft',
      fill: { display_name: 'Microsoft', issuer_url: 'https://login.microsoftonline.com/{tenant-id}/v2.0', roles_claim: 'groups' },
    },
    {
      label: 'GitHub',
      name: 'github',
      fill: {
        display_name: 'GitHub',
        auth_url: 'https://github.com/login/oauth/authorize',
        token_url: 'https://github.com/login/oauth/access_token',
        userinfo_url: 'https://api.github.com/user',
        scopes: ['read:user', 'user:email'],
      },
    },
    { label: 'GitLab', name: 'gitlab', fill: { display_name: 'GitLab', issuer_url: 'https://gitlab.com', roles_claim: 'groups' } },
    {
      label: 'Keycloak',
      name: 'keycloak',
      fill: { display_name: 'Keycloak', issuer_url: 'https://{host}/realms/{realm}', roles_claim: 'realm_access.roles, resource_access.*.roles, groups' },
    },
    { label: 'Other (OIDC / OAuth2)', name: '', fill: {} },
  ]

  const blank = (): SSOProvider => ({
    name: '',
    display_name: '',
    enabled: true,
    issuer_url: '',
    auth_url: '',
    token_url: '',
    userinfo_url: '',
    jwks_url: '',
    client_id: '',
    scopes: ['openid', 'email', 'profile'],
    token_auth_method: '',
    disable_pkce: false,
    auto_create: false,
    link_by_email: true,
    allowed_domains: [],
    roles_claim: '',
    role_mapping: {},
    default_role: '',
    group_mapping: {},
  })

  type Pair = { claim: string; to: string }

  let list = $state<SSOView[]>([])
  let groups = $state<Group[]>([])
  let loading = $state(true)
  let error = $state('')

  /** The provider name being edited, "" for a new one. */
  let editing = $state<string>()
  let draft = $state<SSOProvider>(blank())
  let secret = $state('')
  let hasSecret = $state(false)
  let scopes = $state('')
  let domains = $state('')
  let roleMap = $state<Pair[]>([])
  let groupMap = $state<Pair[]>([])
  let advanced = $state(false)
  let busy = $state(false)
  let formError = $state('')
  let confirmDelete = $state<string>()
  let copied = $state('')

  async function load() {
    try {
      const [r, g] = await Promise.all([api.sso(), api.groups()])
      list = r.providers
      groups = g
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

  const pairs = (m: Record<string, string>): Pair[] => Object.entries(m ?? {}).map(([claim, to]) => ({ claim, to }))
  const unpairs = (p: Pair[]) => Object.fromEntries(p.filter((x) => x.claim.trim() && x.to).map((x) => [x.claim.trim(), x.to]))
  const words = (s: string) => s.split(/[\s,]+/).filter(Boolean)

  function open(p: SSOProvider, isNew: boolean, has = false) {
    editing = isNew ? '' : p.name
    draft = { ...blank(), ...p }
    secret = ''
    hasSecret = has
    scopes = (draft.scopes ?? []).join(' ')
    domains = (draft.allowed_domains ?? []).join(', ')
    roleMap = pairs(draft.role_mapping)
    groupMap = pairs(draft.group_mapping)
    advanced = !!(draft.auth_url || draft.token_url || draft.userinfo_url || draft.jwks_url || draft.token_auth_method || draft.disable_pkce)
    formError = ''
  }

  function startNew(preset: (typeof PRESETS)[number]) {
    let name = preset.name
    while (name && list.some((p) => p.name === name)) name += '-2'
    open({ ...blank(), ...preset.fill, name }, true)
  }

  async function submit(e: Event) {
    e.preventDefault()
    busy = true
    formError = ''
    try {
      const body: SSOProvider & { client_secret?: string } = {
        ...draft,
        scopes: words(scopes),
        allowed_domains: words(domains),
        role_mapping: unpairs(roleMap),
        group_mapping: unpairs(groupMap),
        ...(secret.trim() ? { client_secret: secret.trim() } : {}),
      }
      list = (await api.saveSSO(editing || undefined, body)).providers
      editing = undefined
    } catch (err) {
      formError = (err as Error).message
    } finally {
      busy = false
    }
  }

  async function toggle(p: SSOView) {
    error = ''
    try {
      const { has_secret: _, callback_url: __, status: ___, ...rest } = p
      list = (await api.saveSSO(p.name, { ...rest, enabled: !p.enabled })).providers
    } catch (err) {
      error = (err as Error).message
    }
  }

  async function remove(name: string) {
    confirmDelete = undefined
    try {
      list = (await api.deleteSSO(name)).providers
    } catch (err) {
      error = (err as Error).message
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    copied = text
    setTimeout(() => (copied = ''), 1500)
  }

  const callback = $derived(list.find((p) => p.name === editing)?.callback_url ?? `${location.origin}${new URL('.', document.baseURI).pathname.replace(/\/$/, '')}/login/callback/${draft.name || '{name}'}`)
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? 'deleted group'
</script>

<header class="mb-5 flex items-end gap-3">
  <div class="mr-auto">
    <h2 class="text-lg font-semibold">Sign-in providers</h2>
    <p class="text-ink-2">Let people sign in with Google, Microsoft, GitHub, Keycloak or any OAuth2 / OpenID Connect provider. Each one adds a button to the login page.</p>
  </div>
</header>

{#if error}<p class="note danger mb-3">{error}</p>{/if}

{#if editing === undefined}
  <div class="mb-4 flex flex-wrap items-center gap-2">
    <span class="text-ink-3">Add</span>
    {#each PRESETS as p (p.label)}
      <button class={['btn', p.name === 'google' && 'btn-primary']} onclick={() => startNew(p)}><Plus size={13} /> {p.label}</button>
    {/each}
  </div>
{/if}

<ul class="panel divide-y divide-line overflow-hidden">
  {#if editing === ''}
    <li class="corners bg-surface-2 p-4">{@render editor()}</li>
  {/if}
  {#if loading}<li class="h-14 skeleton"></li>{/if}
  {#each list as p (p.name)}
    {#if editing === p.name}
      <li class="corners bg-surface-2 p-4">{@render editor()}</li>
    {:else}
      <li class={['flex items-center gap-3 px-4 py-2.5', !p.enabled && 'opacity-70']}>
        <span class="grid size-7 shrink-0 place-items-center rounded-sm border border-line-strong bg-surface-2 text-ink-2"><LogIn size={14} /></span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{p.display_name || p.name}</span>
            <code class="text-xs text-ink-3">{p.name}</code>
            {#if p.status}
              <span class="badge danger"><span class="sq danger"></span>not working</span>
            {:else if p.enabled}
              <span class="badge ok"><span class="sq ok"></span>on</span>
            {:else}
              <span class="badge"><span class="sq idle"></span>off</span>
            {/if}
            {#if !p.has_secret}<span class="badge warn">no client secret</span>{/if}
          </div>
          <div class="truncate text-xs text-ink-2">
            {p.issuer_url || p.auth_url} · {p.auto_create ? 'creates accounts' : p.link_by_email ? 'links accounts by email' : 'linked accounts only'}{Object.keys(p.role_mapping ?? {}).length ? ' · roles from claims' : ''}{Object.keys(
              p.group_mapping ?? {},
            ).length
              ? ' · groups from claims'
              : ''}
          </div>
          {#if p.status}<div class="mt-1 text-xs text-danger">{p.status}</div>{/if}
        </div>
        {#if confirmDelete === p.name}
          <span class="flex shrink-0 items-center gap-1.5 text-xs">
            Remove {p.display_name || p.name}?
            <button class="btn btn-danger py-0.5" onclick={() => remove(p.name)}>Remove</button>
            <button class="btn py-0.5" onclick={() => (confirmDelete = undefined)}>Keep</button>
          </span>
        {:else}
          <span class="flex shrink-0 items-center gap-1">
            <button class="btn py-0.5 text-xs" onclick={() => toggle(p)}>{p.enabled ? 'Turn off' : 'Turn on'}</button>
            <button class="btn btn-ghost px-1.5" title="Edit" aria-label={`Edit ${p.name}`} onclick={() => open(p, false, p.has_secret)}><Pencil size={14} /></button>
            <button class="btn btn-ghost px-1.5 hover:text-danger" title="Remove" aria-label={`Remove ${p.name}`} onclick={() => (confirmDelete = p.name)}><Trash2 size={14} /></button>
          </span>
        {/if}
      </li>
    {/if}
  {:else}
    {#if !loading && editing !== ''}
      <li class="px-4 py-8 text-center text-ink-2">
        <p class="font-medium text-ink">Only username and password sign-in for now.</p>
        <p class="mt-1">Add a provider above. You will need a client ID and secret from the provider's app registration.</p>
      </li>
    {/if}
  {/each}
</ul>

{#snippet editor()}
  <form class="grid gap-4" onsubmit={submit}>
    <div class="grid grid-cols-2 gap-3">
      <label class="grid gap-1">
        <span class="text-xs font-medium">Name <span class="font-normal text-ink-3">(in the callback URL)</span></span>
        <input class="input font-mono" bind:value={draft.name} required pattern="[a-z0-9][a-z0-9_\-]{'{0,31}'}" placeholder="google" autocomplete="off" />
      </label>
      <label class="grid gap-1">
        <span class="text-xs font-medium">Button label</span>
        <input class="input" bind:value={draft.display_name} placeholder="Google" autocomplete="off" />
      </label>
    </div>

    <div class="grid gap-1">
      <span class="text-xs font-medium">Redirect URI <span class="font-normal text-ink-3">register this at the provider</span></span>
      <div class="flex items-center gap-2 border border-line-strong bg-surface py-1 pr-1 pl-3">
        <code class="min-w-0 flex-1 truncate text-xs">{callback}</code>
        <button type="button" class="btn btn-ghost px-2 py-0.5 text-xs" onclick={() => copy(callback)}><Copy size={12} /> {copied === callback ? 'Copied' : 'Copy'}</button>
      </div>
      {#if !settings.current?.public_url}
        <span class="text-xs text-warn">Set the public URL in Access &amp; server, so the redirect URI stays the same behind a proxy.</span>
      {/if}
    </div>

    <label class="grid gap-1">
      <span class="text-xs font-medium">Issuer URL <span class="font-normal text-ink-3">OpenID Connect: finds the endpoints by itself</span></span>
      <input class="input font-mono text-xs" bind:value={draft.issuer_url} placeholder="https://accounts.google.com" autocomplete="off" />
    </label>

    <div class="grid grid-cols-2 gap-3">
      <label class="grid gap-1">
        <span class="text-xs font-medium">Client ID</span>
        <input class="input font-mono text-xs" bind:value={draft.client_id} required autocomplete="off" />
      </label>
      <label class="grid gap-1">
        <span class="flex items-center gap-1 text-xs font-medium"><KeyRound size={12} /> Client secret</span>
        <input class="input font-mono text-xs" type="password" bind:value={secret} autocomplete="new-password" placeholder={hasSecret ? 'Stored; leave empty to keep' : 'From the app registration'} />
      </label>
    </div>

    <button type="button" class="flex w-fit items-center gap-1 text-xs font-medium text-ink-2 hover:text-ink" onclick={() => (advanced = !advanced)} aria-expanded={advanced}>
      {#if advanced}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if} Endpoints and scopes (plain OAuth2, GitHub)
    </button>
    {#if advanced}
      <div class="grid grid-cols-2 gap-3 border-l-2 border-line-strong pl-3">
        <label class="grid gap-1"><span class="text-xs font-medium">Authorization URL</span><input class="input font-mono text-xs" bind:value={draft.auth_url} autocomplete="off" /></label>
        <label class="grid gap-1"><span class="text-xs font-medium">Token URL</span><input class="input font-mono text-xs" bind:value={draft.token_url} autocomplete="off" /></label>
        <label class="grid gap-1"><span class="text-xs font-medium">Userinfo URL</span><input class="input font-mono text-xs" bind:value={draft.userinfo_url} autocomplete="off" /></label>
        <label class="grid gap-1"><span class="text-xs font-medium">JWKS URL</span><input class="input font-mono text-xs" bind:value={draft.jwks_url} autocomplete="off" /></label>
        <label class="grid gap-1"><span class="text-xs font-medium">Scopes</span><input class="input font-mono text-xs" bind:value={scopes} placeholder="openid email profile" autocomplete="off" /></label>
        <label class="grid gap-1">
          <span class="text-xs font-medium">Client authentication</span>
          <select class="input" bind:value={draft.token_auth_method}>
            <option value="">HTTP Basic (default)</option>
            <option value="post">In the request body</option>
            <option value="bearer">Bearer header</option>
            <option value="query">Query string</option>
          </select>
        </label>
        <label class="col-span-2 flex items-center gap-2"><input type="checkbox" bind:checked={draft.disable_pkce} /> Turn off PKCE <span class="text-xs text-ink-3">only for providers that reject it</span></label>
      </div>
    {/if}

    <fieldset class="grid gap-2 border-t border-line pt-3">
      <legend class="pr-2 text-xs font-medium">Who may sign in</legend>
      <label class="flex items-start gap-2">
        <input class="mt-0.5" type="checkbox" bind:checked={draft.link_by_email} />
        <span>Match existing accounts by email <span class="block text-xs text-ink-3">Only when the provider says the email is verified.</span></span>
      </label>
      <label class="flex items-start gap-2">
        <input class="mt-0.5" type="checkbox" bind:checked={draft.auto_create} />
        <span>Create an account on first sign-in <span class="block text-xs text-ink-3">Off: only people you added (or linked) can sign in.</span></span>
      </label>
      <div class="grid grid-cols-2 gap-3">
        <label class="grid gap-1">
          <span class="text-xs font-medium">Allowed email domains</span>
          <input class="input" bind:value={domains} placeholder="example.com (empty: any)" autocomplete="off" />
        </label>
        <label class="grid gap-1">
          <span class="text-xs font-medium">Role for new accounts</span>
          <select class="input" bind:value={draft.default_role}>
            <option value="">Sign-up default ({settings.current?.default_role ?? 'editor'})</option>
            {#each settings.roles as r (r.name)}<option value={r.name}>{r.name}</option>{/each}
          </select>
        </label>
      </div>
    </fieldset>

    <fieldset class="grid gap-2 border-t border-line pt-3">
      <legend class="pr-2 text-xs font-medium">Roles and groups from the provider</legend>
      <label class="grid gap-1">
        <span class="text-xs font-medium">Claims to read <span class="font-normal text-ink-3">besides "roles", comma separated; * walks a map</span></span>
        <input class="input font-mono text-xs" bind:value={draft.roles_claim} placeholder="groups, realm_access.roles" autocomplete="off" />
      </label>

      {@render mapping('Claim value → role', roleMap, settings.roles.map((r) => ({ value: r.name, label: r.name })), 'Roles follow the provider on every sign-in; no match gives the role for new accounts.')}
      {@render mapping('Claim value → group', groupMap, groups.map((g) => ({ value: g.id, label: g.name })), groups.length ? 'Mapped groups follow the provider; groups set by hand stay.' : 'Make groups in the Groups tab first.')}
    </fieldset>

    <label class="flex items-center gap-2"><input type="checkbox" bind:checked={draft.enabled} /> Show on the login page</label>

    {#if formError}<p class="note danger">{formError}</p>{/if}
    <div class="flex justify-end gap-2">
      <button type="button" class="btn" onclick={() => (editing = undefined)}><X size={13} /> Cancel</button>
      <button class="btn btn-primary" disabled={busy || !draft.name || !draft.client_id}>{busy ? 'Saving…' : editing === '' ? 'Add provider' : 'Save'}</button>
    </div>
  </form>
{/snippet}

{#snippet mapping(title: string, rows: Pair[], options: { value: string; label: string }[], hint: string)}
  <div class="grid gap-1">
    <span class="text-xs font-medium">{title}</span>
    {#each rows as row, i (i)}
      <div class="flex gap-2">
        <input class="input font-mono text-xs" bind:value={row.claim} placeholder="claim value, e.g. ket-admins" aria-label="Claim value" />
        <select class="input w-48 flex-none" bind:value={row.to} aria-label="Maps to">
          <option value="" disabled>Choose…</option>
          {#each options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
          {#if row.to && !options.some((o) => o.value === row.to)}<option value={row.to}>{groupName(row.to)}</option>{/if}
        </select>
        <button type="button" class="btn btn-ghost px-1.5" aria-label="Remove mapping" onclick={() => rows.splice(i, 1)}><X size={13} /></button>
      </div>
    {/each}
    <div class="flex items-center gap-3">
      <button type="button" class="btn py-0.5 text-xs" disabled={!options.length} onclick={() => rows.push({ claim: '', to: '' })}><Plus size={12} /> Add mapping</button>
      <span class="text-xs text-ink-3">{hint}</span>
    </div>
  </div>
{/snippet}
