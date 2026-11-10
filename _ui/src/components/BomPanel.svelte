<script lang="ts">
  import { RefreshCw, X } from '@lucide/svelte'

  import type { Session } from '../lib/session.svelte'

  let { session, onclose }: { session: Session; onclose: () => void } = $props()

  interface Line {
    lcsc: string
    mpn?: string
    refs: string
    per_board?: number
    qty: number
    order?: number
    stock?: number
    unit?: number
    cost?: number
    type?: 'basic' | 'extended'
    error?: string
  }
  interface Bom {
    boards: number
    lines: Line[]
    totals: { parts_usd: number; extended_parts: number; extended_fees_usd: number; total_usd: number; per_board_usd: number }
    problems?: string[]
    prices_checked?: string
    note: string
  }

  let boards = $state(5)
  let bom = $state<Bom>()
  let busy = $state(false)
  let error = $state('')

  async function load() {
    busy = true
    error = ''
    try {
      bom = (await session.run('check_bom', { boards })) as Bom
    } catch (e) {
      error = (e as Error).message
    } finally {
      busy = false
    }
  }

  // Reload when the parts change.
  const partsKey = $derived(JSON.stringify(session.doc.pcb?.components.map((c) => [c.ref, c.lcsc]) ?? []))
  $effect(() => {
    void partsKey
    void load()
  })

  const usd = (v: number | undefined, d = 2) => (v === undefined ? '—' : `$${v.toFixed(d)}`)
</script>

<div class="pop absolute top-2 right-2 bottom-10 flex w-[480px] flex-col text-xs text-ink">
  <div class="flex items-center gap-2 border-b border-line-strong bg-surface-2 px-3 py-1.5">
    <b class="text-sm whitespace-nowrap">Bill of materials</b>
    <label class="ml-auto flex items-center gap-1 text-ink-2">
      boards
      <input class="input w-18 flex-none py-0.5 text-xs" type="number" min="1" bind:value={boards} onchange={load} />
    </label>
    <button class="btn btn-ghost px-1.5" title="Refresh prices" disabled={busy} onclick={load}><RefreshCw size={13} class={busy ? 'animate-spin' : ''} /></button>
    <button class="btn btn-ghost px-1.5" onclick={onclose}><X size={13} /></button>
  </div>
  {#if error}<div class="note danger m-2">{error}</div>{/if}
  {#if bom}
    <div class="min-h-0 flex-1 overflow-y-auto">
      <table class="w-full">
        <thead class="sticky top-0 border-b border-line-strong bg-surface-2 text-left text-[11px] font-medium text-ink-3">
          <tr><th class="px-3 py-1">Part</th><th>Refs</th><th class="text-right">Qty</th><th class="text-right">Stock</th><th class="text-right">Unit</th><th class="px-3 text-right">Cost</th></tr>
        </thead>
        <tbody>
          {#each bom.lines as l (l.lcsc)}
            {@const short = l.stock !== undefined && l.stock < (l.order ?? l.qty)}
            <tr class="border-t border-line even:bg-surface-2/60">
              <td class="px-3 py-1">
                <div class="font-medium">{l.mpn ?? l.lcsc}</div>
                <div class="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-3">
                  {l.lcsc} <span class={['badge', l.type === 'extended' ? 'warn' : 'ok']}>{l.type ?? '?'}</span>
                </div>
              </td>
              <td class="max-w-24 truncate text-ink-2" title={l.refs}>{l.refs}</td>
              <td class="num text-right font-mono" title={l.order ? `${l.qty} needed, ordered in steps of the LCSC minimum` : ''}>{l.order ?? l.qty}</td>
              <td class={['num text-right font-mono', short ? 'font-semibold text-danger' : 'text-ink-2']}>{l.stock?.toLocaleString() ?? '—'}</td>
              <td class="num text-right font-mono text-ink-2">{usd(l.unit, 4)}</td>
              <td class="num px-3 text-right font-mono">{l.error ? '!' : usd(l.cost)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if bom.problems?.length}
      <ul class="max-h-28 list-[square] overflow-y-auto border-t border-danger-line bg-danger-soft py-1.5 pr-3 pl-7 text-danger">
        {#each bom.problems as p, i (i)}<li>{p}</li>{/each}
      </ul>
    {/if}
    <div class="num grid grid-cols-[1fr_auto] gap-x-3 border-t border-dashed border-line-dash px-3 py-2 font-mono">
      <span class="text-ink-2">parts</span><span class="text-right">{usd(bom.totals.parts_usd)}</span>
      <span class="text-ink-2">extended part fees ({bom.totals.extended_parts} × $3)</span><span class="text-right">{usd(bom.totals.extended_fees_usd)}</span>
      <span class="font-semibold">total for {bom.boards} boards</span><span class="text-right font-semibold">{usd(bom.totals.total_usd)}</span>
      <span class="text-ink-2">per board</span><span class="text-right">{usd(bom.totals.per_board_usd)}</span>
    </div>
    <div class="px-3 pb-2 text-[11px] text-ink-3">
      {bom.note}{#if bom.prices_checked}{" "}Prices from LCSC, checked {new Date(bom.prices_checked).toLocaleString()}.{/if}
    </div>
  {:else if busy}
    <div class="px-3 py-4 text-ink-2">Checking prices and stock…</div>
  {/if}
</div>
