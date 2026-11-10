// Shared zod pieces for command arguments. Schemas are converted to JSON
// Schema for MCP and the agent, so every field carries a description: it
// is the documentation the model reads.

import { z } from 'zod'

export const expr = z
  .union([z.number(), z.string()])
  .describe('Number in mm (or degrees), or an expression over parameters such as "wall*2 + 0.2"')

export const vec3 = z.tuple([expr, expr, expr]).describe('[x, y, z]')
export const vec2 = z.tuple([expr, expr]).describe('[x, y]')

export const ident = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'use letters, digits and _ (start with a letter), e.g. "case_body"')

export const featureName = ident.describe('Unique feature name, e.g. "case_body", "usb_cutout"')
export const featureRef = z.string().describe('Name of an existing feature')

export const selector = z
  .object({
    where: z
      .string()
      .optional()
      .describe(
        'CadQuery-style terms joined with " and ": ">Z" farthest along +Z (top), "<Z" bottom, "+Z"/"-Z" faces facing +Z/-Z, "|Z" parallel to Z (edges) or normal ∥ Z (faces), "#Z" perpendicular to Z, "all", "not >Z". Any axis X, Y, Z.',
      ),
    type: z.string().optional().describe('Faces: plane, cylinder, cone, sphere, torus. Edges: line, circle, ellipse, bspline.'),
    inBox: z.tuple([vec3, vec3]).optional().describe('Only elements whose center is in the box [[x0,y0,z0],[x1,y1,z1]]'),
    near: vec3.optional().describe('Only elements touching this point'),
  })
  .describe('Picks faces or edges by meaning; check the result with list_faces / list_edges')

export const placement = {
  translate: vec3.optional().describe('Move by [x, y, z] after rotating'),
  rotate: vec3.optional().describe('Rotate by [rx, ry, rz] degrees about the origin, X then Y then Z'),
}

export const common = {
  name: featureName,
  note: z.string().optional().describe('Why this feature exists (helps later edits)'),
  color: z.string().optional().describe('CSS color for the viewport, e.g. "#4a90d9". Display only: use it to tell parts apart (case, lid, buttons, light pipe)'),
  opacity: z.number().min(0.05).max(1).optional().describe('Viewport opacity 0.05..1 (default 1); e.g. 0.3 for a see-through case. Display only'),
  hidden: z.boolean().optional().describe('Hide the body (it can still be used as a tool)'),
}

export const plane = z.enum(['XY', 'XZ', 'YZ']).describe('Sketch plane: XY extrudes along +Z, XZ along +Y, YZ along +X')

export const profile = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('rect'),
      w: expr.describe('Width along the plane\'s first axis'),
      h: expr.describe('Height along the plane\'s second axis'),
      r: expr.optional().describe('Corner radius'),
      center: vec2.optional().describe('Center in plane coordinates (default [0,0])'),
    }),
    z.object({ kind: z.literal('circle'), r: expr, center: vec2.optional() }),
    z.object({
      kind: z.literal('slot'),
      length: expr.describe('Overall length including the round ends'),
      width: expr,
      angle: expr.optional().describe('Rotation in degrees'),
      center: vec2.optional(),
    }),
    z.object({ kind: z.literal('polygon'), points: z.array(vec2).min(3).describe('Closed outline, in order') }),
  ])
  .describe('2D outline in the sketch plane')

export const checkDef = z
  .discriminatedUnion('kind', [
    z.object({
      name: ident,
      kind: z.literal('expr'),
      expr: z.string().describe('Boolean expression over parameters, e.g. "wall >= 1.6"'),
      note: z.string().optional(),
    }),
    z.object({
      name: ident,
      kind: z.literal('min_distance'),
      a: featureRef,
      b: featureRef,
      min: expr.describe('Minimum clearance in mm'),
      note: z.string().optional(),
    }),
    z.object({ name: ident, kind: z.literal('no_overlap'), a: featureRef, b: featureRef, note: z.string().optional() }),
    z.object({
      name: ident,
      kind: z.literal('inside'),
      inner: featureRef,
      outer: featureRef.describe('Usually a body representing the free space, e.g. the cavity of a case'),
      margin: expr.optional().describe('Minimum gap to every side of the outer bounding box'),
      note: z.string().optional(),
    }),
    z.object({
      name: ident,
      kind: z.literal('volume'),
      target: featureRef,
      min: expr.optional(),
      max: expr.optional(),
      note: z.string().optional(),
    }),
  ])
  .describe('A requirement the design must keep meeting')
