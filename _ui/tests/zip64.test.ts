import { describe, expect, it } from 'vitest'

import { unzip, zipStored } from '../src/engine/model-files'

/**
 * Rewrites a stored zip as zip64 the way large slicer projects are written:
 * 0xffffffff in the central directory's sizes and offset with the real
 * values in a zip64 extra field, 0xffffffff for the directory offset in the
 * end record, and a zip64 end record plus locator before it.
 */
function toZip64(zip: Uint8Array): Uint8Array {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const end = zip.length - 22
  const count = dv.getUint16(end + 10, true)
  const cdStart = dv.getUint32(end + 16, true)
  const parts: number[][] = []
  let p = cdStart
  for (let i = 0; i < count; i++) {
    const nameLen = dv.getUint16(p + 28, true)
    const head = Array.from(zip.subarray(p, p + 46 + nameLen))
    const hv = new DataView(new Uint8Array(head).buffer)
    const size = hv.getUint32(20, true)
    const unpacked = hv.getUint32(24, true)
    const local = hv.getUint32(42, true)
    const out = new DataView(new ArrayBuffer(head.length + 4 + 24))
    new Uint8Array(out.buffer).set(head)
    out.setUint32(20, 0xffffffff, true)
    out.setUint32(24, 0xffffffff, true)
    out.setUint32(42, 0xffffffff, true)
    out.setUint16(30, 28, true)
    const x = head.length
    out.setUint16(x, 1, true)
    out.setUint16(x + 2, 24, true)
    out.setBigUint64(x + 4, BigInt(unpacked), true)
    out.setBigUint64(x + 12, BigInt(size), true)
    out.setBigUint64(x + 20, BigInt(local), true)
    parts.push(Array.from(new Uint8Array(out.buffer)))
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true)
  }
  const cd = parts.flat()
  const end64At = cdStart + cd.length
  const e64 = new DataView(new ArrayBuffer(56))
  e64.setUint32(0, 0x06064b50, true)
  e64.setBigUint64(4, 44n, true)
  e64.setUint16(12, 45, true)
  e64.setUint16(14, 45, true)
  e64.setBigUint64(24, BigInt(count), true)
  e64.setBigUint64(32, BigInt(count), true)
  e64.setBigUint64(40, BigInt(cd.length), true)
  e64.setBigUint64(48, BigInt(cdStart), true)
  const loc = new DataView(new ArrayBuffer(20))
  loc.setUint32(0, 0x07064b50, true)
  loc.setBigUint64(8, BigInt(end64At), true)
  loc.setUint32(16, 1, true)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, 0xffff, true)
  eocd.setUint16(10, 0xffff, true)
  eocd.setUint32(12, 0xffffffff, true)
  eocd.setUint32(16, 0xffffffff, true)
  return new Uint8Array([...zip.subarray(0, cdStart), ...cd, ...new Uint8Array(e64.buffer), ...new Uint8Array(loc.buffer), ...new Uint8Array(eocd.buffer)])
}

describe('zip64', () => {
  it('reads archives with 64-bit sizes and offsets', async () => {
    const plain = new Uint8Array(await zipStored({ '3D/3dmodel.model': '<model/>', 'Metadata/plate_1.json': '{"a":1}' }).arrayBuffer())
    const files = unzip(toZip64(plain))
    expect([...files.keys()]).toEqual(['3D/3dmodel.model', 'Metadata/plate_1.json'])
    expect(new TextDecoder().decode(await files.get('Metadata/plate_1.json')!())).toBe('{"a":1}')
  })

  it('refuses a zip64 end record that is missing', () => {
    const plain = new Uint8Array(new ArrayBuffer(22))
    const dv = new DataView(plain.buffer)
    dv.setUint32(0, 0x06054b50, true)
    dv.setUint32(16, 0xffffffff, true)
    expect(() => unzip(plain)).toThrow(/zip64 end locator/)
  })

  it('refuses an entry that points past the end of the archive', async () => {
    const z = toZip64(new Uint8Array(await zipStored({ 'a.txt': 'hello' }).arrayBuffer()))
    // Point the entry's local header (zip64 extra, third field) far past the end.
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength)
    const cd = Number(dv.getBigUint64(z.length - 22 - 20 - 56 + 48, true))
    dv.setBigUint64(cd + 46 + 'a.txt'.length + 4 + 16, BigInt(z.length + 100), true)
    await expect(unzip(z).get('a.txt')!()).rejects.toThrow(/outside the archive/)
  })
})
