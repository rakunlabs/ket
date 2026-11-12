// Structured diagnostics are the AI API; the Problems panel is just a client.
import { z } from 'zod'

import type { Check } from './doc'
import { diffDocs } from './diff'
import { applyOp, define, type Ctx, type FocusTarget } from './registry'
import { prepareOperation, requireHealthyHistory } from './operations'
import { electricalCheck } from './pcb/erc'

export type ProblemDomain = 'history' | 'cad' | 'pcb' | 'electrical' | 'manufacturing'
export interface DesignProblem {
  id: string
  domain: ProblemDomain
  severity: 'error' | 'warning'
  rule: string
  message: string
  objects: string[]
  fix: string
  suggested_commands: string[]
  measured?: number
  required?: number
  location?: { at: [number, number]; side?: 'top' | 'bottom' }
}

const commandsFor = (rule: string) => rule.startsWith('silk_') ? ['update_board_artwork', 'render_board', 'run_drc'] : ['outside_board', 'courtyard_overlap'].includes(rule) ? ['move_component', 'edit_copper', 'autoroute', 'run_drc'] : ['get_board', 'set_net_class', 'edit_copper', 'autoroute', 'run_drc']
const checkObjects = (c: Check | undefined): string[] => !c ? [] : 'a' in c ? [c.a, c.b] : 'inner' in c ? [c.inner, c.outer] : 'target' in c ? [c.target] : []

export async function designProblems(ctx: Ctx) {
  const build = await ctx.kernel.build()
  const checks = await ctx.kernel.checks()
  const board = ctx.doc.pcb ? await ctx.kernel.board({ drc: true }) : undefined
  const erc = ctx.doc.pcb ? electricalCheck(ctx.doc.pcb) : undefined
  const map = new Map<string, DesignProblem>()
  const add = (p: Omit<DesignProblem, 'id'>) => {
    // IDs depend on the rule and affected objects, not measured values or list order.
    const id = `${p.domain}:${p.rule}:${encodeURIComponent(p.objects.length ? [...p.objects].sort().join('|') : p.message)}`
    map.set(id, { ...p, id })
  }
  if (ctx.recovery) add({ domain: 'history', severity: 'error', rule: 'replay_failed', message: `Operation ${ctx.recovery.seq} (${ctx.recovery.cmd}) cannot be replayed: ${ctx.recovery.error}`, objects: [`operation ${ctx.recovery.seq}`], fix: `No edits/exports are allowed on this partial design. Reload a compatible Ket build or undo to operation ${ctx.recovery.last_good_seq}. Inspect get_history first.`, suggested_commands: ['get_history', 'get_document', 'undo'] })
  if (build.parameterError) add({ domain: 'cad', severity: 'error', rule: 'parameter', message: build.parameterError, objects: [], fix: 'Correct the expression or define its missing parameter with set_parameters.', suggested_commands: ['get_document', 'set_parameters'] })
  for (const f of build.features) {
    if (!f.ok) add({ domain: 'cad', severity: 'error', rule: 'feature_failed', message: f.error ?? `${f.name} failed`, objects: [f.name], fix: 'Read get_feature and its dependencies, then update_feature or replace the failed feature. Re-run get_problems.', suggested_commands: ['get_feature', 'update_feature', 'run_checks'] })
    if (f.warnings?.length) add({ domain: 'cad', severity: 'warning', rule: 'feature_warning', message: f.warnings.join('; '), objects: [f.name], fix: 'Inspect the feature and render its result; a successful build may still miss the intended geometry.', suggested_commands: ['get_feature', 'render', 'measure'] })
  }
  for (const c of checks.filter((c) => !c.ok)) add({ domain: 'cad', severity: 'error', rule: `check_${c.name}`, message: `${c.name}: ${c.detail}`, objects: checkObjects(ctx.doc.checks.find((x) => x.name === c.name)), fix: c.note ?? 'Adjust the design to satisfy this requirement. Do not delete or weaken a requirement just to pass it.', suggested_commands: ['measure_between', 'get_document', 'update_feature', 'set_parameters'] })
  for (const message of build.appearance ?? []) add({ domain: 'cad', severity: 'warning', rule: 'appearance', message, objects: [], fix: 'Correct the material/decal target or its dimensions; verify with a realistic render.', suggested_commands: ['get_document', 'set_material', 'render'] })
  if (build.features.length && !ctx.doc.checks.length) add({ domain: 'cad', severity: 'warning', rule: 'requirements_missing', message: 'No explicit design requirements have been added.', objects: [], fix: 'Translate fit, wall and clearance requirements into set_checks before treating this design as verified.', suggested_commands: ['set_checks', 'run_checks'] })
  if (ctx.doc.pcb && !board) add({ domain: 'pcb', severity: 'error', rule: 'board_unavailable', message: 'The PCB could not be resolved.', objects: ['board'], fix: 'Correct the board outline, sketches and parameters first.', suggested_commands: ['get_board', 'set_board', 'solve_sketch'] })
  for (const v of board?.drc ?? []) add({ domain: v.rule.startsWith('silk_') ? 'manufacturing' : 'pcb', severity: 'error', rule: v.rule, message: v.message, objects: v.objects ?? [], fix: v.fix ?? 'Read the affected geometry in get_board and move/reroute or resize it to satisfy the reported rule.', suggested_commands: commandsFor(v.rule), measured: v.measured, required: v.required, ...(v.at ? { location: { at: v.at } } : {}) })
  for (const line of board?.ratsnest.lines ?? []) add({ domain: 'pcb', severity: 'error', rule: 'unrouted', message: `${line.net}: ${line.from} is not connected to ${line.to}`, objects: [line.net, line.from, line.to], fix: 'Route this net, then refill zones and run_drc. Move crowded components if no legal route exists.', suggested_commands: ['get_board', 'autoroute', 'move_component', 'run_drc'], location: { at: line.a } })
  for (const issue of erc?.issues ?? []) add({ domain: 'electrical', ...issue, suggested_commands: ['get_board', 'set_pin_rules', 'connect', 'disconnect', 'run_erc'] })
  if (erc?.coverage.unknown) add({ domain: 'electrical', severity: 'warning', rule: 'pin_types_unknown', message: `${erc.coverage.unknown}/${erc.coverage.total} pads have no declared electrical type; ERC coverage is incomplete.`, objects: [], fix: 'Read the datasheets and declare pin types with set_pin_rules. Do not guess from pin names.', suggested_commands: ['get_board', 'set_pin_rules', 'run_erc'] })
  for (const c of ctx.doc.pcb?.components ?? []) if (!c.model && !c.footprint.model) add({ domain: 'manufacturing', severity: 'warning', rule: 'proxy_model', message: `${c.ref} has only a proxy body; physical fit is not verified.`, objects: [c.ref], fix: 'Provide a real part model or measure the physical part before approving enclosure fit.', suggested_commands: ['move_component', 'measure_between', 'render'] })
  const problems = [...map.values()].sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1) || a.id.localeCompare(b.id))
  return { ok: !problems.some((p) => p.severity === 'error'), revision: ctx.revision, counts: { errors: problems.filter((p) => p.severity === 'error').length, warnings: problems.filter((p) => p.severity === 'warning').length }, problems, coverage: { checks: checks.length, electrical: erc?.coverage }, limitations: ['Checks cover declared requirements only; a passing report is not a physical-fit or manufacturer DFM certification.', ...(erc ? [erc.limitations] : [])] }
}

const filters = z.object({ domain: z.enum(['history', 'cad', 'pcb', 'electrical', 'manufacturing']).optional(), severity: z.enum(['error', 'warning']).optional(), objects: z.array(z.string()).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(60) })
define({
  name: 'cancel_operation', group: 'project', kind: 'query',
  description: 'Interrupt the current local kernel work and queued commands by restarting the executor, then rebuild the saved design. Runs outside the normal command queue, so it can stop a stuck build/router. Does not undo already-saved operations, cancel another agent conversation or abort remote provider requests. If a network preparation later completes, it is prevented from committing. Inspect get_document/get_problems afterwards; simpler geometry may be needed.',
  args: z.object({}),
  async run(ctx) {
    if (!ctx.interrupt) throw new Error('cancel_operation requires an open Ket project session')
    const build = await ctx.interrupt()
    return { ok: !!build, interrupted: true, saved_operations_preserved: true, build_ok: build?.ok, hint: 'Read get_document and get_problems before continuing. This did not stop any server-side conversation.' }
  },
})
define({
  name: 'get_problems', group: 'query', kind: 'query',
  description: 'One structured preflight for AI repair: history recovery, CAD build/requirements, PCB DRC and unrouted nets, explicit-pin ERC, manufacturing warnings. Stable IDs, severity, affected objects, XY locations, measured/required values where available, fix guidance and suggested commands. Filter/page results; counts always describe the whole design. Never auto-fixes or relaxes requirements. Re-run after each repair and render affected objects.',
  args: filters,
  async run(ctx, a) {
    const report = await designProblems(ctx)
    const found = report.problems.filter((p) => (!a.domain || p.domain === a.domain) && (!a.severity || p.severity === a.severity) && (!a.objects?.length || p.objects.some((o) => a.objects!.includes(o))))
    return { ...report, total: found.length, problems: found.slice(a.offset, a.offset + a.limit), truncated: a.offset + a.limit < found.length, next_offset: a.offset + a.limit < found.length ? a.offset + a.limit : undefined }
  },
})

define({
  name: 'focus_problem', group: 'query', kind: 'query',
  description: 'Show a current get_problems item to the user: selects its object and switches to PCB/3D with its location highlighted. Display-only, no design change or undo step. Refuses an obsolete problem ID; re-run get_problems after repairs.',
  args: z.object({ id: z.string() }),
  async run(ctx, a) {
    const problem = (await designProblems(ctx)).problems.find((p) => p.id === a.id)
    if (!problem) throw new Error('this problem no longer exists; call get_problems for the current IDs')
    const target: FocusTarget = { view: ['pcb', 'electrical', 'manufacturing'].includes(problem.domain) ? 'pcb' : '3d', objects: problem.objects, at: problem.location?.at, side: problem.location?.side }
    if (target.view === 'pcb' && !target.at) {
      const board = await ctx.kernel.board()
      for (const object of problem.objects) {
        const pad = board?.board.pads.find((p) => `${p.ref}.${p.pin}` === object)
        const component = board?.board.components.find((c) => c.ref === object.replace(/^part_/, ''))
        const at = pad?.center ?? component?.at
        if (at) { target.at = [at.x, at.y]; target.side = component?.side; break }
      }
    }
    target.objects = [...new Set([...target.objects, ...problem.objects.filter((o) => ctx.doc.pcb?.components.some((c) => c.ref === o)).map((o) => `part_${o}`)])]
    ctx.focus?.(target)
    return { ok: true, focused: !!ctx.focus, target, problem }
  },
})

define({
  name: 'get_history', group: 'query', kind: 'query',
  description: 'Inspect the stored applied operation log and any replay recovery failure without changing it. Summary by default; detail full returns prepared arguments (can be large). Useful for diagnosing failed replay, reviewing AI edits and choosing how far to undo. No credentials/server identities. Requires an open project session.',
  args: z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30), detail: z.enum(['summary', 'full']).default('summary') }),
  run(ctx, a) {
    if (!ctx.projectOps) throw new Error('get_history needs an open Ket project session')
    const ops = ctx.projectOps.slice(a.offset, a.offset + a.limit)
    return { recovery: ctx.recovery, revision: ctx.revision, total: ctx.projectOps.length, operations: ops.map((op, i) => ({ seq: a.offset + i + 1, cmd: op.cmd, ...(a.detail === 'full' ? { args: op.args } : {}) })), truncated: a.offset + a.limit < ctx.projectOps.length }
  },
})

define({
  name: 'preview_changes', group: 'query', kind: 'query',
  description: 'Dry-run an atomic batch against the current design without committing anything. Prepares each step against preceding steps, builds the candidate and compares unified get_problems before/after: introduced and resolved IDs, remaining errors, change summary. Does not upload, save, export, auto-apply or weaken checks. If acceptable, apply the same steps with batch (or work on a proposal). Expensive geometry/routing still runs; only the design commit is suppressed.',
  args: z.object({ steps: z.array(z.object({ cmd: z.string(), args: z.record(z.string(), z.unknown()) })).min(1).max(256) }),
  async run(ctx, a) {
    requireHealthyHistory(ctx)
    if (!ctx.kernelFor) throw new Error('preview_changes needs an isolated kernel context in an open project session')
    const before = await designProblems(ctx)
    try {
      const op = await prepareOperation(ctx, { cmd: 'batch', args: a }, ctx.kernelFor)
      const next = applyOp(ctx.doc, op).doc
      const after = await designProblems({ ...ctx, doc: next, kernel: ctx.kernelFor(next) })
      const old = new Set(before.problems.map((p) => p.id)), current = new Set(after.problems.map((p) => p.id))
      return { ok: after.ok, committed: false, base_revision: ctx.revision, changes: diffDocs(ctx.doc, next), before: before.counts, after: after.counts, introduced: after.problems.filter((p) => !old.has(p.id)), resolved: before.problems.filter((p) => !current.has(p.id)).map((p) => p.id), remaining_errors: after.problems.filter((p) => p.severity === 'error'), hint: 'No changes were saved. Review the diagnostics; apply the same steps with batch only if they meet the requirements.' }
    } finally { await ctx.kernel.build() }
  },
})
