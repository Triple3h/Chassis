/**
 * 稿纸算式求值器：tokenizer + 递归下降，零依赖、纯函数（可单测）。
 *
 * 语法：
 * - 四则运算 `+ - * / %`（`× ÷ −` 也认）、幂 `^` / `**`（右结合）、括号
 * - 后缀百分号：`50%` = 0.5（`%` 后面还跟着操作数时按取模算：`10 % 3` = 1）
 * - 函数：sqrt / abs / round / floor / ceil / min / max / pow / sin / cos / tan / log / ln / exp / sign
 * - 常量：pi / e / tau；变量：`a = 3` 定义，后续行可直接用；`ans` = 上一行结果
 * - 隐式乘法：`2pi`、`2(3+4)`
 */

export interface Scope {
  vars: Record<string, number>
  /** 上一行的结果（算式里写 ans 引用） */
  last?: number
}

export type EvalOutcome =
  | { ok: true; value: number; vars: Record<string, number>; name?: string }
  | { ok: false; error: string }

export const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  π: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
}

interface FnSpec {
  min: number
  max: number
  fn: (...args: number[]) => number
}

export const FUNCTIONS: Record<string, FnSpec> = {
  sqrt: { min: 1, max: 1, fn: (x) => Math.sqrt(x) },
  abs: { min: 1, max: 1, fn: (x) => Math.abs(x) },
  round: { min: 1, max: 2, fn: (x, digits) => Number(x.toFixed(clampDigits(digits))) },
  floor: { min: 1, max: 1, fn: (x) => Math.floor(x) },
  ceil: { min: 1, max: 1, fn: (x) => Math.ceil(x) },
  trunc: { min: 1, max: 1, fn: (x) => Math.trunc(x) },
  sign: { min: 1, max: 1, fn: (x) => Math.sign(x) },
  min: { min: 2, max: 16, fn: (...args) => Math.min(...args) },
  max: { min: 2, max: 16, fn: (...args) => Math.max(...args) },
  pow: { min: 2, max: 2, fn: (x, y) => x ** y },
  mod: { min: 2, max: 2, fn: (x, y) => x % y },
  sin: { min: 1, max: 1, fn: (x) => Math.sin(x) },
  cos: { min: 1, max: 1, fn: (x) => Math.cos(x) },
  tan: { min: 1, max: 1, fn: (x) => Math.tan(x) },
  asin: { min: 1, max: 1, fn: (x) => Math.asin(x) },
  acos: { min: 1, max: 1, fn: (x) => Math.acos(x) },
  atan: { min: 1, max: 1, fn: (x) => Math.atan(x) },
  log: { min: 1, max: 2, fn: (x, base) => (Number.isFinite(base) ? Math.log(x) / Math.log(base) : Math.log10(x)) },
  ln: { min: 1, max: 1, fn: (x) => Math.log(x) },
  exp: { min: 1, max: 1, fn: (x) => Math.exp(x) },
  hypot: { min: 2, max: 16, fn: (...args) => Math.hypot(...args) },
}

function clampDigits(digits: number | undefined): number {
  if (digits === undefined || !Number.isFinite(digits)) return 0
  return Math.max(0, Math.min(15, Math.trunc(digits)))
}

export const FUNCTION_NAMES = Object.keys(FUNCTIONS)

type TokenType = 'num' | 'name' | 'op' | 'lparen' | 'rparen' | 'comma'

interface Token {
  type: TokenType
  value: string
}

const NUMBER_RE = /^(?:(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/
const NAME_RE = /^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*/

class ParseError extends Error {}

export function tokenize(input: string): Token[] | { error: string } {
  const text = input.replace(/[，、]/g, ',')
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    const ch = text[index] ?? ''
    if (ch === ' ' || ch === '\t' || ch === '\u00a0') {
      index += 1
      continue
    }
    if (ch === '(' || ch === '（') {
      tokens.push({ type: 'lparen', value: '(' })
      index += 1
      continue
    }
    if (ch === ')' || ch === '）') {
      tokens.push({ type: 'rparen', value: ')' })
      index += 1
      continue
    }
    if (ch === ',' || ch === '，') {
      tokens.push({ type: 'comma', value: ',' })
      index += 1
      continue
    }
    if (ch === '*') {
      // `**` 与 `^` 等价
      if (text[index + 1] === '*') {
        tokens.push({ type: 'op', value: '^' })
        index += 2
      } else {
        tokens.push({ type: 'op', value: '*' })
        index += 1
      }
      continue
    }
    if ('+-/%^'.includes(ch)) {
      tokens.push({ type: 'op', value: ch })
      index += 1
      continue
    }
    if (ch === '×' || ch === '＊') {
      tokens.push({ type: 'op', value: '*' })
      index += 1
      continue
    }
    if (ch === '÷') {
      tokens.push({ type: 'op', value: '/' })
      index += 1
      continue
    }
    if (ch === '＋') {
      tokens.push({ type: 'op', value: '+' })
      index += 1
      continue
    }
    if (ch === '−' || ch === '–' || ch === '－') {
      tokens.push({ type: 'op', value: '-' })
      index += 1
      continue
    }
    const rest = text.slice(index)
    const numberMatch = NUMBER_RE.exec(rest)
    if (numberMatch) {
      tokens.push({ type: 'num', value: (numberMatch[0] ?? '').replace(/,/g, '') })
      index += numberMatch[0]?.length ?? 1
      continue
    }
    const nameMatch = NAME_RE.exec(rest)
    if (nameMatch) {
      const name = nameMatch[0] ?? ''
      tokens.push({ type: name.toLowerCase() === 'mod' ? 'op' : 'name', value: name })
      index += name.length
      continue
    }
    return { error: `不认识的符号：${ch}` }
  }
  return tokens
}

class Parser {
  private index = 0
  private vars: Record<string, number>

  constructor(
    private tokens: Token[],
    vars: Record<string, number>,
    private last?: number,
  ) {
    this.vars = { ...vars }
  }

  exportVars(): Record<string, number> {
    return this.vars
  }

  parseExpression(): number {
    let value = this.parseTerm()
    for (;;) {
      const token = this.peek()
      if (!token || token.type !== 'op' || (token.value !== '+' && token.value !== '-')) break
      this.index += 1
      const right = this.parseTerm()
      value = token.value === '+' ? value + right : value - right
    }
    return value
  }

  expectEnd(): void {
    const token = this.peek()
    if (token) throw new ParseError(`多出来的输入：${token.value}`)
  }

  private parseTerm(): number {
    let value = this.parseUnary()
    for (;;) {
      const token = this.peek()
      if (!token) break
      if (token.type === 'op' && ['*', '/'].includes(token.value)) {
        this.index += 1
        const right = this.parseUnary()
        if (token.value === '/' && right === 0) throw new ParseError('除数不能为 0')
        value = token.value === '*' ? value * right : value / right
        continue
      }
      // 取模：只有 `%` 后面还跟着操作数时才当二元运算符，否则那是后缀百分号
      if (token.type === 'op' && (token.value === '%' || token.value === 'mod') && this.startsWithOperand(1)) {
        this.index += 1
        const right = this.parseUnary()
        if (right === 0) throw new ParseError('取模的除数不能为 0')
        value %= right
        continue
      }
      // 隐式乘法：2pi、2(3+4)
      if (this.startsWithOperand(0)) {
        value *= this.parseUnary()
        continue
      }
      break
    }
    return value
  }

  private parseUnary(): number {
    const token = this.peek()
    if (token && token.type === 'op' && (token.value === '-' || token.value === '+')) {
      this.index += 1
      const value = this.parseUnary()
      return token.value === '-' ? -value : value
    }
    return this.parsePercent(this.parsePower())
  }

  private parsePower(): number {
    const base = this.parseAtom()
    const token = this.peek()
    if (token && token.type === 'op' && token.value === '^') {
      this.index += 1
      // 右结合：2^3^2 = 2^9
      return base ** this.parseUnary()
    }
    return base
  }

  /** 后缀百分号：50% → 0.5（连续写多个也能继续除） */
  private parsePercent(value: number): number {
    let out = value
    for (;;) {
      const token = this.peek()
      if (!token || token.type !== 'op' || token.value !== '%' || this.startsWithOperand(1)) break
      this.index += 1
      out /= 100
    }
    return out
  }

  private parseAtom(): number {
    const token = this.next()
    if (!token) throw new ParseError('表达式不完整')
    if (token.type === 'num') {
      const value = Number(token.value)
      if (!Number.isFinite(value)) throw new ParseError(`不是合法的数字：${token.value}`)
      return value
    }
    if (token.type === 'lparen') {
      const value = this.parseExpression()
      const close = this.next()
      if (!close || close.type !== 'rparen') throw new ParseError('括号不匹配')
      return value
    }
    if (token.type === 'name') {
      const lower = token.value.toLowerCase()
      const spec = FUNCTIONS[lower]
      if (spec) return this.callFunction(lower, spec)
      if (lower === 'ans') {
        if (this.last === undefined) throw new ParseError('前面还没有结果，用不了 ans')
        return this.last
      }
      if (lower in CONSTANTS) return CONSTANTS[lower] ?? 0
      if (lower in this.vars) return this.vars[lower] ?? 0
      throw new ParseError(`未知的变量或函数：${token.value}`)
    }
    throw new ParseError(`不认识的符号：${token.value}`)
  }

  private callFunction(name: string, spec: FnSpec): number {
    const open = this.next()
    if (!open || open.type !== 'lparen') throw new ParseError(`${name}() 后面要跟括号`)
    const args: number[] = []
    if (this.peek()?.type === 'rparen') {
      this.index += 1
    } else {
      for (;;) {
        args.push(this.parseExpression())
        const sep = this.next()
        if (!sep) throw new ParseError('括号不匹配')
        if (sep.type === 'comma') continue
        if (sep.type === 'rparen') break
        throw new ParseError(`${name}() 的参数写法有问题`)
      }
    }
    if (args.length < spec.min || args.length > spec.max) {
      const need = spec.min === spec.max ? String(spec.min) : `${spec.min}~${spec.max}`
      throw new ParseError(`${name}() 需要 ${need} 个参数`)
    }
    const result = spec.fn(...args)
    if (Number.isNaN(result)) throw new ParseError(`${name}() 的参数超出了定义域`)
    return result
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset]
  }

  private next(): Token | undefined {
    const token = this.tokens[this.index]
    this.index += 1
    return token
  }

  private startsWithOperand(offset: number): boolean {
    const token = this.peek(offset)
    if (!token) return false
    return token.type === 'num' || token.type === 'name' || token.type === 'lparen'
  }
}

/** 顶层求值：支持 `名字 = 算式` 的赋值 */
export function evaluate(input: string, scope: Scope = { vars: {} }): EvalOutcome {
  const text = input.trim()
  if (!text) return { ok: false, error: '缺少表达式' }
  let expression = text
  let name: string | undefined
  const assign = /^([A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*)\s*=(?!=)\s*(.+)$/.exec(text)
  if (assign) {
    name = assign[1] ?? ''
    expression = assign[2] ?? ''
  }
  const tokens = tokenize(expression)
  if (!Array.isArray(tokens)) return { ok: false, error: tokens.error }
  if (!tokens.length) return { ok: false, error: '缺少表达式' }
  const parser = new Parser(tokens, scope.vars, scope.last)
  try {
    const value = parser.parseExpression()
    parser.expectEnd()
    const vars = parser.exportVars()
    if (name) vars[name] = value
    return { ok: true, value, vars, ...(name ? { name } : {}) }
  } catch (err) {
    return { ok: false, error: err instanceof ParseError ? err.message : '这个算式看不懂' }
  }
}

/** 把 `x = 3` 这类赋值里的名字取出来（用于给行加高亮，不影响求值） */
export function assignedName(expr: string): string | undefined {
  return /^([A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*)\s*=(?!=)/.exec(expr.trim())?.[1]
}

/** 稿纸底部的语法提示 */
export const SYNTAX_HINT = '支持 + - * / % ^、括号、sqrt/min/max/round 等函数、pi/e 常量、a = 3 变量与 ans'
