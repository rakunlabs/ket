<script lang="ts">
  import { Check, Copy, ExternalLink, KeyRound } from '@lucide/svelte'
  import { onMount } from 'svelte'

  import { api, type Info } from '../../lib/api'

  let info = $state<Info>()
  let error = $state('')
  let client = $state<'claude' | 'opencode' | 'codex' | 'other'>('claude')
  let copied = $state('')

  onMount(async () => {
    try {
      info = await api.info()
    } catch (e) {
      error = (e as Error).message
    }
  })

  const url = $derived(info?.mcp_url ?? '')

  type Step = { text: string; code?: string; lang?: string }

  const CLIENTS = [
    ['claude', 'Claude Code'],
    ['opencode', 'OpenCode'],
    ['codex', 'Codex'],
    ['other', 'Other clients'],
  ] as const

  const steps = $derived.by((): Step[] => {
    switch (client) {
      case 'claude':
        return [
          { text: 'Add Ket as a remote MCP server (for all your projects):', code: `claude mcp add --transport http --scope user ket ${url}` },
          { text: 'Start Claude Code, run /mcp, pick ket and choose Authenticate. A browser tab opens on Ket; sign in and approve.' },
          { text: 'Check that it is connected:', code: 'claude mcp list' },
        ]
      case 'opencode':
        return [
          { text: 'Add Ket for every project (drop --global to add it to the current project only):', code: `opencode mcp add ket --global --url ${url}` },
          { text: 'In OpenCode, run /mcps, select ket and sign in. Ket opens in the browser to approve the access.' },
          { text: 'Check that it is connected:', code: 'opencode mcp list' },
          {
            text: 'Or write it into opencode.json by hand:',
            lang: 'json',
            code: JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { servers: { ket: { type: 'remote', url } } } }, null, 2),
          },
        ]
      case 'codex':
        return [
          { text: 'Add Ket as a streamable HTTP server:', code: `codex mcp add ket --url ${url}` },
          { text: 'Sign in (Codex opens Ket in the browser; skip this if the add step already did):', code: 'codex mcp login ket' },
          { text: 'Inside Codex, /mcp shows ket as connected. The entry lives in ~/.codex/config.toml:', lang: 'toml', code: `[mcp_servers.ket]\nurl = "${url}"` },
        ]
      default:
        return [
          { text: 'Any MCP client that speaks streamable HTTP can connect. The endpoint:', code: url },
          { text: 'Clients that support MCP OAuth find the sign-in by themselves (dynamic client registration, PKCE).' },
          {
            text: 'Clients without OAuth: create a personal token in the account menu → MCP tokens, and send it as a header:',
            code: 'Authorization: Bearer <token>',
          },
        ]
    }
  })

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    copied = text
    setTimeout(() => (copied = ''), 1500)
  }

  const built = $derived.by(() => {
    const d = info?.build_date
    if (!d || d === '-') return 'development build'
    const t = new Date(d.replace('_', 'T') + (d.endsWith('Z') ? '' : 'Z'))
    return isNaN(+t) ? d : t.toLocaleString()
  })
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold">About Ket</h2>
  <p class="text-ink-2">Parametric CAD and PCB in one document, built to be driven by AI.</p>
</header>

{#if error}<p class="note danger mb-3">{error}</p>{/if}

<section class="panel corners mb-8 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 px-4 py-3.5">
  {#if info}
    <span class="text-ink-3">Version</span><span class="num font-mono">{info.version}</span>
    <span class="text-ink-3">Built</span><span class="num">{built}</span>
    <span class="text-ink-3">Commit</span>
    <span class="num font-mono">
      {#if info.commit && info.commit !== '-' && info.commit !== 'unknown'}
        <a class="text-link hover:underline" href={`${info.repository}/commit/${info.commit}`} target="_blank" rel="noreferrer">{info.commit}</a>
      {:else}—{/if}
    </span>
    <span class="text-ink-3">Go</span><span class="num font-mono">{info.go}</span>
    <span class="text-ink-3">Source</span>
    <a class="flex w-fit items-center gap-1 text-link hover:underline" href={info.repository} target="_blank" rel="noreferrer">{info.repository?.replace('https://', '')} <ExternalLink size={12} /></a>
    <span class="text-ink-3">Issues</span>
    <a class="flex w-fit items-center gap-1 text-link hover:underline" href={`${info.repository}/issues`} target="_blank" rel="noreferrer">Report a problem <ExternalLink size={12} /></a>
  {:else}
    {#each { length: 5 } as _, i (i)}<span class="skeleton col-span-2 h-4"></span>{/each}
  {/if}
</section>

<h3 class="mb-1 text-[15px] font-semibold">Connect an AI agent over MCP</h3>
<p class="mb-3 text-ink-2">
  Agents work on your projects through the same commands as the built-in assistant, and see only the projects you can see. Keep the project open in a browser tab: the
  geometry kernel runs there.
</p>

<div class="seg mb-3" role="radiogroup" aria-label="Client">
  {#each CLIENTS as [id, label] (id)}
    <button role="radio" aria-checked={client === id} onclick={() => (client = id)}>{label}</button>
  {/each}
</div>

<ol class="grid gap-3">
  {#each steps as s, i (client + i)}
    <li class="grid grid-cols-[1.5rem_1fr] gap-x-2">
      <span class="num grid size-5 place-items-center border border-line-strong bg-surface-2 text-[11px] font-semibold text-ink-2">{i + 1}</span>
      <div class="min-w-0">
        <p>{s.text}</p>
        {#if s.code}
          <div class="mt-1.5 flex items-start gap-2 border border-line-strong bg-surface py-1.5 pr-1 pl-3">
            <pre class="min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre text-ink">{s.code}</pre>
            <button class="btn btn-ghost shrink-0 px-2 py-0.5 text-xs" onclick={() => copy(s.code!)} aria-label="Copy">
              {#if copied === s.code}<Check size={12} /> Copied{:else}<Copy size={12} /> Copy{/if}
            </button>
          </div>
        {/if}
      </div>
    </li>
  {/each}
</ol>

<p class="note mt-5 text-xs">
  <KeyRound size={14} class="mt-0.5 shrink-0 text-ink-3" />
  <span>
    A client signs in as you and gets your access, no more. You can see and revoke what has access in the account menu → MCP tokens. If the address above is not how
    others reach this server, an administrator sets the public URL in Access &amp; server.
  </span>
</p>
