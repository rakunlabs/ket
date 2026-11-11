// Motion commands: set what moves (the driven parameter, joints for bodies
// that are not gears, loose bodies under physics), read the plan back, and
// simulate physics headless so a model can check where things land.

import { z } from 'zod'

import { type Doc, type Motion, normalizeDoc } from './doc'
import { define } from './registry'
import { expr, featureRef, ident, vec3 } from './schema'

function clone(doc: Doc): Doc {
  return normalizeDoc(JSON.parse(JSON.stringify(doc)) as Doc)
}

const v3n = z.tuple([z.number(), z.number(), z.number()])

define({
  name: 'set_motion',
  group: 'motion',
  kind: 'mutate',
  description:
    "Say how the model moves when the user presses Play (display only; the document stays as it is). drive: the parameter Play advances and its speed per second (a gear train drives itself from its first gear's rotation parameter, so drive is only needed to change speed or mode). joints: bodies that are not gears turn or slide with the parameter (rotate about axis through origin, rate degrees per unit; slide along axis, rate mm per unit; or position: an expression of the parameter for nonlinear motion; follow copies another body, e.g. a crank handle on the worm; cam: a follower riding a cam feature). Gears, planets (they also orbit), geneva wheels, cams and belt pulleys move by themselves. physics: loose bodies (balls, blocks, a load on a rack) that fall under gravity and collide with everything; driven bodies push them. Give only the parts you change; null clears one. Check with get_motion and simulate.",
  args: z.object({
    drive: z
      .object({
        param: ident.describe('Parameter to advance'),
        speed: z.number().describe('Units per second (degrees/s for a crank)'),
        mode: z.enum(['forever', 'loop', 'bounce']).optional().describe('forever counts up; loop and bounce stay within range'),
        range: z.tuple([z.number(), z.number()]).optional(),
      })
      .nullable()
      .optional(),
    joints: z
      .array(
        z.object({
          body: featureRef,
          kind: z.enum(['rotate', 'slide', 'follow', 'cam']),
          axis: vec3.optional(),
          origin: vec3.optional().describe('A point on the rotation axis'),
          rate: expr.optional().describe('Degrees (rotate) or mm (slide) per unit of the parameter; default 1'),
          position: z.string().optional().describe('Instead of rate: the angle (rotate) or travel (slide) from where it is built, as an expression of the drive parameter, e.g. "10*sin(crank)" for a rocker; evaluated minus its value at the start'),
          follow: featureRef.optional().describe('follow: the body whose motion to copy'),
          cam: featureRef.optional().describe('cam: the cam feature this body follows (it slides along the follower direction by the lift)'),
        }),
      )
      .nullable()
      .optional(),
    physics: z
      .object({
        bodies: z.array(
          z.object({
            name: featureRef,
            density: z.number().positive().optional().describe('g/cm³ (PLA 1.25, steel 7.8, wood 0.6)'),
            friction: z.number().min(0).max(2).optional(),
            restitution: z.number().min(0).max(1).optional().describe('Bounciness 0..1'),
            velocity: v3n.optional().describe('Start velocity mm/s'),
            spin: v3n.optional().describe('Start spin degrees/s about x, y, z'),
          }),
        ),
        gravity: z.number().optional().describe('mm/s² (default 9810, down −Z)'),
        floor: z.boolean().optional().describe('A floor under the lowest point (default true)'),
      })
      .nullable()
      .optional(),
  }),
  examples: [
    { drive: { param: 'crank', speed: 360 } },
    { joints: [{ body: 'handle', kind: 'follow', follow: 'worm' }] },
    { physics: { bodies: [{ name: 'ball', density: 7.8, restitution: 0.4 }] } },
  ],
  apply(doc, a) {
    const next = clone(doc)
    const m: Motion = { ...(next.motion ?? {}) }
    for (const key of ['drive', 'joints', 'physics'] as const) {
      const v = a[key]
      if (v === null) delete m[key]
      else if (v !== undefined) (m as Record<string, unknown>)[key] = v
    }
    const names = new Set(next.features.map((f) => f.name))
    for (const j of m.joints ?? []) {
      if (!names.has(j.body)) throw new Error(`joint: no feature "${j.body}"`)
      if (j.kind === 'follow' && !j.follow) throw new Error(`joint on "${j.body}": follow needs follow: "<body>"`)
      if (j.kind === 'cam') {
        const c = next.features.find((f) => f.name === j.cam)
        if (!c || c.type !== 'cam') throw new Error(`joint on "${j.body}": kind cam needs cam: "<a cam feature>"`)
      } else if (j.kind !== 'follow' && !j.axis) throw new Error(`joint on "${j.body}": ${j.kind} needs an axis`)
    }
    for (const b of m.physics?.bodies ?? []) if (!names.has(b.name)) throw new Error(`physics: no feature "${b.name}"`)
    if (m.drive && !next.parameters.some((p) => p.name === m.drive!.param)) throw new Error(`drive: no parameter "${m.drive.param}"; add it with set_parameters`)
    if (Object.keys(m).length) next.motion = m
    else delete next.motion
    const parts = [m.drive && `drive ${m.drive.param} ${m.drive.speed}/s`, m.joints?.length && `${m.joints.length} joint(s)`, m.physics?.bodies.length && `${m.physics.bodies.length} loose body(ies)`].filter(Boolean)
    return { doc: next, summary: `motion: ${parts.join(', ') || 'none'}` }
  },
})

define({
  name: 'get_motion',
  group: 'query',
  kind: 'query',
  description: 'Read what Play will move: the driven parameter and speed, every moving body with its axis, origin and rate (gears included), the loose physics bodies, and problems.',
  args: z.object({}),
  async run(ctx) {
    return ctx.kernel.motion()
  },
})

define({
  name: 'simulate',
  group: 'query',
  kind: 'query',
  description:
    'Run the motion for some seconds without showing it: the driven parameter advances at its speed, driven bodies move, loose bodies fall and collide. Returns where each loose body ends up (center, how far it moved, whether it came to rest, which bodies it touches) at the sample times, and escaped when a loose body ended up inside a still solid (it passed through a wall). Use it to check that a ball rolls off a ramp, a load rides a rack, or a part settles where it should; touching tells what pushed it.',
  args: z.object({
    seconds: z.number().positive().max(30).optional().describe('Default 3'),
    samples: z.number().int().min(1).max(20).optional().describe('How many snapshots (default 4)'),
  }),
  async run(ctx, a) {
    return ctx.kernel.simulate(a.seconds ?? 3, a.samples ?? 4)
  },
})
