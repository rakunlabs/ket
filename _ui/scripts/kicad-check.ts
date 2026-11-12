// Fails when KiCad's DRC report (kicad-cli pcb drc --format json) has
// errors or unconnected items: the independent check of export_kicad.
// Warnings that only say the "ket" footprint library is not configured are
// expected (footprints are embedded in the board) and ignored.
import { readFileSync } from 'node:fs'

const report = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  violations: { type: string; severity: string; description: string; items: { description: string }[] }[]
  unconnected_items: unknown[]
}
const real = report.violations.filter((v) => v.type !== 'lib_footprint_issues' && v.type !== 'lib_footprint_mismatch')
for (const v of real) console.log(`${v.severity} ${v.type}: ${v.description} (${v.items.map((i) => i.description).join(', ')})`)
console.log(`${real.length} violation(s), ${report.unconnected_items.length} unconnected item(s)`)
if (real.some((v) => v.severity === 'error') || report.unconnected_items.length) process.exit(1)
