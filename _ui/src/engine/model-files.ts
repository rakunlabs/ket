// Triangle model files: STL, 3MF (and the zip container under it). Pure
// data in and out, no kernel: the kernel turns a TriMesh into a mesh body.

/** An indexed triangle mesh, in mm. */
export interface TriMesh {
  positions: Float32Array
  triangles: Uint32Array
}

// ── Zip ─────────────────────────────────────────────────────────────────

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}

export function isZip(b: ArrayBuffer | Uint8Array): boolean {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b)
  return u.length > 4 && u[0] === 0x50 && u[1] === 0x4b && u[2] === 0x03 && u[3] === 0x04
}

/** The files of a zip by name; each is inflated when read. */
export function unzip(buf: ArrayBuffer | Uint8Array): Map<string, () => Promise<Uint8Array>> {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength)
  let end = -1
  for (let i = u.length - 22; i >= Math.max(0, u.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('not a zip file (no central directory)')
  const count = dv.getUint16(end + 10, true)
  let p = dv.getUint32(end + 16, true)
  if (p === 0xffffffff) throw new Error('zip64 archives are not supported; save the 3MF again from the slicer')
  const dec = new TextDecoder()
  const out = new Map<string, () => Promise<Uint8Array>>()
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('broken zip central directory')
    const method = dv.getUint16(p + 10, true)
    const size = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const local = dv.getUint32(p + 42, true)
    const name = dec.decode(u.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    out.set(name, async () => {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true)
      const raw = u.subarray(start, start + size)
      if (method === 0) return raw
      if (method === 8) return pipe(raw, new DecompressionStream('deflate-raw'))
      throw new Error(`zip entry ${name} uses compression method ${method}; only stored and deflate are supported`)
    })
  }
  return out
}

/** A zip of the files, deflated (stored when the runtime cannot compress). */
export async function zipFiles(files: Record<string, string | Uint8Array>): Promise<Blob> {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const canDeflate = typeof CompressionStream !== 'undefined'
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? enc.encode(content) : content
    const packed = canDeflate ? await pipe(data, new CompressionStream('deflate-raw')) : data
    const method = canDeflate ? 8 : 0
    const n = enc.encode(name)
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(8, method, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, packed.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, n.length, true)
    parts.push(new Uint8Array(local.buffer), n, packed)
    const c = new DataView(new ArrayBuffer(46))
    c.setUint32(0, 0x02014b50, true)
    c.setUint16(4, 20, true)
    c.setUint16(6, 20, true)
    c.setUint16(10, method, true)
    c.setUint32(16, crc, true)
    c.setUint32(20, packed.length, true)
    c.setUint32(24, data.length, true)
    c.setUint16(28, n.length, true)
    c.setUint32(42, offset, true)
    central.push(new Uint8Array(c.buffer), n)
    offset += 30 + n.length + packed.length
  }
  const size = central.reduce((s, b) => s + b.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, Object.keys(files).length, true)
  end.setUint16(10, Object.keys(files).length, true)
  end.setUint32(12, size, true)
  end.setUint32(16, offset, true)
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[])
}

// ── STL ─────────────────────────────────────────────────────────────────

export function isBinarySTL(b: ArrayBuffer): boolean {
  if (b.byteLength < 84) return false
  const n = new DataView(b).getUint32(80, true)
  if (84 + n * 50 === b.byteLength) return true
  return !new TextDecoder().decode(new Uint8Array(b, 0, 5)).startsWith('solid')
}

/** STL triangles as a soup: three new vertices per triangle (weld before use). */
export function parseSTL(b: ArrayBuffer): TriMesh {
  if (isBinarySTL(b)) {
    const dv = new DataView(b)
    const n = dv.getUint32(80, true)
    if (84 + n * 50 > b.byteLength) throw new Error(`the STL says it has ${n} triangles but the file is too short`)
    const positions = new Float32Array(n * 9)
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12
      for (let k = 0; k < 9; k++) positions[i * 9 + k] = dv.getFloat32(o + k * 4, true)
    }
    return { positions, triangles: sequence(n * 3) }
  }
  const text = new TextDecoder().decode(b)
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g
  const pts: number[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) pts.push(+m[1], +m[2], +m[3])
  const n = Math.floor(pts.length / 9)
  return { positions: Float32Array.from(pts.slice(0, n * 9)), triangles: sequence(n * 3) }
}

function sequence(n: number): Uint32Array {
  const t = new Uint32Array(n)
  for (let i = 0; i < n; i++) t[i] = i
  return t
}

/** A binary STL of triangle meshes. */
export function writeSTL(meshes: TriMesh[]): Blob {
  const total = meshes.reduce((s, m) => s + m.triangles.length / 3, 0)
  const buf = new ArrayBuffer(84 + total * 50)
  const dv = new DataView(buf)
  dv.setUint32(80, total, true)
  let o = 84
  for (const m of meshes) {
    const p = m.positions
    const t = m.triangles
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3
      const b = t[i + 1] * 3
      const c = t[i + 2] * 3
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      const l = Math.hypot(nx, ny, nz) || 1
      nx /= l
      ny /= l
      nz /= l
      dv.setFloat32(o, nx, true)
      dv.setFloat32(o + 4, ny, true)
      dv.setFloat32(o + 8, nz, true)
      for (const [k, v] of [a, b, c].entries()) {
        dv.setFloat32(o + 12 + k * 12, p[v], true)
        dv.setFloat32(o + 16 + k * 12, p[v + 1], true)
        dv.setFloat32(o + 20 + k * 12, p[v + 2], true)
      }
      o += 50
    }
  }
  return new Blob([buf])
}

// ── 3MF ─────────────────────────────────────────────────────────────────

/** One build item of a 3MF: what the slicer shows as an object. */
export interface ThreeMFObject {
  /** The object id of the build item (what #<id> picks). */
  id: string
  name: string
}

interface MeshPart {
  path: string
  id: string
  /** Row-vector 3MF transform (12 numbers) from the part to the item. */
  transform: number[]
}

export interface ThreeMF {
  objects: ThreeMFObject[]
  /** The triangles of a build item in plate coordinates (mm). */
  mesh(id: string): Promise<TriMesh>
}

const UNITS: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}\\s*=\\s*"([^"]*)"`)
  return re.exec(tag)?.[1]
}

function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    if (k === 'amp') return '&'
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16))
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10))
    return m
  })
}

function parseTransform(s: string | undefined): number[] {
  if (!s) return IDENTITY
  const v = s.trim().split(/\s+/).map(Number)
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) throw new Error(`bad 3MF transform "${s}"`)
  return v
}

/** a then b (row vectors: p · a · b). */
function compose(a: number[], b: number[]): number[] {
  const out = new Array<number>(12)
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++) {
      let s = r === 3 ? b[9 + c] : 0
      for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c]
      out[r * 3 + c] = s
    }
  return out
}

interface ObjectDef {
  name?: string
  mesh?: { start: number; end: number }
  components?: { id: string; path?: string; transform: number[] }[]
}

/** Objects of one model file, by id; meshes are left as text ranges until used. */
function scanObjects(xml: string): Map<string, ObjectDef> {
  const out = new Map<string, ObjectDef>()
  let i = 0
  for (;;) {
    const open = xml.indexOf('<object', i)
    if (open < 0) break
    const tagEnd = xml.indexOf('>', open)
    const tag = xml.slice(open, tagEnd)
    const close = xml.indexOf('</object>', tagEnd)
    if (close < 0) throw new Error('broken 3MF model: <object> without </object>')
    const id = attr(tag, 'id')
    const def: ObjectDef = { name: attr(tag, 'name') && unescapeXml(attr(tag, 'name')!) }
    const meshAt = xml.indexOf('<mesh', tagEnd)
    if (meshAt >= 0 && meshAt < close) def.mesh = { start: meshAt, end: close }
    const compAt = xml.indexOf('<components', tagEnd)
    if (compAt >= 0 && compAt < close) {
      def.components = []
      const re = /<component\b([^>]*)\/?>/g
      re.lastIndex = compAt
      for (let m = re.exec(xml); m && m.index < close; m = re.exec(xml)) {
        def.components.push({ id: attr(m[1], 'objectid') ?? '', path: attr(m[1], 'p:path'), transform: parseTransform(attr(m[1], 'transform')) })
      }
    }
    if (id) out.set(id, def)
    i = close + 9
  }
  return out
}

function parseMesh(xml: string, start: number, end: number): TriMesh {
  const pos: number[] = []
  const vre = /<vertex\b([^>]*)\/?>/g
  vre.lastIndex = start
  const trisAt = xml.indexOf('<triangles', start)
  const vEnd = trisAt >= 0 && trisAt < end ? trisAt : end
  for (let m = vre.exec(xml); m && m.index < vEnd; m = vre.exec(xml)) {
    const a = m[1]
    pos.push(Number(attr(a, 'x')), Number(attr(a, 'y')), Number(attr(a, 'z')))
  }
  const tri: number[] = []
  const tre = /<triangle\b([^>]*)\/?>/g
  tre.lastIndex = vEnd
  for (let m = tre.exec(xml); m && m.index < end; m = tre.exec(xml)) {
    const a = m[1]
    tri.push(Number(attr(a, 'v1')), Number(attr(a, 'v2')), Number(attr(a, 'v3')))
  }
  const n = pos.length / 3
  for (const v of tri) if (!(v >= 0 && v < n)) throw new Error(`3MF triangle uses vertex ${v}, but the mesh has ${n}`)
  return { positions: Float32Array.from(pos), triangles: Uint32Array.from(tri) }
}

/** Reads a 3MF: its build items, and their triangles on demand. */
export async function read3MF(buf: ArrayBuffer | Uint8Array): Promise<ThreeMF> {
  const files = unzip(buf)
  const dec = new TextDecoder()
  const text = async (path: string) => {
    const f = files.get(path.replace(/^\//, ''))
    if (!f) throw new Error(`the 3MF has no ${path}`)
    return dec.decode(await f())
  }
  let root = '/3D/3dmodel.model'
  if (files.has('_rels/.rels')) {
    const rels = await text('_rels/.rels')
    const m = /<Relationship\b[^>]*Target="([^"]+)"[^>]*Type="[^"]*3dmodel"|<Relationship\b[^>]*Type="[^"]*3dmodel"[^>]*Target="([^"]+)"/.exec(rels)
    if (m) root = m[1] ?? m[2]
  }
  if (!root.startsWith('/')) root = '/' + root
  const rootXml = await text(root)
  const unit = UNITS[attr(/<model\b[^>]*>/.exec(rootXml)?.[0] ?? '', 'unit') ?? 'millimeter'] ?? 1
  const models = new Map<string, Promise<{ xml: string; objects: Map<string, ObjectDef> }>>()
  const model = (path: string) => {
    let m = models.get(path)
    if (!m) {
      m = (path === root ? Promise.resolve(rootXml) : text(path)).then((xml) => ({ xml, objects: scanObjects(xml) }))
      models.set(path, m)
    }
    return m
  }
  const rootObjects = (await model(root)).objects

  // Slicers (Bambu Studio, Orca, Prusa) keep object names in their own config.
  const names = new Map<string, string>()
  for (const cfg of ['Metadata/model_settings.config', 'Metadata/Slic3r_PE_model.config']) {
    if (!files.has(cfg)) continue
    const xml = await text(cfg)
    const re = /<object\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/object>/g
    for (let m = re.exec(xml); m; m = re.exec(xml)) {
      const n = /<metadata\s+(?:type="object"\s+)?key="name"\s+value="([^"]*)"/.exec(m[2])
      if (n) names.set(m[1], unescapeXml(n[1]))
    }
  }

  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(rootXml)?.[1] ?? ''
  const items: { id: string; path: string; transform: number[] }[] = []
  for (const m of build.matchAll(/<item\b([^>]*)\/?>/g)) {
    items.push({ id: attr(m[1], 'objectid') ?? '', path: attr(m[1], 'p:path') ?? root, transform: parseTransform(attr(m[1], 'transform')) })
  }
  if (!items.length) throw new Error('the 3MF has no build items (nothing to print)')
  const objects = items.map((it) => ({ id: it.id, name: names.get(it.id) ?? rootObjects.get(it.id)?.name ?? `object ${it.id}` }))

  const parts = async (path: string, id: string, transform: number[], depth: number, out: MeshPart[]) => {
    if (depth > 16) throw new Error('3MF components nest too deep')
    const def = (await model(path)).objects.get(id)
    if (!def) throw new Error(`the 3MF has no object ${id} in ${path}`)
    if (def.mesh) out.push({ path, id, transform })
    for (const c of def.components ?? []) await parts(c.path ?? path, c.id, compose(c.transform, transform), depth + 1, out)
  }
  const meshes = new Map<string, TriMesh>()

  return {
    objects,
    async mesh(id: string) {
      const item = items.find((it) => it.id === id)
      if (!item) throw new Error(`the 3MF has no build item for object ${id}`)
      const list: MeshPart[] = []
      await parts(item.path, item.id, item.transform, 0, list)
      if (!list.length) throw new Error(`object ${id} of the 3MF has no mesh`)
      const pieces: TriMesh[] = []
      for (const p of list) {
        const key = `${p.path}#${p.id}`
        let m = meshes.get(key)
        if (!m) {
          const { xml, objects: defs } = await model(p.path)
          const r = defs.get(p.id)!.mesh!
          m = parseMesh(xml, r.start, r.end)
          meshes.set(key, m)
        }
        pieces.push(transformMesh(m, p.transform, unit))
      }
      return mergeMeshes(pieces)
    },
  }
}

function transformMesh(m: TriMesh, t: number[], unit: number): TriMesh {
  const p = m.positions
  const out = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2]
    out[i] = (x * t[0] + y * t[3] + z * t[6] + t[9]) * unit
    out[i + 1] = (x * t[1] + y * t[4] + z * t[7] + t[10]) * unit
    out[i + 2] = (x * t[2] + y * t[5] + z * t[8] + t[11]) * unit
  }
  // A mirroring transform turns the triangles inside out.
  const det = t[0] * (t[4] * t[8] - t[5] * t[7]) - t[1] * (t[3] * t[8] - t[5] * t[6]) + t[2] * (t[3] * t[7] - t[4] * t[6])
  let tri = m.triangles
  if (det < 0) {
    tri = tri.slice()
    for (let i = 0; i < tri.length; i += 3) [tri[i + 1], tri[i + 2]] = [tri[i + 2], tri[i + 1]]
  }
  return { positions: out, triangles: tri }
}

export function mergeMeshes(list: TriMesh[]): TriMesh {
  if (list.length === 1) return list[0]
  const positions = new Float32Array(list.reduce((s, m) => s + m.positions.length, 0))
  const triangles = new Uint32Array(list.reduce((s, m) => s + m.triangles.length, 0))
  let pv = 0
  let pt = 0
  for (const m of list) {
    positions.set(m.positions, pv * 3)
    for (let i = 0; i < m.triangles.length; i++) triangles[pt + i] = m.triangles[i] + pv
    pv += m.positions.length / 3
    pt += m.triangles.length
  }
  return { positions, triangles }
}

/** Picks the build item a #fragment names: an object id, or a name that is unique. */
export function pickObject(f: ThreeMF, fragment: string, file: string): ThreeMFObject {
  const list = f.objects.map((o) => `#${o.id} (${o.name})`).join(', ')
  if (!fragment) {
    if (f.objects.length === 1) return f.objects[0]
    throw new Error(`${file} holds ${f.objects.length} objects: add #<id> to the url to pick one: ${list}`)
  }
  const byId = f.objects.find((o) => o.id === fragment)
  if (byId) return byId
  const byName = f.objects.filter((o) => o.name === fragment)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw new Error(`${byName.length} objects of ${file} are named "${fragment}": pick one by id: ${byName.map((o) => `#${o.id}`).join(', ')}`)
  throw new Error(`${file} has no object "${fragment}"; it holds ${list}`)
}

export interface Write3MFObject {
  name: string
  mesh: TriMesh
  color?: string
}

/** A plain 3MF (core spec) with one object per body, placed as built. */
export async function write3MF(objects: Write3MFObject[]): Promise<Blob> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const colors = [...new Set(objects.flatMap((o) => (o.color ? [toColor(o.color)] : [])))]
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    ' <metadata name="Application">Ket</metadata>\n <resources>\n',
  ]
  if (colors.length) out.push(`  <basematerials id="1">\n${colors.map((c, i) => `   <base name="color${i}" displaycolor="${c}"/>\n`).join('')}  </basematerials>\n`)
  objects.forEach((o, i) => {
    const id = i + 2
    const color = o.color ? colors.indexOf(toColor(o.color)) : -1
    out.push(`  <object id="${id}" name="${esc(o.name)}" type="model"${color >= 0 ? ` pid="1" pindex="${color}"` : ''}>\n   <mesh>\n    <vertices>\n`)
    const p = o.mesh.positions
    const chunk: string[] = []
    for (let k = 0; k < p.length; k += 3) {
      chunk.push(`     <vertex x="${num(p[k])}" y="${num(p[k + 1])}" z="${num(p[k + 2])}"/>\n`)
      if (chunk.length >= 4096) out.push(chunk.splice(0).join(''))
    }
    out.push(chunk.splice(0).join(''), '    </vertices>\n    <triangles>\n')
    const t = o.mesh.triangles
    for (let k = 0; k < t.length; k += 3) {
      chunk.push(`     <triangle v1="${t[k]}" v2="${t[k + 1]}" v3="${t[k + 2]}"/>\n`)
      if (chunk.length >= 4096) out.push(chunk.splice(0).join(''))
    }
    out.push(chunk.join(''), '    </triangles>\n   </mesh>\n  </object>\n')
  })
  out.push(' </resources>\n <build>\n')
  objects.forEach((_, i) => out.push(`  <item objectid="${i + 2}"/>\n`))
  out.push(' </build>\n</model>\n')
  const enc = new TextEncoder()
  const model = enc.encode(out.join(''))
  return zipFiles({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n',
    '3D/3dmodel.model': model,
  })
}

function num(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toPrecision(9).replace(/\.?0+$/, '')
}

function toColor(c: string): string {
  const s = c.trim()
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase()
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s.slice(1).split('').map((x) => x + x).join('')).toUpperCase()
  return '#C8C8C8'
}
