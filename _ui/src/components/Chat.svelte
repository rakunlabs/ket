<script lang="ts">
  import { Bot, ChevronDown, ChevronRight, CircleX, Loader2, MessageSquarePlus, Send, Square, Wrench } from '@lucide/svelte'
  import { onMount, tick } from 'svelte'

  import { api, chat, type AgentEvent, type ChatMessage, type Conversation, type ProviderInfo } from '../lib/api'
  import { markdown } from '../lib/markdown'
  import type { Session } from '../lib/session.svelte'

  let { session, projectID, providers }: { session: Session; projectID: string; providers: ProviderInfo[] } = $props()

  interface ToolItem {
    id: string
    name: string
    args: unknown
    result?: string
    isError?: boolean
    images?: string[]
    open?: boolean
  }

  type Item = { kind: 'user'; text: string } | { kind: 'assistant'; text: string } | { kind: 'tool'; tool: ToolItem } | { kind: 'error'; text: string }

  let conversations = $state<Conversation[]>([])
  let current = $state<Conversation>()
  let items = $state<Item[]>([])
  let input = $state('')
  let busy = $state(false)
  let provider = $state('')
  let scroller: HTMLDivElement
  let abort: AbortController | undefined
  let lightbox = $state<string>()
  let propose = $state(false)

  $effect(() => {
    const request = session.assistantRequest
    if (!request) return
    input = input.trim() ? `${input}\n\n${request.prompt}` : request.prompt
    propose = true
    session.assistantRequest = undefined
  })

  $effect(() => {
    if (!provider && providers[0]) provider = providers[0].name
  })

  onMount(async () => {
    conversations = await api.conversations(projectID)
    if (conversations[0]) await open(conversations[0])
  })

  async function open(c: Conversation) {
    current = c
    const { messages } = await api.conversation(c.id)
    items = fromHistory(messages)
    await scrollDown()
  }

  async function newConversation() {
    current = undefined
    items = []
  }

  function textOf(content: ChatMessage['content']): string {
    if (!content) return ''
    if (typeof content === 'string') return content
    return content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('')
  }

  function fromHistory(msgs: ChatMessage[]): Item[] {
    const out: Item[] = []
    const tools = new Map<string, ToolItem>()
    for (const m of msgs) {
      if (m.role === 'user') {
        if (Array.isArray(m.content)) {
          // Render images sent to the model after a tool call.
          const imgs = m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url!.url)
          const last = [...out].reverse().find((i) => i.kind === 'tool') as Extract<Item, { kind: 'tool' }> | undefined
          if (last && imgs.length) last.tool.images = [...(last.tool.images ?? []), ...imgs]
          continue
        }
        const t = textOf(m.content)
        if (t.startsWith('[earlier render omitted]')) continue
        out.push({ kind: 'user', text: t })
      } else if (m.role === 'assistant') {
        const t = textOf(m.content)
        if (t) out.push({ kind: 'assistant', text: t })
        for (const tc of m.tool_calls ?? []) {
          let args: unknown = tc.function.arguments
          try {
            args = JSON.parse(tc.function.arguments)
          } catch {
            // keep raw
          }
          const tool: ToolItem = { id: tc.id, name: tc.function.name, args }
          tools.set(tc.id, tool)
          out.push({ kind: 'tool', tool })
        }
      } else if (m.role === 'tool' && m.tool_call_id) {
        const tool = tools.get(m.tool_call_id)
        if (tool) {
          const t = textOf(m.content)
          tool.result = t
          tool.isError = t.startsWith('ERROR:')
        }
      }
    }
    return out
  }

  async function scrollDown() {
    await tick()
    scroller?.scrollTo({ top: scroller.scrollHeight })
  }

  async function send(e?: Event) {
    e?.preventDefault()
    const text = input.trim()
    if (!text || busy) return
    input = ''
    busy = true

    try {
      if (!current) {
        current = await api.createConversation(projectID)
        conversations = [current, ...conversations]
      }
      items.push({ kind: 'user', text })
      await scrollDown()

      let assistant: Extract<Item, { kind: 'assistant' }> | undefined
      const tools = new Map<string, ToolItem>()
      abort = new AbortController()

      await chat(
        current.id,
        text,
        provider || undefined,
        (ev: AgentEvent) => {
          switch (ev.type) {
            case 'text':
              if (!assistant) {
                assistant = { kind: 'assistant', text: '' }
                items.push(assistant)
                assistant = items[items.length - 1] as typeof assistant
              }
              assistant.text += ev.delta ?? ''
              break
            case 'tool_call': {
              assistant = undefined
              items.push({ kind: 'tool', tool: { id: ev.id!, name: ev.name!, args: ev.args } })
              tools.set(ev.id!, (items[items.length - 1] as Extract<Item, { kind: 'tool' }>).tool)
              break
            }
            case 'tool_result': {
              const t = tools.get(ev.id!)
              if (t) {
                t.result = ev.text
                t.isError = ev.is_error
                t.images = ev.images
              }
              break
            }
            case 'error':
              items.push({ kind: 'error', text: ev.message ?? 'error' })
              break
          }
          void scrollDown()
        },
        abort.signal,
        propose,
      )
    } catch (err) {
      if ((err as Error).name !== 'AbortError') items.push({ kind: 'error', text: (err as Error).message })
    } finally {
      busy = false
      abort = undefined
      await scrollDown()
      conversations = await api.conversations(projectID)
    }
  }

  async function stop() {
    if (current) await api.stop(current.id)
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  function shortArgs(a: unknown): string {
    const s = JSON.stringify(a)
    if (!s) return ''
    return s.length > 80 ? s.slice(0, 80) + '…' : s
  }

  const suggestions = [
    'Make an enclosure for a 50 × 26 × 1.6 mm board with 2 mm walls, a USB-C opening on the left and 4 M2.5 standoffs.',
    'Design a phone stand at 65° with a cable slot.',
    'Model a 40 × 40 mm fan grill with 3 mm holes in a grid.',
  ]
</script>

<aside class="flex w-[400px] shrink-0 flex-col border-l border-line-strong bg-surface">
  <div class="flex h-10 shrink-0 items-center gap-1.5 border-b border-line-strong bg-surface-2 px-2">
    <Bot size={15} class="text-ink-2" />
    <select
      class="min-w-0 flex-1 truncate bg-transparent font-medium outline-none"
      value={current?.id ?? ''}
      onchange={(e) => {
        const c = conversations.find((x) => x.id === (e.target as HTMLSelectElement).value)
        if (c) open(c)
        else newConversation()
      }}
    >
      <option value="">New conversation</option>
      {#each conversations as c (c.id)}
        <option value={c.id}>{c.title || 'Untitled'}</option>
      {/each}
    </select>
    <button class="btn btn-ghost px-1.5" title="New conversation" onclick={newConversation}><MessageSquarePlus size={15} /></button>
  </div>

  <div bind:this={scroller} class="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
    {#if items.length === 0}
      <div class="pt-6 text-center text-ink-2">
        <Bot size={28} class="mx-auto mb-2 text-ink-3" />
        <p class="mb-3">Describe what to build. The assistant models it, checks it and shows you renders.</p>
        <div class="space-y-1.5 text-left">
          {#each suggestions as s}
            <button class="w-full border border-line-strong bg-surface px-2.5 py-2 text-left text-ink hover:bg-sel hover:text-sel-ink" onclick={() => (input = s)}>{s}</button>
          {/each}
        </div>
      </div>
    {/if}

    {#each items as item, i (i)}
      {#if item.kind === 'user'}
        <div class="ml-8 border border-sel-line bg-sel px-3 py-2 text-sel-ink whitespace-pre-wrap">{item.text}</div>
      {:else if item.kind === 'assistant'}
        <div class="prose-chat leading-relaxed">{@html markdown(item.text)}</div>
      {:else if item.kind === 'error'}
        <div class="note danger">
          <CircleX size={14} class="mt-0.5 shrink-0" />{item.text}
        </div>
      {:else}
        {@const t = item.tool}
        <div class={['border text-xs', t.isError ? 'border-danger-line bg-danger-soft' : 'border-line bg-surface-2']}>
          <button class="flex w-full items-center gap-1.5 px-2 py-1.5 text-left" onclick={() => (t.open = !t.open)}>
            {#if t.result === undefined}
              <Loader2 size={12} class="shrink-0 animate-spin text-ink-2" />
            {:else if t.isError}
              <CircleX size={12} class="shrink-0 text-danger" />
            {:else}
              <Wrench size={12} class="shrink-0 text-ink-2" />
            {/if}
            <span class="font-mono font-medium">{t.name}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-ink-2">{shortArgs(t.args)}</span>
            {#if t.open}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
          </button>
          {#if t.images?.length}
            <div class="flex gap-1.5 px-2 pb-2">
              {#each t.images as src}
                <button onclick={() => (lightbox = src)}>
                  <img {src} alt="render" class="h-28 border border-line bg-surface" />
                </button>
              {/each}
            </div>
          {/if}
          {#if t.open}
            <div class="space-y-1.5 border-t border-line px-2 py-1.5">
              <pre class="overflow-x-auto font-mono text-[11px] whitespace-pre-wrap text-ink-2">{JSON.stringify(t.args, null, 2)}</pre>
              {#if t.result !== undefined}
                <pre class={['max-h-64 overflow-auto font-mono text-[11px] whitespace-pre-wrap', t.isError && 'text-danger']}>{t.result}</pre>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/each}

    {#if busy}
      <div class="flex items-center gap-1.5 text-xs text-ink-2"><Loader2 size={12} class="animate-spin" /> working…</div>
    {/if}
  </div>

  <form class="shrink-0 border-t border-line-strong bg-surface-2 p-2" onsubmit={send}>
    <textarea
      class="input min-h-16 resize-none"
      placeholder="Describe a change… (Enter to send, Shift+Enter for a new line)"
      bind:value={input}
      onkeydown={onKeydown}
      rows="3"
    ></textarea>
    <div class="mt-1.5 flex items-center gap-2">
      <label class="flex items-center gap-1 text-xs text-ink-2" title="Changes go to a proposal you accept or reject">
        <input type="checkbox" bind:checked={propose} /> propose
      </label>
      {#if providers.length > 1}
        <select class="input w-auto py-0.5 text-xs" bind:value={provider}>
          {#each providers as p}<option value={p.name}>{p.name} · {p.model}</option>{/each}
        </select>
      {:else if providers[0]}
        <span class="truncate font-mono text-[11px] text-ink-2">{providers[0].model}</span>
      {/if}
      <span class="ml-auto"></span>
      {#if busy}
        <button type="button" class="btn" onclick={stop}><Square size={13} /> Stop</button>
      {:else}
        <button class="btn btn-primary" disabled={!input.trim()}><Send size={13} /> Send</button>
      {/if}
    </div>
  </form>
</aside>

{#if lightbox}
  <button class="fixed inset-0 z-50 grid place-items-center bg-scrim p-8" onclick={() => (lightbox = undefined)}>
    <img src={lightbox} alt="render" class="max-h-full max-w-full rounded bg-surface shadow-[var(--shadow-pop)]" />
  </button>
{/if}
