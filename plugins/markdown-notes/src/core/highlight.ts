/**
 * 轻量代码高亮（零依赖，随插件打包）。
 *
 * 一个逐字符状态机 + 每门语言的声明式配置（注释 / 字符串 / 关键字 / 字面量 / 类型），
 * markup（HTML/XML/Vue）、diff、CSS 走各自的识别分支，其余语言共用通用扫描。
 *
 * 两条兜底：未知语言、超过 HIGHLIGHT_LIMIT 的代码块只做转义 ——
 * 预览不能因为贴进来一段大文件卡住，也不能因为语法没覆盖就吐出半截着色。
 */

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESC_MAP[ch] as string)
}

/** 超过这个长度的代码块放弃着色（贴进来的大文件不该把预览拖垮） */
export const HIGHLIGHT_LIMIT = 30_000

type Emit = (cls: string, text: string) => void

/* ------------------------------------------------------------------ 语言配置 */

function words(list: string): Set<string> {
  return new Set(list.split(' '))
}

function merge(base: Set<string>, extra: Set<string>): Set<string> {
  return new Set([...base, ...extra])
}

interface LangSpec {
  /** 行注释标记（`#` / `//` / `--` …） */
  line?: string[]
  /** 块注释 [开始, 结束] */
  block?: Array<[string, string]>
  /** 普通引号：不跨行，反斜杠转义 */
  quotes?: string[]
  /** 可跨行的引号（JS 模板串、SQL 字符串…） */
  multiline?: string[]
  /** `"""` / `'''` 三引号（Python） */
  triple?: boolean
  keywords?: Set<string>
  literals?: Set<string>
  types?: Set<string>
  /** 标识符后跟 `(` 视作函数名 */
  fn?: boolean
  /** 大写开头视作类型（JS/Java 的类名） */
  capType?: boolean
  /** 字符串或标识符后跟 `:` 视作键名（JSON / YAML / TOML） */
  keyed?: boolean
  /** CSS：`{` 之外的选择器、`{` 之内的属性名与取值 */
  css?: boolean
  ignoreCase?: boolean
  /** 走专用扫描分支 */
  mode?: 'markup' | 'diff'
}

const JS_KEYWORDS = words(
  'as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public return set static super switch this throw try typeof var void while with yield',
)
const JS_LITERALS = words('true false null undefined NaN Infinity globalThis arguments')

const TS_EXTRA = words('type declare namespace module readonly keyof infer is asserts satisfies override accessor abstract out')
const TS_TYPES = words('string number boolean object symbol bigint unknown never any void Array Record Partial Readonly Promise Map Set WeakMap')

const RS_KEYWORDS = words(
  'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while',
)
const RS_LITERALS = words('true false None Some Ok Err self Self')
const RS_TYPES = words(
  'u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f32 f64 bool char str String Vec Option Result Box Rc Arc RefCell Cell Cow',
)

const GO_KEYWORDS = words(
  'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
)
const GO_LITERALS = words('true false nil iota')
const GO_TYPES = words('bool string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr byte rune float32 float64 complex64 complex128 error any')

const PY_KEYWORDS = words(
  'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case',
)
const PY_LITERALS = words('True False None self cls NotImplemented Ellipsis')

const JAVA_KEYWORDS = words(
  'abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try var record sealed permits yield',
)
const JAVA_LITERALS = words('true false null')
const JAVA_TYPES = words('boolean byte char double float int long short void String Object Integer Long Double Float Boolean List Map Set ArrayList HashMap Optional')

const C_KEYWORDS = words(
  'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while',
)
const C_TYPES = words('size_t ptrdiff_t int8_t uint8_t int16_t uint16_t int32_t uint32_t int64_t uint64_t bool FILE')
const CPP_EXTRA = words(
  'class namespace template typename virtual public private protected new delete this nullptr operator using constexpr friend explicit override final noexcept try catch throw static_cast dynamic_cast reinterpret_cast const_cast',
)

const SH_KEYWORDS = words(
  'if then else elif fi for while until do done case esac function in select time return local export readonly declare typeset unset shift source alias eval exec trap set break continue exit echo cd ls cat grep sed awk curl wget git npm pnpm node python pip make sudo rm cp mv mkdir touch chmod chown export printf read test',
)

const SQL_KEYWORDS = words(
  'select from where group by order having limit offset insert into values update set delete create table alter drop index view join left right inner outer full on as and or not null is in between like distinct union all case when then else end primary key foreign references default unique check cascade exists asc desc with returning conflict using explain analyze begin commit rollback',
)

const YAML_LITERALS = words('true false null yes no on off True False Null')

const LANGS: Record<string, LangSpec> = {
  javascript: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    multiline: ['`'],
    keywords: JS_KEYWORDS,
    literals: JS_LITERALS,
    fn: true,
    capType: true,
    keyed: true,
  },
  typescript: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    multiline: ['`'],
    keywords: merge(JS_KEYWORDS, TS_EXTRA),
    literals: JS_LITERALS,
    types: TS_TYPES,
    fn: true,
    capType: true,
    keyed: true,
  },
  json: { quotes: ['"'], literals: words('true false null'), keyed: true },
  markup: { mode: 'markup' },
  css: { block: [['/*', '*/']], quotes: ['"', "'"], keyed: true, css: true, ignoreCase: true },
  shell: { line: ['#'], quotes: ['"', "'"], multiline: ['`'], keywords: SH_KEYWORDS, fn: true },
  python: {
    line: ['#'],
    quotes: ['"', "'"],
    triple: true,
    keywords: PY_KEYWORDS,
    literals: PY_LITERALS,
    fn: true,
    keyed: true,
  },
  rust: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"'],
    keywords: RS_KEYWORDS,
    literals: RS_LITERALS,
    types: RS_TYPES,
    fn: true,
  },
  go: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    multiline: ['`'],
    keywords: GO_KEYWORDS,
    literals: GO_LITERALS,
    types: GO_TYPES,
    fn: true,
  },
  java: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    keywords: JAVA_KEYWORDS,
    literals: JAVA_LITERALS,
    types: JAVA_TYPES,
    fn: true,
    keyed: true,
  },
  c: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    keywords: C_KEYWORDS,
    literals: words('NULL true false'),
    types: C_TYPES,
    fn: true,
  },
  cpp: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    keywords: merge(C_KEYWORDS, CPP_EXTRA),
    literals: words('NULL true false nullptr'),
    types: C_TYPES,
    fn: true,
  },
  csharp: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    keywords: words(
      'abstract as base break case catch checked class const continue decimal default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual void volatile while var async await record',
    ),
    literals: words('true false null'),
    fn: true,
    keyed: true,
  },
  swift: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"'],
    keywords: words(
      'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough guard if in repeat return switch where while as any catch is super throw throws try self Self',
    ),
    literals: words('true false nil'),
    fn: true,
  },
  kotlin: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"'],
    keywords: words(
      'as break class continue do else for fun if in interface is object package return super this throw try typealias val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg',
    ),
    literals: words('true false null'),
    fn: true,
  },
  php: {
    line: ['//', '#'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    keywords: words(
      'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield',
    ),
    literals: words('true false null TRUE FALSE NULL'),
    fn: true,
  },
  ruby: {
    line: ['#'],
    quotes: ['"', "'"],
    keywords: words(
      'alias and begin break case class def do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require attr_accessor attr_reader attr_writer puts gets lambda proc',
    ),
    literals: words('true false nil self'),
    fn: true,
  },
  lua: {
    line: ['--'],
    quotes: ['"', "'"],
    keywords: words('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'),
    literals: words('true false nil'),
    fn: true,
  },
  sql: {
    line: ['--'],
    block: [['/*', '*/']],
    quotes: ["'", '"'],
    keywords: SQL_KEYWORDS,
    literals: words('true false null'),
    ignoreCase: true,
    fn: true,
  },
  yaml: { line: ['#'], quotes: ['"', "'"], literals: YAML_LITERALS, keyed: true, ignoreCase: true },
  toml: { line: ['#'], quotes: ['"', "'"], literals: words('true false'), keyed: true },
  ini: { line: ['#', ';'], quotes: ['"', "'"], literals: words('true false'), keyed: true, ignoreCase: true },
  dockerfile: {
    line: ['#'],
    quotes: ['"', "'"],
    keywords: words(
      'FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS',
    ),
    ignoreCase: true,
  },
  makefile: {
    line: ['#'],
    quotes: ['"', "'"],
    keywords: words('include define endef ifeq ifneq ifdef ifndef else endif export unexport override .PHONY'),
  },
  diff: { mode: 'diff' },
}

/** 别名 → 语言表键（`ts` / `py` / `yml` 这些日常写法都要认） */
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript', javascript: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup',
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  sh: 'shell', shell: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', fish: 'shell', ksh: 'shell',
  bat: 'shell', cmd: 'shell', dos: 'shell', powershell: 'shell', ps1: 'shell',
  py: 'python', python: 'python', python3: 'python',
  rs: 'rust', rust: 'rust',
  go: 'go', golang: 'go',
  java: 'java', kt: 'kotlin', kotlin: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', csharp: 'csharp',
  swift: 'swift', objc: 'c', objectivec: 'c',
  php: 'php', rb: 'ruby', ruby: 'ruby',
  sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', conf: 'ini', cfg: 'ini', env: 'ini', properties: 'ini',
  diff: 'diff', patch: 'diff',
  docker: 'dockerfile', dockerfile: 'dockerfile',
  make: 'makefile', makefile: 'makefile', mk: 'makefile',
  lua: 'lua',
}

/** 归一化语言标记；不认识的一律当纯文本 */
export function normalizeLang(lang?: string): string {
  const key = (lang ?? '').trim().toLowerCase()
  if (!key) return 'text'
  return LANG_ALIASES[key] ?? 'text'
}

/** 这门语言有没有着色能力（预览里可以据此决定是否显示语言标签） */
export function canHighlight(lang?: string): boolean {
  return normalizeLang(lang) in LANGS
}

/* ------------------------------------------------------------------ 扫描 */

function isWordStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36 || code > 0x7f
}

function isWordChar(code: number): boolean {
  return isWordStart(code) || (code >= 48 && code <= 57)
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

/** 当前位置之后（跳过空白）是不是冒号 —— JSON/YAML 的键判定 */
function isKeyAhead(code: string, from: number): boolean {
  let j = from
  const n = code.length
  while (j < n) {
    const ch = code[j] as string
    if (ch === ' ' || ch === '\t') {
      j += 1
      continue
    }
    return ch === ':'
  }
  return false
}

function scanCode(code: string, spec: LangSpec, emit: Emit): void {
  const n = code.length
  const stops = new Set<string>()
  for (const mark of spec.line ?? []) stops.add(mark[0] as string)
  for (const pair of spec.block ?? []) stops.add(pair[0][0] as string)
  for (const quote of spec.quotes ?? []) stops.add(quote)
  for (const quote of spec.multiline ?? []) stops.add(quote)

  let index = 0
  let depth = 0

  while (index < n) {
    const ch = code[index] as string
    const code0 = ch.charCodeAt(0)

    // 块注释
    let matched = false
    for (const [open, close] of spec.block ?? []) {
      if (!code.startsWith(open, index)) continue
      const end = code.indexOf(close, index + open.length)
      const stop = end === -1 ? n : end + close.length
      emit('com', code.slice(index, stop))
      index = stop
      matched = true
      break
    }
    if (matched) continue

    // 行注释
    for (const mark of spec.line ?? []) {
      if (!code.startsWith(mark, index)) continue
      let end = code.indexOf('\n', index)
      if (end === -1) end = n
      emit('com', code.slice(index, end))
      index = end
      matched = true
      break
    }
    if (matched) continue

    // 三引号（Python 的 """ / '''）
    if (spec.triple && (ch === '"' || ch === "'") && code.startsWith(ch.repeat(3), index)) {
      const end = code.indexOf(ch.repeat(3), index + 3)
      const stop = end === -1 ? n : end + 3
      emit('str', code.slice(index, stop))
      index = stop
      continue
    }

    // 可跨行字符串（模板串 / SQL 单引号）
    if (spec.multiline?.includes(ch)) {
      let j = index + 1
      while (j < n) {
        const current = code[j] as string
        if (current === '\\') {
          j += 2
          continue
        }
        if (current === ch) {
          j += 1
          break
        }
        j += 1
      }
      const stop = Math.min(j, n)
      emit('str', code.slice(index, stop))
      index = stop
      continue
    }

    // 普通字符串
    if (spec.quotes?.includes(ch)) {
      let j = index + 1
      while (j < n) {
        const current = code[j] as string
        if (current === '\\') {
          j += 2
          continue
        }
        if (current === ch) {
          j += 1
          break
        }
        if (current === '\n') break
        j += 1
      }
      const stop = Math.min(j, n)
      emit(spec.keyed && isKeyAhead(code, stop) ? 'key' : 'str', code.slice(index, stop))
      index = stop
      continue
    }

    // 数字
    if (isDigit(code0)) {
      let j = index + 1
      const prefix = code[j]
      if (prefix === 'x' || prefix === 'X') {
        j += 1
        while (j < n && /[0-9a-fA-F_]/.test(code[j] as string)) j += 1
      } else if (prefix === 'b' || prefix === 'B' || prefix === 'o' || prefix === 'O') {
        j += 1
        while (j < n && /[0-9_]/.test(code[j] as string)) j += 1
      } else {
        while (j < n && /[0-9_]/.test(code[j] as string)) j += 1
        if (code[j] === '.') {
          j += 1
          while (j < n && /[0-9_]/.test(code[j] as string)) j += 1
        }
        if (code[j] === 'e' || code[j] === 'E') {
          let k = j + 1
          if (code[k] === '+' || code[k] === '-') k += 1
          if (k < n && isDigit(code.charCodeAt(k))) {
            j = k
            while (j < n && /[0-9_]/.test(code[j] as string)) j += 1
          }
        }
      }
      emit('num', code.slice(index, j))
      index = j
      continue
    }

    // 标识符：关键字 / 字面量 / 类型 / 键名 / 函数名
    if (isWordStart(code0)) {
      let j = index + 1
      while (j < n && isWordChar(code.charCodeAt(j))) j += 1
      const word = code.slice(index, j)
      const probe = spec.ignoreCase ? word.toLowerCase() : word
      let cls = ''
      if (spec.keywords?.has(probe)) cls = 'kw'
      else if (spec.literals?.has(probe)) cls = 'num'
      else if (spec.types?.has(probe)) cls = 'key'
      else if (spec.keyed && isKeyAhead(code, j)) cls = 'key'
      else if (spec.fn && code[j] === '(') cls = 'fn'
      // CSS：`{` 外是选择器、`{` 内是取值关键字
      else if (spec.css) cls = depth === 0 ? 'tag' : 'key'
      else if (spec.capType && code0 >= 65 && code0 <= 90) cls = 'key'
      emit(cls, word)
      index = j
      continue
    }

    // 其余：标点 / 运算符 / 空白，连着吃到下一个「有意义的字符」为止
    let j = index + 1
    while (j < n) {
      const current = code.charCodeAt(j)
      if (isWordStart(current) || isDigit(current) || stops.has(code[j] as string)) break
      j += 1
    }
    const punct = code.slice(index, j)
    if (spec.css) {
      for (const mark of punct) {
        if (mark === '{') depth += 1
        else if (mark === '}') depth = Math.max(0, depth - 1)
      }
    }
    emit('pun', punct)
    index = j
  }
}

/* ------------------------------------------------------------- markup（HTML / XML / Vue） */

function scanTag(tag: string, emit: Emit): void {
  const n = tag.length
  let i = 1
  emit('pun', '<')
  if (tag[i] === '/') {
    emit('pun', '/')
    i += 1
  }
  let j = i
  while (j < n && /[A-Za-z0-9_:.-]/.test(tag[j] as string)) j += 1
  emit('tag', tag.slice(i, j))
  i = j

  while (i < n) {
    const ch = tag[i] as string
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      let k = i + 1
      while (k < n && (tag[k] === ' ' || tag[k] === '\t' || tag[k] === '\n')) k += 1
      emit('', tag.slice(i, k))
      i = k
      continue
    }
    if (ch === '=') {
      emit('pun', '=')
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      let k = i + 1
      while (k < n && tag[k] !== ch) k += 1
      emit('str', tag.slice(i, Math.min(k + 1, n)))
      i = k + 1
      continue
    }
    if (ch === '/' || ch === '>' || ch === '?' || ch === '!') {
      emit('pun', ch)
      i += 1
      continue
    }
    let k = i + 1
    while (k < n && !/[\s=>/?!]/.test(tag[k] as string)) k += 1
    emit('key', tag.slice(i, k))
    i = k
  }
}

function scanMarkup(code: string, emit: Emit): void {
  const n = code.length
  let i = 0
  let textStart = 0
  const flush = (end: number): void => {
    if (end > textStart) emit('', code.slice(textStart, end))
  }
  while (i < n) {
    if (code.startsWith('<!--', i)) {
      const close = code.indexOf('-->', i + 4)
      const end = close === -1 ? n : close + 3
      flush(i)
      emit('com', code.slice(i, end))
      i = end
      textStart = i
      continue
    }
    if (code[i] === '<' && i + 1 < n && /[A-Za-z/!?]/.test(code[i + 1] as string)) {
      flush(i)
      let end = code.indexOf('>', i)
      if (end === -1) end = n - 1
      scanTag(code.slice(i, end + 1), emit)
      i = end + 1
      textStart = i
      continue
    }
    i += 1
  }
  flush(n)
}

/* ------------------------------------------------------------- diff */

function scanDiff(code: string, emit: Emit): void {
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) emit('', '\n')
    const line = lines[i] as string
    if (/^(diff |index |--- |\+\+\+ |@@ |\\ )/.test(line)) emit('meta', line)
    else if (line.startsWith('+')) emit('add', line)
    else if (line.startsWith('-')) emit('del', line)
    else emit('', line)
  }
}

/* ------------------------------------------------------------------ 出口 */

export function highlightCode(code: string, lang?: string): string {
  const spec = LANGS[normalizeLang(lang)]
  if (!spec || code.length > HIGHLIGHT_LIMIT) return escapeHtml(code)
  const out: string[] = []
  const emit: Emit = (cls, text) => {
    if (!text) return
    out.push(cls ? `<span class="md-hl-${cls}">${escapeHtml(text)}</span>` : escapeHtml(text))
  }
  if (spec.mode === 'markup') scanMarkup(code, emit)
  else if (spec.mode === 'diff') scanDiff(code, emit)
  else scanCode(code, spec, emit)
  return out.join('')
}
