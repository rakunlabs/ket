import { z } from 'zod'

import type { Doc } from '../doc'
import { define } from '../registry'
import { resolvePin } from './commands'
import { electricalCheck } from './erc'

define({
  name: 'set_pin_rules', group: 'pcb', kind: 'mutate',
  description: 'Declare electrical intent from datasheets, never by guessing names: input/output/bidirectional/passive/power_in/power_out/open_drain/no_connect and whether a connection is required. Pin accepts REF.pad or REF.name (all matching pads). null clears an annotation. No-connect cannot also be required. Verify with run_erc and get_problems. Unknown pin types remain explicitly unverified.',
  args: z.object({ rules: z.array(z.object({ pin: z.string(), type: z.enum(['input', 'output', 'bidirectional', 'passive', 'power_in', 'power_out', 'open_drain', 'no_connect']).nullable(), required: z.boolean().optional() })).min(1).max(1024) }),
  apply(doc, a) {
    if (!doc.pcb) throw new Error('the project has no board yet; start with set_board')
    const next = JSON.parse(JSON.stringify(doc)) as Doc
    for (const rule of a.rules) {
      if (rule.type === 'no_connect' && rule.required) throw new Error(`${rule.pin}: no_connect cannot be required; choose a real electrical type or remove required`)
      const dot = rule.pin.indexOf('.')
      const staleOwner = next.pcb!.components.find((c) => c.ref === rule.pin.slice(0, dot))
      // A footprint refresh may remove a previously annotated pad. Clearing
      // that exact stale annotation must remain possible, not trap recovery.
      const resolved = rule.type === null && staleOwner?.pin_rules?.[rule.pin.slice(dot + 1)] ? [rule.pin] : resolvePin(next.pcb!, rule.pin)
      for (const canonical of resolved) {
        const dot = canonical.indexOf('.'), ref = canonical.slice(0, dot), pin = canonical.slice(dot + 1)
        const c = next.pcb!.components.find((c) => c.ref === ref)!
        c.pin_rules ??= {}
        if (rule.type === null) delete c.pin_rules[pin]
        else c.pin_rules[pin] = { type: rule.type, ...(rule.required !== undefined ? { required: rule.required } : {}) }
      }
    }
    return { doc: next, summary: `updated ${a.rules.length} electrical pin rule(s)` }
  },
})

define({
  name: 'run_erc', group: 'pcb', kind: 'query',
  description: 'Electrical rule check using explicit pin types: conflicting push-pull outputs/power sources, connected no-connect pins, required but unconnected pins, stale/multiply assigned pads, and unverified drivers. Returns severity, objects and actionable fixes plus typed/unknown coverage. Unknown types are not treated as passive. Does not certify voltage/current/analog behavior; use set_pin_rules from datasheets first.',
  args: z.object({}),
  run(ctx) {
    if (!ctx.doc.pcb) throw new Error('the project has no board yet; start with set_board')
    return electricalCheck(ctx.doc.pcb)
  },
})
