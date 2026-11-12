<script lang="ts">
  import { Image, Plus, Trash2, Type, X } from '@lucide/svelte'

  import type { BoardArtwork, MaskColor, SilkColor } from '../engine/doc'
  import { boardStyle, MASK_COLORS } from '../engine/pcb/artwork'
  import type { Violation } from '../engine/pcb/drc'
  import { projectAccess } from '../lib/access.svelte'
  import { readBoardLogo } from '../lib/board-logo'
  import type { Session } from '../lib/session.svelte'
  import { toasts } from '../lib/toasts'

  let { session, side, onclose, onplace }: { session: Session; side: 'top' | 'bottom'; onclose: () => void; onplace: (name: string) => void } = $props()
  const access = projectAccess()
  const style = $derived(boardStyle(session.doc.pcb!))
  const artwork = $derived(session.doc.pcb?.artwork ?? [])
  let kind = $state<'text' | 'image'>('text')
  let editing = $state('')
  let name = $state('label')
  let text = $state('Ket')
  let width = $state('12')
  let x = $state('0'), y = $state('0'), rotation = $state('0')
  // The form starts on the viewed face; its side can then be edited independently.
  // svelte-ignore state_referenced_locally
  let printSide = $state<'top' | 'bottom'>(side)
  let busy = $state(false)
  let converting = $state(false)
  let error = $state('')
  let logoFile = $state<File>()
  let bitmap = $state<string[]>()
  let preview = $state('')
  let threshold = $state(160)
  let invert = $state(false)
  let conversion = 0
  let issues = $state<Violation[]>()
  $effect(() => { void session.doc.pcb; issues = undefined })
  const disabled = $derived(busy || converting || session.building || !session.ready || !access.canEdit)

  function newArtwork(nextKind: 'text' | 'image') {
    conversion++
    kind = nextKind
    editing = ''
    const prefix = kind === 'text' ? 'label' : 'logo'
    name = prefix
    let n = 2
    while (artwork.some((art) => art.name === name)) name = `${prefix}_${n++}`
    text = 'Ket'
    width = '12'
    x = y = rotation = '0'
    printSide = side
    logoFile = undefined
    bitmap = undefined
    preview = ''
    error = ''
    converting = false
  }

  function edit(art: BoardArtwork) {
    conversion++
    editing = name = art.name
    kind = art.kind
    text = art.text ?? ''
    width = String(art.width)
    x = String(art.at[0]); y = String(art.at[1]); rotation = String(art.rotation ?? 0)
    printSide = art.side
    logoFile = undefined
    bitmap = undefined
    preview = ''
    error = ''
    converting = false
  }

  async function convertLogo() {
    if (!logoFile) return
    const request = ++conversion
    converting = true
    error = ''
    bitmap = undefined
    preview = ''
    try {
      const result = await readBoardLogo(logoFile, Number(width), threshold, invert)
      if (request !== conversion) return
      bitmap = result.rows
      preview = result.preview
    } catch (e) {
      if (request === conversion) error = (e as Error).message
    } finally {
      if (request === conversion) converting = false
    }
  }

  async function setStyle(mask: MaskColor, silk: SilkColor) {
    busy = true
    try { await session.run('set_board_style', { mask, silk }) }
    catch (e) { toasts.show((e as Error).message, 'error') }
    finally { busy = false }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    busy = true
    error = ''
    try {
      const position = { at: [x, y], width, rotation, side: printSide }
      if (editing && kind === 'image' && !logoFile) {
        await session.run('update_board_artwork', { name: editing, ...position })
      } else {
        if (kind === 'image' && !bitmap) throw new Error('Choose a logo and wait for its monochrome preview before adding it.')
        await session.run('add_board_artwork', { name, ...position, ...(kind === 'text' ? { text } : { bitmap }), replace: !!editing })
      }
      editing = name
      toasts.show('Silkscreen artwork saved. Check pad clearance and fine details before ordering.')
    } catch (e) { error = (e as Error).message }
    finally { busy = false }
  }

  async function remove(art: BoardArtwork) {
    busy = true
    try {
      await session.run('remove_board_artwork', { names: [art.name] })
      if (editing === art.name) newArtwork(kind)
    } catch (e) { toasts.show((e as Error).message, 'error') }
    finally { busy = false }
  }

  async function checkClearance() {
    busy = true
    const pcb = session.doc.pcb
    try {
      const state = await session.boardForRender(true)
      if (pcb === session.doc.pcb) issues = state?.drc?.filter((v) => v.rule.startsWith('silk_')) ?? []
    } catch (e) { toasts.show((e as Error).message, 'error') }
    finally { busy = false }
  }
</script>

<section class="pop absolute top-12 right-2 bottom-10 z-20 flex w-80 max-w-[calc(100%_-_16px)] flex-col text-ink" aria-label="Board appearance" data-board-tools>
  <header class="flex items-center justify-between gap-2 border-b border-line-strong bg-surface-2 px-3 py-2">
    <h2 class="text-sm font-semibold">Board appearance</h2>
    <button class="btn btn-ghost px-1.5" aria-label="Close board appearance" onclick={onclose}><X size={15} /></button>
  </header>
  <div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
    {#if !access.canEdit}<p class="text-xs text-ink-2">Read-only. Board colors and artwork are shown below.</p>{/if}
    <fieldset disabled={disabled} class="space-y-2">
      <legend class="mb-2 text-xs font-medium">Solder mask <span class="font-normal text-ink-2">· {MASK_COLORS[style.mask].label}</span></legend>
      <div class="grid grid-cols-7 gap-1.5">
        {#each Object.entries(MASK_COLORS) as [key, color] (key)}
          <button class={['mask-swatch', style.mask === key && 'selected']} style:--mask={color.color} title={color.label} aria-label={`${color.label} solder mask`} aria-pressed={style.mask === key} onclick={() => setStyle(key as MaskColor, style.silk)}></button>
        {/each}
      </div>
      <label class="flex items-center justify-between gap-3 text-xs">Silkscreen ink
        <select class="input w-28" value={style.silk} onchange={(e) => setStyle(style.mask, e.currentTarget.value as SilkColor)}><option value="white">White</option><option value="black">Black</option></select>
      </label>
      {#if (style.mask === 'white' && style.silk === 'white') || (style.mask === 'black' && style.silk === 'black')}
        <p class="text-xs text-warn">Mask and ink have low contrast. Choose contrasting ink for readable printing.</p>
      {/if}
    </fieldset>

    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2"><h3 class="text-xs font-medium">Printed artwork <span class="text-ink-3">({artwork.length})</span></h3></div>
      {#if !artwork.length}<p class="text-xs text-ink-2">Add a name, revision label or logo to either face.</p>{/if}
      <ul class="divide-y divide-line">
        {#each artwork as art (art.name)}
          <li class="flex items-center gap-1 py-1">
            <button class={['btn btn-ghost min-w-0 flex-1 text-left text-xs', editing === art.name && 'on']} onclick={() => edit(art)}>
              {#if art.kind === 'text'}<Type size={13} />{:else}<Image size={13} />{/if}
              <span class="min-w-0 flex-1 truncate">{art.name}</span><span class="text-[11px]">{art.side}</span>
            </button>
            {#if access.canEdit}<button class="btn btn-ghost px-1.5 text-danger" aria-label={`Remove ${art.name}`} disabled={disabled} onclick={() => remove(art)}><Trash2 size={13} /></button>{/if}
          </li>
        {/each}
      </ul>
    </div>

    {#if access.canEdit}
      <form class="space-y-3 border-t border-line pt-3" onsubmit={save}>
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-xs font-medium">{editing ? `Edit ${editing}` : 'New artwork'}</h3>
          <div class="flex gap-1">
            <button type="button" class="btn btn-ghost px-1.5 text-xs" disabled={busy} onclick={() => newArtwork('text')}><Plus size={12} /> Text</button>
            <button type="button" class="btn btn-ghost px-1.5 text-xs" disabled={busy} onclick={() => newArtwork('image')}><Plus size={12} /> Logo</button>
          </div>
        </div>
        <fieldset class="space-y-3" disabled={disabled}>
          <label class="block space-y-1 text-xs"><span>Name</span><input class="input" bind:value={name} required pattern="[A-Za-z_][A-Za-z0-9_]*" readonly={!!editing} /></label>
          {#if kind === 'text'}
            <label class="block space-y-1 text-xs"><span>Printed text</span><input class="input" bind:value={text} maxlength="100" required /></label>
          {:else}
            <label class="block space-y-1 text-xs"><span>{editing ? 'Replace logo (optional)' : 'Logo image'}</span><input class="input text-xs" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg" onchange={(e) => { logoFile = e.currentTarget.files?.[0]; void convertLogo() }} /></label>
            <p class="text-xs text-ink-2">PNG, JPEG or WebP · up to 5 MiB. Dark pixels become {style.silk} ink; transparent areas stay empty. Converted locally.</p>
            {#if logoFile}
              <label class="block space-y-1 text-xs"><span>Threshold · {threshold}</span><input class="w-full accent-ink" type="range" min="1" max="254" bind:value={threshold} onchange={convertLogo} /></label>
              <label class="flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={invert} onchange={convertLogo} /> Invert light/dark pixels</label>
              {#if preview}<img class="max-h-32 w-full border border-line bg-white object-contain p-2" src={preview} alt="Monochrome print preview: black pixels indicate ink" />{/if}
            {/if}
          {/if}
          <div class="grid grid-cols-2 gap-2">
            <label class="space-y-1 text-xs"><span>Width (mm)</span><input class="input" bind:value={width} required onchange={() => { if (logoFile) void convertLogo() }} /></label>
            <label class="space-y-1 text-xs"><span>Side</span><select class="input" bind:value={printSide}><option value="top">Top</option><option value="bottom">Bottom</option></select></label>
            <label class="space-y-1 text-xs"><span>Center X (mm)</span><input class="input" bind:value={x} required /></label>
            <label class="space-y-1 text-xs"><span>Center Y (mm)</span><input class="input" bind:value={y} required /></label>
          </div>
          <label class="block space-y-1 text-xs"><span>Rotation (°)</span><input class="input" bind:value={rotation} required /></label>
          <p class="text-xs text-ink-2">Dimensions also accept parameter expressions. Aspect ratio is preserved; bottom printing is mirrored automatically.</p>
          <button class="btn btn-primary w-full justify-center" type="submit">{busy ? 'Saving…' : editing ? 'Save artwork' : 'Add to silkscreen'}</button>
          {#if editing && artwork.some((art) => art.name === editing)}<button class="btn w-full justify-center" type="button" onclick={() => onplace(editing)}>Place on board…</button>{/if}
        </fieldset>
        {#if converting}<p class="text-xs text-ink-2" role="status">Preparing monochrome preview…</p>{/if}
        {#if error}<p class="note danger text-xs" role="alert">{error}</p>{/if}
      </form>
    {/if}
    {#if artwork.length}
      <div class="space-y-2 border-t border-line pt-3">
        <button class="btn w-full justify-center text-xs" disabled={busy || session.building} onclick={checkClearance}>Check print clearance</button>
        {#if issues}
          {#if issues.length}<ul class="space-y-1 text-xs text-danger" role="status">{#each issues as issue}<li>{issue.message}</li>{/each}</ul>
          {:else}<p class="text-xs text-ok" role="status">No artwork-to-pad, edge or hole conflicts found. Fine details still need DFM review.</p>{/if}
        {/if}
      </div>
    {/if}
    <p class="border-t border-line pt-3 text-xs text-ink-2">Single-color silkscreen, not full-color UV printing. Artwork exports to Gerber. Run DRC for pad/edge clearance and review fine lines with the manufacturer. Select mask and ink colors again when ordering.</p>
  </div>
</section>

<style>
  .mask-swatch {
    height: 30px;
    border: 1px solid var(--control);
    border-radius: var(--r);
    background: var(--mask);
    cursor: pointer;
  }
  .mask-swatch.selected {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .mask-swatch:hover:not(:disabled) { box-shadow: inset 0 0 0 2px var(--surface); }
  .mask-swatch:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
