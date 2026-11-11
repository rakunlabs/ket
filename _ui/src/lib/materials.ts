// Display of materials and decals: UV mapping, procedural texture maps and
// PBR materials for three.js, and decals projected onto bodies. Everything
// here is display only; the document decides, this draws.

import * as THREE from 'three'
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

import type { Material, TextureMap, TexturePattern, UVMapping } from '../engine/doc'
import type { ResolvedDecal } from '../engine/kernel'

// ── UV mapping ─────────────────────────────────────────────────────────

const AXIS = { X: 0, Y: 1, Z: 2 } as const

/**
 * UVs in mm / scale from positions and normals, so a texture tiles at the
 * same physical size on every body. box picks per vertex the plane facing
 * its normal (triplanar without blending), planar projects along one axis,
 * cylindrical wraps around an axis (u = arc length on the mean radius).
 */
export function computeUV(positions: Float32Array, normals: Float32Array, uv: UVMapping | undefined): Float32Array {
  const n = positions.length / 3
  const out = new Float32Array(n * 2)
  const proj = uv?.projection ?? 'box'
  const scale = uv?.scale ?? 10
  const rot = ((uv?.rotation ?? 0) * Math.PI) / 180
  const [ou, ov] = uv?.offset ?? [0, 0]
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const ax = AXIS[uv?.axis ?? 'Z']

  let radius = 1
  if (proj === 'cylindrical') {
    let sum = 0
    for (let i = 0; i < n; i++) {
      const a = (ax + 1) % 3
      const b = (ax + 2) % 3
      sum += Math.hypot(positions[i * 3 + a], positions[i * 3 + b])
    }
    radius = sum / Math.max(n, 1) || 1
  }

  for (let i = 0; i < n; i++) {
    const p = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]
    let u: number
    let v: number
    if (proj === 'planar') {
      const a = (ax + 1) % 3
      const b = (ax + 2) % 3
      u = p[a]
      v = p[b]
    } else if (proj === 'cylindrical') {
      const a = (ax + 1) % 3
      const b = (ax + 2) % 3
      u = Math.atan2(p[b], p[a]) * radius
      v = p[ax]
    } else {
      const nx = Math.abs(normals[i * 3])
      const ny = Math.abs(normals[i * 3 + 1])
      const nz = Math.abs(normals[i * 3 + 2])
      if (nz >= nx && nz >= ny) {
        u = p[0]
        v = p[1]
      } else if (nx >= ny) {
        u = p[1]
        v = p[2]
      } else {
        u = p[0]
        v = p[2]
      }
    }
    u = (u + ou) / scale
    v = (v + ov) / scale
    out[i * 2] = u * c - v * s
    out[i * 2 + 1] = u * s + v * c
  }
  return out
}

// ── Procedural patterns ────────────────────────────────────────────────
// Each pattern is a tileable height field h(x, y) in 0..1 on the unit
// square; maps derive from it (albedo mixes, roughness shifts, normal from
// its gradient, AO from its depth).

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

/** Tileable value noise with period p cells. */
function valueNoise(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const w = (i: number) => ((i % p) + p) % p
  const a = hash(w(xi), w(yi), seed)
  const b = hash(w(xi + 1), w(yi), seed)
  const c = hash(w(xi), w(yi + 1), seed)
  const d = hash(w(xi + 1), w(yi + 1), seed)
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

function fbm(x: number, y: number, base: number, octaves: number, seed: number): number {
  let sum = 0
  let amp = 0.5
  let norm = 0
  let p = base
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * p, y * p, p, seed + o * 17) * amp
    norm += amp
    amp *= 0.5
    p *= 2
  }
  return sum / norm
}

const SIZE = 256

function heightField(pattern: TexturePattern, seed: number): Float32Array {
  const h = new Float32Array(SIZE * SIZE)
  // Scratches: a few random line segments, drawn once.
  let lines: [number, number, number, number, number][] = []
  if (pattern === 'scratches') {
    lines = Array.from({ length: 60 }, (_, i) => {
      const x = hash(i, 1, seed)
      const y = hash(i, 2, seed)
      const a = hash(i, 3, seed) * Math.PI
      const l = 0.05 + hash(i, 4, seed) * 0.35
      return [x, y, Math.cos(a) * l, Math.sin(a) * l, 0.3 + hash(i, 5, seed) * 0.7]
    })
  }
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      const x = i / SIZE
      const y = j / SIZE
      let v = 0
      switch (pattern) {
        case 'noise':
          v = fbm(x, y, 8, 5, seed)
          break
        case 'brushed':
          // Long streaks along u: high frequency across, low along.
          v = 0.6 * valueNoise(x * 2, y * 180, 180, seed) + 0.4 * valueNoise(x * 6, y * 60, 60, seed + 3)
          break
        case 'scratches': {
          v = 0.5 + 0.08 * (fbm(x, y, 16, 3, seed) - 0.5)
          for (const [lx, ly, dx, dy, depth] of lines) {
            for (const ox of [-1, 0, 1])
              for (const oy of [-1, 0, 1]) {
                const px = x - (lx + ox)
                const py = y - (ly + oy)
                const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)))
                const d = Math.hypot(px - dx * t, py - dy * t)
                if (d < 0.003) v = Math.min(v, 0.5 - depth * 0.5 * (1 - d / 0.003))
              }
          }
          break
        }
        case 'wood': {
          const warp = fbm(x, y, 4, 3, seed) * 0.6
          const rings = Math.sin((y * 12 + warp * 3) * Math.PI * 2)
          v = 0.5 + 0.35 * rings + 0.15 * (valueNoise(x * 4, y * 128, 128, seed + 9) - 0.5)
          break
        }
        case 'leather': {
          // Cellular: distance to the nearest of jittered points.
          const cells = 14
          const cx = Math.floor(x * cells)
          const cy = Math.floor(y * cells)
          let d1 = 9
          let d2 = 9
          for (let oy = -1; oy <= 1; oy++)
            for (let ox = -1; ox <= 1; ox++) {
              const gx = cx + ox
              const gy = cy + oy
              const wx = ((gx % cells) + cells) % cells
              const wy = ((gy % cells) + cells) % cells
              const px = (gx + hash(wx, wy, seed)) / cells
              const py = (gy + hash(wx, wy, seed + 1)) / cells
              const d = Math.hypot(x - px, y - py) * cells
              if (d < d1) {
                d2 = d1
                d1 = d
              } else if (d < d2) d2 = d
            }
          v = Math.min(1, (d2 - d1) * 2.2) * 0.85 + 0.15 * fbm(x, y, 32, 2, seed)
          break
        }
        case 'checker':
          v = (Math.floor(x * 2) + Math.floor(y * 2)) % 2
          break
        case 'grid': {
          const gx = Math.abs(((x * 4) % 1) - 0.5)
          const gy = Math.abs(((y * 4) % 1) - 0.5)
          v = Math.max(gx, gy) > 0.45 ? 0 : 1
          break
        }
        case 'dots': {
          const dx = ((x * 4) % 1) - 0.5
          const dy = ((y * 4) % 1) - 0.5
          v = Math.max(0, 1 - Math.hypot(dx, dy) / 0.32)
          break
        }
        case 'knurl': {
          // Diamond knurl: two crossing ridges at ±45°.
          const a = Math.abs((((x + y) * 4) % 1) - 0.5) * 2
          const b = Math.abs((((x - y + 4) * 4) % 1) - 0.5) * 2
          v = Math.min(a, b)
          break
        }
      }
      h[j * SIZE + i] = v
    }
  }
  return h
}

const fieldCache = new Map<string, Float32Array>()
function field(pattern: TexturePattern, seed: number): Float32Array {
  const key = `${pattern}:${seed}`
  let f = fieldCache.get(key)
  if (!f) {
    f = heightField(pattern, seed)
    fieldCache.set(key, f)
  }
  return f
}

function dataTexture(data: Uint8Array, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = 4
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.needsUpdate = true
  return t
}

const loader = new THREE.TextureLoader()

function imageTexture(url: string, srgb: boolean): THREE.Texture {
  const t = loader.load(url)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  return t
}

type Kind = 'albedo' | 'normal' | 'roughness' | 'metallic' | 'ao' | 'displacement'

function patternTexture(kind: Kind, m: TextureMap, mat: Material): THREE.Texture {
  const h = field(m.pattern!, m.seed ?? 1)
  const s = m.strength ?? 0.5
  const data = new Uint8Array(SIZE * SIZE * 4)
  const c1 = new THREE.Color(mat.color)
  const c2 = new THREE.Color(m.color2 ?? new THREE.Color(mat.color).multiplyScalar(0.55).getStyle())
  const base = (kind === 'roughness' ? mat.roughness ?? 0.6 : mat.metalness ?? 0) as number
  for (let i = 0; i < SIZE * SIZE; i++) {
    const v = h[i]
    const o = i * 4
    data[o + 3] = 255
    switch (kind) {
      case 'albedo': {
        // The texture holds the full color, so the material color is white.
        const t = v * s
        data[o] = Math.round((c1.r + (c2.r - c1.r) * t) * 255)
        data[o + 1] = Math.round((c1.g + (c2.g - c1.g) * t) * 255)
        data[o + 2] = Math.round((c1.b + (c2.b - c1.b) * t) * 255)
        break
      }
      case 'roughness':
      case 'metallic': {
        // three reads roughness from G and metalness from B; the scalar is 1.
        const val = Math.max(0, Math.min(1, base + (v - 0.5) * s))
        data[o] = data[o + 1] = data[o + 2] = Math.round(val * 255)
        break
      }
      case 'ao': {
        const val = 1 - (1 - v) * s
        data[o] = data[o + 1] = data[o + 2] = Math.round(val * 255)
        break
      }
      case 'displacement':
        data[o] = data[o + 1] = data[o + 2] = Math.round(v * 255)
        break
      case 'normal': {
        const x = i % SIZE
        const y = (i / SIZE) | 0
        const at = (xx: number, yy: number) => h[((yy + SIZE) % SIZE) * SIZE + ((xx + SIZE) % SIZE)]
        const k = 6 * s
        const dx = (at(x + 1, y) - at(x - 1, y)) * k
        const dy = (at(x, y + 1) - at(x, y - 1)) * k
        const len = Math.hypot(dx, dy, 1)
        data[o] = Math.round(((-dx / len) * 0.5 + 0.5) * 255)
        data[o + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255)
        data[o + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255)
        break
      }
    }
  }
  return dataTexture(data, kind === 'albedo')
}

const mapCache = new Map<string, THREE.Texture>()

function mapTexture(kind: Kind, m: TextureMap, mat: Material): THREE.Texture {
  const key = JSON.stringify([kind, m, mat.color, mat.roughness, mat.metalness, mat.uv?.scale])
  const hit = mapCache.get(key)
  if (hit) return hit
  const t = m.image ? imageTexture(m.image, kind === 'albedo') : patternTexture(kind, m, mat)
  // A map may tile at its own size: scale relative to the UV tile.
  const uvScale = mat.uv?.scale ?? 10
  if (m.scale) t.repeat.set(uvScale / m.scale, uvScale / m.scale)
  mapCache.set(key, t)
  return t
}

/**
 * Light budget of the realistic view. The studio environment already lights
 * every surface, so the sun only adds shape: together they stay under white,
 * and the neutral tone mapper keeps saturated colors (ACES bleached them).
 */
export const REAL_LIGHT = {
  toneMapping: THREE.NeutralToneMapping,
  exposure: 1,
  env: 0.5,
  hemi: 0.2,
  sun: 1.1,
  fill: 0.15,
} as const

/** A neutral studio environment so metals and gloss have something to reflect; one per renderer. */
const envs = new WeakMap<THREE.WebGLRenderer, THREE.Texture>()
export function environment(renderer: THREE.WebGLRenderer): THREE.Texture {
  let t = envs.get(renderer)
  if (!t) {
    const pm = new THREE.PMREMGenerator(renderer)
    t = pm.fromScene(new RoomEnvironment(), 0.04).texture
    pm.dispose()
    envs.set(renderer, t)
  }
  return t
}

/** True when the material needs UVs on the geometry. */
export function needsUV(m: Material | undefined): boolean {
  return !!m?.maps && Object.values(m.maps).some(Boolean)
}

/** A three.js material for a document material. */
export function pbrMaterial(m: Material, opts: { clip: THREE.Plane[]; side: THREE.Side; emissiveBoost?: number; env?: THREE.Texture }): THREE.MeshPhysicalMaterial {
  const maps = m.maps ?? {}
  const opacity = m.opacity ?? 1
  const mat = new THREE.MeshPhysicalMaterial({
    color: maps.albedo ? 0xffffff : new THREE.Color(m.color),
    metalness: maps.metallic ? 1 : m.metalness ?? 0,
    roughness: maps.roughness ? 1 : m.roughness ?? 0.6,
    clearcoat: m.clearcoat ?? 0,
    clearcoatRoughness: 0.1,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
    emissive: new THREE.Color(m.color),
    emissiveIntensity: (m.emissive ?? 0) + (opts.emissiveBoost ?? 0),
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    side: opts.side,
    clippingPlanes: opts.clip,
    envMap: opts.env ?? null,
    envMapIntensity: REAL_LIGHT.env,
  })
  if (maps.albedo) mat.map = mapTexture('albedo', maps.albedo, m)
  if (maps.roughness) mat.roughnessMap = mapTexture('roughness', maps.roughness, m)
  if (maps.metallic) mat.metalnessMap = mapTexture('metallic', maps.metallic, m)
  if (maps.normal) {
    mat.normalMap = mapTexture('normal', maps.normal, m)
    const k = maps.normal.image ? maps.normal.strength ?? 1 : 1
    mat.normalScale.set(k, k)
  }
  if (maps.ao) {
    mat.aoMap = mapTexture('ao', maps.ao, m)
    mat.aoMapIntensity = 1
  }
  if (maps.displacement) {
    mat.displacementMap = mapTexture('displacement', maps.displacement, m)
    const mm = maps.displacement.strength ?? 0.2
    mat.displacementScale = mm
    mat.displacementBias = -mm / 2
  }
  return mat
}

/** Frees a material; textures are shared through the caches and stay. */
export function disposeMaterial(mat: THREE.Material) {
  mat.dispose()
}

// ── Decals ─────────────────────────────────────────────────────────────

const decalTextures = new Map<string, THREE.Texture>()

function decalKey(d: ResolvedDecal) {
  return JSON.stringify([d.text, d.image, d.color, d.background, d.font, d.weight, d.align, d.valign, d.size, d.font_size])
}

/** The texture of a decal: text drawn on a canvas at ~20 px/mm, or the image. */
function decalTexture(d: ResolvedDecal): THREE.Texture {
  const key = decalKey(d)
  const hit = decalTextures.get(key)
  if (hit) return hit
  let t: THREE.Texture
  if (d.image) {
    t = loader.load(d.image)
    t.colorSpace = THREE.SRGBColorSpace
  } else {
    const [w, h] = d.size
    const pxmm = Math.min(24, 2048 / Math.max(w, h))
    const cw = Math.max(16, Math.round(w * pxmm))
    const ch = Math.max(16, Math.round(h * pxmm))
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')!
    if (d.background) {
      ctx.fillStyle = d.background
      ctx.fillRect(0, 0, cw, ch)
    }
    const lines = (d.text ?? '').split('\n')
    const family = d.font ?? 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif'
    const weight = d.weight ?? 500
    // font_size is the cap height; canvas sizes by em (cap ≈ 0.7 em).
    let em = d.font_size ? (d.font_size / 0.7) * pxmm : (ch / lines.length) * 0.8
    ctx.font = `${weight} ${em}px ${family}`
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 1)
    if (widest > cw * 0.96) {
      em *= (cw * 0.96) / widest
      ctx.font = `${weight} ${em}px ${family}`
    }
    ctx.fillStyle = d.color ?? '#111111'
    ctx.textAlign = d.align ?? 'center'
    ctx.textBaseline = 'middle'
    const lh = em * 1.15
    const total = lh * lines.length
    const valign = d.valign ?? 'middle'
    const y0 = valign === 'top' ? lh / 2 + ch * 0.02 : valign === 'bottom' ? ch - total + lh / 2 - ch * 0.02 : (ch - total) / 2 + lh / 2
    const x = ctx.textAlign === 'left' ? cw * 0.02 : ctx.textAlign === 'right' ? cw * 0.98 : cw / 2
    lines.forEach((l, i) => ctx.fillText(l, x, y0 + i * lh))
    t = new THREE.CanvasTexture(canvas)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
  }
  decalTextures.set(key, t)
  return t
}

/** Orientation of a decal projector: z along the normal, y toward up. */
function decalOrientation(d: ResolvedDecal): THREE.Euler {
  const z = new THREE.Vector3(...d.normal).normalize()
  let up = d.up ? new THREE.Vector3(...d.up) : Math.abs(z.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
  up = up.sub(z.clone().multiplyScalar(up.dot(z)))
  if (up.lengthSq() < 1e-9) up = Math.abs(z.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
  up.normalize()
  const x = new THREE.Vector3().crossVectors(up, z).normalize()
  const m = new THREE.Matrix4().makeBasis(x, up, z)
  if (d.rotation) m.multiply(new THREE.Matrix4().makeRotationZ((d.rotation * Math.PI) / 180))
  return new THREE.Euler().setFromRotationMatrix(m)
}

/** Decal meshes for one body mesh. */
export function decalObjects(body: THREE.Mesh, decals: ResolvedDecal[], clip: THREE.Plane[], env?: THREE.Texture): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  body.updateMatrixWorld()
  for (const d of decals) {
    const geo = new DecalGeometry(body, new THREE.Vector3(...d.at), decalOrientation(d), new THREE.Vector3(d.size[0], d.size[1], d.depth))
    if (!geo.attributes.position || geo.attributes.position.count === 0) {
      geo.dispose()
      continue
    }
    const mat = new THREE.MeshPhysicalMaterial({
      map: decalTexture(d),
      color: d.image && d.color ? new THREE.Color(d.color) : 0xffffff,
      transparent: true,
      opacity: d.opacity ?? 1,
      roughness: d.roughness ?? 0.5,
      metalness: d.metalness ?? 0,
      emissive: d.emissive ? 0xffffff : 0x000000,
      emissiveMap: d.emissive ? decalTexture(d) : null,
      emissiveIntensity: d.emissive ?? 0,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      clippingPlanes: clip,
      envMap: env ?? null,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = 3
    mesh.userData.decal = d.name
    out.push(mesh)
  }
  return out
}

/** Decal textures are shared by key; only their materials are disposed per mesh. */
export function disposeDecal(mesh: THREE.Mesh) {
  mesh.geometry.dispose()
  ;(mesh.material as THREE.Material).dispose()
}
