import type { MeshData } from './kernel'

// Keep the copied attributes and the transfer list in sync. Transferring even
// one cached attribute detaches it and breaks the next unchanged build.
const attributes = ['vertices', 'normals', 'triangles', 'edges', 'edgeGroups', 'faceGroups'] as const

export function meshTransfer(meshes: MeshData[]) {
  const transfer: ArrayBuffer[] = []
  const out = meshes.map((mesh) => {
    const copy = { ...mesh }
    for (const key of attributes) {
      const data = mesh[key].slice()
      Object.assign(copy, { [key]: data })
      transfer.push(data.buffer)
    }
    return copy
  })
  return { meshes: out, transfer }
}
