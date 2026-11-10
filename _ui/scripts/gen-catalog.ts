// Generates internal/catalog/catalog.json from the command registry, so the
// Go server (MCP and the agent) offers exactly the commands the browser can
// run, with the same JSON schemas. Run by `pnpm gen` (part of `pnpm build`).

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { GUIDE, commands } from '../src/engine'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../../internal/catalog/catalog.json')

function jsonSchema(s: z.ZodType, internal: string[] = []): Record<string, unknown> {
  const js = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  delete js.$schema
  // Fields the browser fills (fetched footprints, router results) are not
  // for callers.
  const props = js.properties as Record<string, unknown> | undefined
  for (const k of internal) if (props) delete props[k]
  // A discriminated union at the top level becomes anyOf; tools need an
  // object schema, so wrap it.
  if (js.type !== 'object') {
    return { type: 'object', ...js }
  }
  return js
}

const catalog = {
  version: '1',
  guide: GUIDE,
  commands: commands().map((c) => ({
    name: c.name,
    group: c.group,
    kind: c.kind,
    description: c.description,
    schema: jsonSchema(c.args, c.internal),
    examples: c.examples,
  })),
}

writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n')
console.log(`wrote ${catalog.commands.length} commands to ${out}`)
