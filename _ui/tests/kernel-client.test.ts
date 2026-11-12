import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyDoc } from '../src/engine/doc'
import { KernelClient } from '../src/lib/kernel-client'

vi.mock('../src/lib/api', () => ({ base: '' }))
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

class FakeWorker {
  static workers: FakeWorker[] = []
  onmessage?: (ev: { data: unknown }) => void
  onerror?: (ev: { message: string }) => void
  messages: { id: number; type: string }[] = []
  terminated = false
  constructor() { FakeWorker.workers.push(this) }
  postMessage(message: { id: number; type: string }) { this.messages.push(message) }
  terminate() { this.terminated = true }
  answer(result: unknown) { this.onmessage?.({ data: { id: this.messages.at(-1)!.id, ok: true, result } }) }
}

describe('kernel executor recovery', () => {
  let client: KernelClient
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWorker.workers = []
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('location', { origin: 'http://localhost' })
    client = new KernelClient()
  })
  afterEach(() => { client.dispose(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('rejects interrupted work, clears its timeout and starts a fresh worker', async () => {
    const pending = client.build(emptyDoc())
    const failed = expect(pending).rejects.toThrow(/cancelled/)
    await flush()
    client.restart()
    await failed
    expect(FakeWorker.workers[0].terminated).toBe(true)
    expect(FakeWorker.workers).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    const result = client.build(emptyDoc())
    await flush()
    FakeWorker.workers[1].answer({ build: { ok: true }, meshes: [], sketches: [] })
    expect((await result).build.ok).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a stuck task and does not loop on worker script failures', async () => {
    let pending = client.build(emptyDoc())
    const timed = expect(pending).rejects.toThrow(/exceeded 300 seconds/)
    await flush()
    await vi.advanceTimersByTimeAsync(300_000)
    await timed
    expect(FakeWorker.workers).toHaveLength(2)
    pending = client.build(emptyDoc())
    const failed = expect(pending).rejects.toThrow(/failed/)
    await flush()
    FakeWorker.workers[1].onerror?.({ message: 'script unavailable' })
    await failed
    expect(FakeWorker.workers).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a document build and its query atomic against concurrent previews', async () => {
    const a = emptyDoc(), b = emptyDoc()
    const measured = client.api(a).measure('part')
    const other = client.build(b)
    await flush()
    const worker = FakeWorker.workers[0]
    expect(worker.messages.at(-1)!.type).toBe('build')
    worker.answer({ build: { ok: true }, meshes: [], sketches: [] })
    await flush()
    // Previously build B could run here and make A's measure read B instead.
    expect(worker.messages.at(-1)!.type).toBe('measure')
    worker.answer({ volume: 12 })
    expect(await measured).toEqual({ volume: 12 })
    await flush()
    expect(worker.messages.at(-1)!.type).toBe('build')
    worker.answer({ build: { ok: true }, meshes: [], sketches: [] })
    await other
    expect(vi.getTimerCount()).toBe(0)
  })
})
