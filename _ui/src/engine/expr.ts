// A small, safe expression language for parameters and dimensions:
//   numbers (with optional "mm"), names, + - * / % ^, parentheses,
//   comparisons (< <= > >= == !=), && || ! (also and, or, not), and functions
//   min max abs sqrt sin cos tan asin acos atan atan2 round floor ceil pi.
// No eval; unknown names fail with a message listing what is known.

import type { Expr, Parameter } from './doc'

type Tok =
  | { k: 'num'; v: number }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string }

const OPS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '^', '(', ')', ',', '<', '>', '!']

/** Models write boolean checks either way: "a <= b and c > 0" is "a <= b && c > 0". */
const WORD_OPS: Record<string, string> = { and: '&&', or: '||', not: '!' }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i))
      if (!m) throw new Error(`bad number at "${src.slice(i, i + 8)}"`)
      out.push({ k: 'num', v: parseFloat(m[0]) })
      i += m[0].length
      // Unit suffix: only mm is the base unit; deg is accepted for angles.
      const u = /^(mm|deg)\b/.exec(src.slice(i))
      if (u) i += u[0].length
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))!
      const word = WORD_OPS[m[0]]
      out.push(word ? { k: 'op', v: word } : { k: 'id', v: m[0] })
      i += m[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new Error(`unexpected "${c}"`)
    out.push({ k: 'op', v: op })
    i += op.length
  }

  return out
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  sqrt: Math.sqrt,
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
  asin: (x) => (Math.asin(x) * 180) / Math.PI,
  acos: (x) => (Math.acos(x) * 180) / Math.PI,
  atan: (x) => (Math.atan(x) * 180) / Math.PI,
  atan2: (y, x) => (Math.atan2(y, x) * 180) / Math.PI,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
}

const CONSTS: Record<string, number> = { pi: Math.PI, true: 1, false: 0 }

/** Lookup resolves a name to a value, or undefined when unknown. */
export type Lookup = (name: string) => number | undefined

class Parser {
  private i = 0
  constructor(
    private toks: Tok[],
    private lookup: Lookup,
    private src: string,
  ) {}

  parse(): number {
    const v = this.or()
    if (this.i < this.toks.length) throw new Error(`unexpected "${this.show(this.toks[this.i])}"`)
    return v
  }

  private show(t: Tok) {
    return String(t.v)
  }

  private peek(v: string) {
    const t = this.toks[this.i]
    return t && t.k === 'op' && t.v === v
  }

  private eat(v: string) {
    if (this.peek(v)) {
      this.i++
      return true
    }
    return false
  }

  private or(): number {
    let l = this.and()
    while (this.eat('||')) {
      const r = this.and()
      l = l || r ? 1 : 0
    }
    return l
  }

  private and(): number {
    let l = this.cmp()
    while (this.eat('&&')) {
      const r = this.cmp()
      l = l && r ? 1 : 0
    }
    return l
  }

  private cmp(): number {
    const l = this.add()
    for (const op of ['<=', '>=', '==', '!=', '<', '>']) {
      if (this.eat(op)) {
        const r = this.add()
        const eps = 1e-9
        switch (op) {
          case '<=':
            return l <= r + eps ? 1 : 0
          case '>=':
            return l >= r - eps ? 1 : 0
          case '==':
            return Math.abs(l - r) <= eps ? 1 : 0
          case '!=':
            return Math.abs(l - r) > eps ? 1 : 0
          case '<':
            return l < r ? 1 : 0
          case '>':
            return l > r ? 1 : 0
        }
      }
    }
    return l
  }

  private add(): number {
    let l = this.mul()
    for (;;) {
      if (this.eat('+')) l += this.mul()
      else if (this.eat('-')) l -= this.mul()
      else return l
    }
  }

  private mul(): number {
    let l = this.unary()
    for (;;) {
      if (this.eat('*')) l *= this.unary()
      else if (this.eat('/')) {
        const r = this.unary()
        if (r === 0) throw new Error('division by zero')
        l /= r
      } else if (this.eat('%')) l %= this.unary()
      else return l
    }
  }

  private unary(): number {
    if (this.eat('-')) return -this.unary()
    if (this.eat('+')) return this.unary()
    if (this.eat('!')) return this.unary() ? 0 : 1
    return this.pow()
  }

  private pow(): number {
    const b = this.atom()
    if (this.eat('^')) return Math.pow(b, this.unary())
    return b
  }

  private atom(): number {
    const t = this.toks[this.i++]
    if (!t) throw new Error(`"${this.src}" ends early`)
    if (t.k === 'num') return t.v
    if (t.k === 'op' && t.v === '(') {
      const v = this.or()
      if (!this.eat(')')) throw new Error('missing ")"')
      return v
    }
    if (t.k === 'id') {
      if (this.peek('(')) {
        this.i++
        const fn = FUNCS[t.v]
        if (!fn) throw new Error(`unknown function ${t.v}(); known: ${Object.keys(FUNCS).join(', ')}`)
        const args: number[] = []
        if (!this.peek(')')) {
          do args.push(this.or())
          while (this.eat(','))
        }
        if (!this.eat(')')) throw new Error(`missing ")" after ${t.v}(`)
        return fn(...args)
      }
      if (t.v in CONSTS) return CONSTS[t.v]
      const v = this.lookup(t.v)
      if (v === undefined) throw new UnknownName(t.v)
      return v
    }
    throw new Error(`unexpected "${t.v}"`)
  }
}

export class UnknownName extends Error {
  constructor(public readonly ident: string) {
    super(`unknown name "${ident}"`)
  }
}

export function evaluate(src: string, lookup: Lookup): number {
  const v = new Parser(tokenize(src), lookup, src).parse()
  if (!Number.isFinite(v)) throw new Error(`"${src}" is not a finite number`)
  return v
}

/** Names an expression refers to (functions and constants excluded). */
export function namesIn(src: string): string[] {
  const toks = tokenize(src)
  const out: string[] = []
  toks.forEach((t, i) => {
    if (t.k !== 'id' || t.v in CONSTS) return
    const next = toks[i + 1]
    if (next && next.k === 'op' && next.v === '(') return
    out.push(t.v)
  })
  return out
}

/**
 * Resolves all parameters in dependency order. Errors name the parameter
 * and the problem (unknown name, cycle) so a model can fix it directly.
 */
export function resolveParameters(params: Parameter[], extra: Lookup = () => undefined): Map<string, number> {
  const byName = new Map(params.map((p) => [p.name, p]))
  const values = new Map<string, number>()
  const visiting = new Set<string>()

  const resolve = (name: string, chain: string[]): number => {
    const known = values.get(name)
    if (known !== undefined) return known
    const p = byName.get(name)
    if (!p) {
      const v = extra(name)
      if (v !== undefined) return v
      throw new UnknownName(name)
    }
    if (visiting.has(name)) throw new Error(`parameter cycle: ${[...chain, name].join(' → ')}`)
    visiting.add(name)
    let v: number
    try {
      v = typeof p.expr === 'number' ? p.expr : evaluate(p.expr, (n) => resolve(n, [...chain, name]))
    } catch (e) {
      if (e instanceof UnknownName) {
        throw new Error(
          `parameter ${name} = ${JSON.stringify(p.expr)}: unknown name "${e.ident}"; parameters are: ${[...byName.keys()].join(', ') || '(none)'}`,
        )
      }
      if (e instanceof Error && e.message.startsWith('parameter')) throw e
      throw new Error(`parameter ${name} = ${JSON.stringify(p.expr)}: ${(e as Error).message}`)
    }
    visiting.delete(name)
    values.set(name, v)
    return v
  }

  for (const p of params) resolve(p.name, [])

  return values
}

/** Evaluates an Expr (number or string) against resolved parameters. */
export function num(e: Expr | undefined, params: Map<string, number>, what: string, fallback?: number): number {
  if (e === undefined || e === null) {
    if (fallback !== undefined) return fallback
    throw new Error(`${what} is required`)
  }
  if (typeof e === 'number') {
    if (!Number.isFinite(e)) throw new Error(`${what} is not a finite number`)
    return e
  }
  try {
    return evaluate(String(e), (n) => params.get(n))
  } catch (err) {
    if (err instanceof UnknownName) {
      const known = [...params.keys()]
      throw new Error(
        `${what} = "${e}": unknown name "${err.ident}"; ${known.length ? 'parameters are: ' + known.join(', ') : 'define it first with set_parameters'}`,
      )
    }
    throw new Error(`${what} = "${e}": ${(err as Error).message}`)
  }
}
