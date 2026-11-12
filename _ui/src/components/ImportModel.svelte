<script lang="ts">
  import { Box, Trash2, Upload as UploadIcon, X } from '@lucide/svelte'

  import { api, type Upload } from '../lib/api'
  import type { Session } from '../lib/session.svelte'
  import { toasts } from '../lib/toasts'

  let { projectID, session, canEdit }: { projectID: string; session: Session; canEdit: boolean } = $props()

  let open = $state(false)
  let uploads = $state<Upload[]>([])
  let busy = $state('')
  let error = $state('')
  let input: HTMLInputElement
  /** Chosen 3MF objects, by upload id. */
  let picked = $state<Record<string, string[]>>({})

  async function load() {
    error = ''
    try {
      uploads = await api.uploads(projectID)
    } catch (e) {
      error = (e as Error).message
    }
  }

  function toggle() {
    open = !open
    if (open) void load()
  }

  /** A feature name from a file or object name: letters, digits and _. */
  function featureName(raw: string): string {
    let n = raw.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
    if (!/^[A-Za-z_]/.test(n)) n = 'model_' + n
    const taken = new Set(session.doc.features.map((f) => f.name))
    let name = n || 'model'
    for (let i = 2; taken.has(name); i++) name = `${n}_${i}`
    taken.add(name)
    return name
  }

  async function importAs(steps: { name: string; url: string }[]) {
    if (!steps.length) return
    busy = 'Building…'
    try {
      const used = new Set(session.doc.features.map((f) => f.name))
      const named = steps.map((s) => {
        let name = s.name
        for (let i = 2; used.has(name); i++) name = `${s.name}_${i}`
        used.add(name)
        return { cmd: 'import', args: { name, url: s.url } }
      })
      await session.run('batch', { steps: named })
      toasts.show(`Imported ${named.map((s) => s.args.name).join(', ')}.`)
      open = false
    } catch (e) {
      toasts.show((e as Error).message, 'error')
    } finally {
      busy = ''
    }
  }

  async function onFile(event: Event) {
    const el = event.currentTarget as HTMLInputElement
    const file = el.files?.[0]
    el.value = ''
    if (!file) return
    busy = `Uploading ${file.name}…`
    error = ''
    try {
      const up = await api.upload(projectID, file)
      uploads = [up, ...uploads.filter((u) => u.id !== up.id)]
      if (up.objects && up.objects.length > 1) {
        // A slicer project: let the user choose which objects to bring in.
        picked = { ...picked, [up.id]: [] }
        busy = ''
        return
      }
      busy = ''
      await importAs([{ name: featureName(up.name), url: up.url }])
    } catch (e) {
      error = (e as Error).message
      busy = ''
    }
  }

  function toggleObject(up: Upload, id: string) {
    const cur = picked[up.id] ?? []
    picked = { ...picked, [up.id]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }
  }

  function importObjects(up: Upload) {
    const ids = picked[up.id] ?? []
    const objs = (up.objects ?? []).filter((o) => ids.includes(o.id))
    void importAs(objs.map((o) => ({ name: featureName(o.name), url: `${up.url}#${o.id}` })))
  }

  async function remove(up: Upload) {
    if (session.doc.features.some((f) => f.type === 'import' && f.url.startsWith(up.url))) {
      error = `${up.name} is used by an import feature; delete that feature first.`
      return
    }
    try {
      await api.deleteUpload(projectID, up.id)
      uploads = uploads.filter((u) => u.id !== up.id)
    } catch (e) {
      error = (e as Error).message
    }
  }

  const size = (b: number) => (b > 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`)
  const count = (n?: number) => (n ? (n >= 1000 ? `${Math.round(n / 1000)}k triangles` : `${n} triangles`) : '')
</script>

<div class="relative">
  <button class={['btn', open && 'on']} aria-expanded={open} onclick={toggle}><UploadIcon size={14} /> Import model</button>
  {#if open}
    <div class="pop absolute right-0 top-full z-30 mt-1 w-96 space-y-3 bg-surface p-3">
      <div class="flex items-start gap-2">
        <p class="min-w-0 flex-1 text-xs text-ink-2">STL, 3MF (also slicer projects) or STEP. STL and 3MF become mesh bodies: cut, join, pattern, check and export them as STL or 3MF.</p>
        <button class="btn btn-ghost px-1" aria-label="Close" onclick={() => (open = false)}><X size={14} /></button>
      </div>
      {#if canEdit}
        <button class="btn btn-primary w-full" disabled={!!busy || !session.ready} onclick={() => input.click()}><UploadIcon size={14} /> {busy || 'Upload a file…'}</button>
      {/if}
      {#if error}<p class="note danger text-xs">{error}</p>{/if}
      {#if uploads.length}
        <ul class="max-h-80 divide-y divide-line overflow-y-auto border border-line">
          {#each uploads as up (up.id)}
            <li class="space-y-1.5 px-2 py-1.5 text-xs">
              <div class="flex items-center gap-2">
                <Box size={13} class="shrink-0 text-ink-3" />
                <span class="min-w-0 flex-1 truncate font-medium" title={up.name}>{up.name}</span>
                <span class="num shrink-0 text-ink-3">{size(up.size)}</span>
                {#if canEdit && !up.objects?.length}
                  <button class="btn py-0.5 text-xs" disabled={!!busy} onclick={() => importAs([{ name: featureName(up.name), url: up.url }])}>Import</button>
                {/if}
                {#if canEdit}
                  <button class="btn btn-ghost px-1 hover:text-danger" title="Delete the file" aria-label={`Delete ${up.name}`} onclick={() => remove(up)}><Trash2 size={13} /></button>
                {/if}
              </div>
              {#if up.objects?.length}
                <div class="grid gap-1 pl-5">
                  {#each up.objects as o (o.id)}
                    <label class="flex items-center gap-2">
                      <input type="checkbox" disabled={!canEdit} checked={(picked[up.id] ?? []).includes(o.id)} onchange={() => toggleObject(up, o.id)} />
                      <span class="min-w-0 flex-1 truncate">{o.name} <span class="text-ink-3">#{o.id}</span></span>
                      <span class="num text-ink-3">{count(o.triangles)}</span>
                    </label>
                  {/each}
                  {#if canEdit}
                    <button class="btn mt-1 w-fit py-0.5 text-xs" disabled={!!busy || !(picked[up.id] ?? []).length} onclick={() => importObjects(up)}>Import {(picked[up.id] ?? []).length || ''} selected</button>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {:else if !error}
        <p class="text-xs text-ink-3">No files uploaded to this project yet.</p>
      {/if}
    </div>
  {/if}
</div>
<input bind:this={input} class="hidden" type="file" accept=".stl,.3mf,.step,.stp" onchange={onFile} aria-label="Upload a model file" />
