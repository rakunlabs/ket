import type { Pcb, PinType } from '../doc'

export interface ElectricalIssue {
  rule: string
  severity: 'error' | 'warning'
  message: string
  objects: string[]
  fix: string
}

/** Conservative ERC: only explicit pin types are authoritative. Unknown is never passive. */
export function electricalCheck(pcb: Pcb) {
  const issues: ElectricalIssue[] = []
  const pins = new Map<string, { type?: PinType; required?: boolean }>()
  for (const c of pcb.components) for (const p of c.footprint.pads) pins.set(`${c.ref}.${p.number}`, c.pin_rules?.[p.number] ?? {})
  for (const c of pcb.components) for (const number of Object.keys(c.pin_rules ?? {})) {
    if (!pins.has(`${c.ref}.${number}`)) issues.push({ rule: 'pin_rule_missing_pad', severity: 'error', message: `${c.ref}.${number} has an electrical rule but no longer exists in the footprint`, objects: [`${c.ref}.${number}`], fix: 'Review the refreshed footprint and restore the intended pin mapping before manufacturing.' })
  }
  const pinNets = new Map<string, string[]>()
  for (const net of pcb.nets) {
    for (const pin of net.pins) {
      if (!pins.has(pin)) issues.push({ rule: 'missing_pin', severity: 'error', message: `${net.name} refers to missing pad ${pin}`, objects: [net.name, pin], fix: 'Reconnect the net to a real pad or remove the stale pin with disconnect.' })
      pinNets.set(pin, [...(pinNets.get(pin) ?? []), net.name])
    }
    const typed = [...new Set(net.pins)].map((pin) => ({ pin, ...pins.get(pin) }))
    for (const [type, rule] of [['output', 'output_conflict'], ['power_out', 'power_conflict']] as const) {
      const drivers = typed.filter((p) => p.type === type).map((p) => p.pin)
      if (drivers.length > 1) issues.push({ rule, severity: 'error', message: `${net.name} connects multiple ${type} pins: ${drivers.join(', ')}`, objects: [net.name, ...drivers], fix: 'Separate the outputs, or correct their explicitly declared types after checking the datasheets; wired-OR outputs should be open_drain.' })
    }
    const powerInputs = typed.filter((p) => p.type === 'power_in').map((p) => p.pin)
    if (powerInputs.length && !typed.some((p) => p.type === 'power_out')) issues.push({ rule: 'power_not_driven', severity: 'warning', message: `${net.name} has power inputs but no declared power source`, objects: [net.name, ...powerInputs], fix: 'Check the supply path and mark its connector/regulator source as power_out using set_pin_rules. ERC does not infer sources through passive parts.' })
    const signalInputs = typed.filter((p) => p.type === 'input').map((p) => p.pin)
    if (signalInputs.length && !typed.some((p) => ['output', 'bidirectional', 'open_drain', 'power_out'].includes(p.type ?? ''))) issues.push({ rule: 'input_not_driven', severity: 'warning', message: `${net.name} has inputs but no declared signal driver`, objects: [net.name, ...signalInputs], fix: 'Check the source and its pin type; passive networks and analog behavior require manual review.' })
  }
  for (const [pin, rule] of pins) {
    const nets = pinNets.get(pin) ?? []
    if (nets.length > 1) issues.push({ rule: 'pin_multiple_nets', severity: 'error', message: `${pin} belongs to multiple nets: ${nets.join(', ')}`, objects: [pin, ...nets], fix: 'Assign each physical pad to exactly one net.' })
    if (rule.type === 'no_connect' && nets.length) issues.push({ rule: 'no_connect_connected', severity: 'error', message: `${pin} is marked no_connect but belongs to ${nets.join(', ')}`, objects: [pin, ...nets], fix: 'Disconnect the pad or correct its pin rule after checking the datasheet.' })
    if (rule.required && (!nets.length || nets.every((name) => (pcb.nets.find((n) => n.name === name)?.pins.length ?? 0) < 2))) issues.push({ rule: 'required_pin_unconnected', severity: 'error', message: `${pin} requires a connection but has no other connected pad`, objects: [pin], fix: 'Connect this pad to its intended signal/supply, or explicitly remove required after reviewing the datasheet.' })
  }
  const typed = [...pins.values()].filter((p) => p.type).length
  return { ok: !issues.some((i) => i.severity === 'error'), coverage: { typed, total: pins.size, unknown: pins.size - typed }, issues, limitations: 'Only explicitly declared pin types are checked. No voltage, current, analog, timing or circuit-function certification; untyped pins are not assumed safe.' }
}
