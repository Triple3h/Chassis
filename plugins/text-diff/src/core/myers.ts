/**
 * Myers O(ND) 差分算法（线性空间分治版）。
 *
 * 参考：E. Myers, "An O(ND) Difference Algorithm and Its Variations" (1986) 第 4b 节。
 * 为什么不用「记录完整 V 轨迹再回溯」的写法：那种实现的空间是 O(D·N)，
 * 两份差异较大的大文件直接把内存打爆；这里用「找中间蛇 + 分治」，
 * 空间稳定在 O(N+M)，并且每层递归都会先削掉公共前后缀，实际常数很小。
 *
 * 额外两道保险：
 *   1. deadline —— 超过预算就退化成「整段替换」，宁可结果粗一点也不能卡住 UI；
 *   2. 调用方可以先用 patience 锚点粗切，再对小段调用本函数。
 */

export type OpKind = 'eq' | 'del' | 'ins'

export interface EditOp {
  kind: OpKind
  /** A（旧）侧区间 [a0, a1) */
  a0: number
  a1: number
  /** B（新）侧区间 [b0, b1) */
  b0: number
  b1: number
}

/** 中间蛇（一条完全匹配的对角线段）：A 侧 [x, u)，B 侧 [y, v) */
interface Snake {
  x: number
  y: number
  u: number
  v: number
}

let vf = new Int32Array(1)
let vr = new Int32Array(1)

export interface DiffOptions {
  /** 时间预算，超出后退化为整段替换 */
  deadlineMs?: number
  /** 单次「找中间蛇」允许的最大编辑距离，避免 O(D²) 在极端输入上爆炸 */
  maxD?: number
}

/**
 * 计算两个整数序列的差异。
 * @param a 旧序列（一般是用行内容映射出的整数 id）
 * @param b 新序列
 */
export function diffInts(a: Int32Array, b: Int32Array, options: DiffOptions = {}): EditOp[] {
  const out: EditOp[] = []
  const deadlineMs = options.deadlineMs ?? 800
  const maxD = options.maxD ?? 3000
  const deadline = deadlineMs > 0 ? Date.now() + deadlineMs : Number.POSITIVE_INFINITY
  const n = a.length
  const m = b.length
  /** 递归节点上限：任何实现层面的意外都退化成整段替换，绝不允许死循环 */
  let budget = 400_000

  if (n === 0 && m === 0) return out
  if (n === 0) {
    out.push({ kind: 'ins', a0: 0, a1: 0, b0: 0, b1: m })
    return out
  }
  if (m === 0) {
    out.push({ kind: 'del', a0: 0, a1: n, b0: 0, b1: 0 })
    return out
  }

  rec(0, n, 0, m, 0)
  return merge(out)

  function push(kind: OpKind, a0: number, a1: number, b0: number, b1: number) {
    // 过滤空区间，避免产生噪声操作
    if (kind === 'eq' && (a0 === a1 || b0 === b1)) return
    if (kind === 'del' && a0 === a1) return
    if (kind === 'ins' && b0 === b1) return
    out.push({ kind, a0, a1, b0, b1 })
  }

  function rec(a0: number, a1: number, b0: number, b1: number, depth: number) {
    // 1) 削公共前缀
    let p = 0
    while (a0 + p < a1 && b0 + p < b1 && a[a0 + p] === b[b0 + p]) p++
    if (p) {
      push('eq', a0, a0 + p, b0, b0 + p)
      a0 += p
      b0 += p
    }
    // 2) 削公共后缀
    let s = 0
    while (a1 - 1 - s >= a0 && b1 - 1 - s >= b0 && a[a1 - 1 - s] === b[b1 - 1 - s]) s++
    const ae = a1 - s
    const be = b1 - s

    // 3) 中间部分
    if (a0 === ae && b0 === be) {
      /* 完全相等 */
    } else if (a0 === ae) {
      push('ins', a0, ae, b0, be)
    } else if (b0 === be) {
      push('del', a0, ae, b0, be)
    } else if (depth > 64 || Date.now() > deadline || budget-- <= 0) {
      push('del', a0, ae, b0, b0)
      push('ins', ae, ae, b0, be)
    } else {
      const snake = middleSnake(a0, ae, b0, be)
      // 中间蛇允许是零长度（只是一个切分点），它的意义在于把编辑距离一分为二；
      // 这里只校验区间合法性，深度与预算两道闸负责兜底。
      const valid = snake && snake.x >= a0 && snake.u <= ae && snake.y >= b0 && snake.v <= be
      if (!valid) {
        push('del', a0, ae, b0, b0)
        push('ins', ae, ae, b0, be)
      } else {
        const s = snake as Snake
        rec(a0, s.x, b0, s.y, depth + 1)
        push('eq', s.x, s.u, s.y, s.v)
        rec(s.u, ae, s.v, be, depth + 1)
      }
    }

    // 4) 后缀
    if (s) push('eq', ae, a1, be, b1)
  }

  /** 在 [a0,a1) × [b0,b1) 中找中间蛇 */
  function middleSnake(a0: number, a1: number, b0: number, b1: number): Snake | null {
    const N = a1 - a0
    const M = b1 - b0
    // 两边毫无公共行时 D ≈ N+M，逐层推进是 O(D²)：这里设上限，超了就让调用方退化成整段替换
    const limit = Math.min(Math.ceil((N + M) / 2), maxD)
    const delta = N - M
    const odd = (delta & 1) !== 0
    const size = 2 * limit + 3
    if (vf.length < size) {
      vf = new Int32Array(size)
      vr = new Int32Array(size)
    } else {
      vf.fill(0, 0, size)
      vr.fill(0, 0, size)
    }
    const off = limit + 1
    vf[off + 1] = 0
    vr[off + 1] = 0

    for (let d = 0; d <= limit; d++) {
      // 每 16 轮检查一次时间预算，避免单次调用独占整个 deadline
      if ((d & 15) === 0 && Date.now() > deadline) return null
      // 正向推进
      for (let k = -d; k <= d; k += 2) {
        let x: number
        if (k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1])) x = vf[off + k + 1]
        else x = vf[off + k - 1] + 1
        let y = x - k
        const x0 = x
        const y0 = y
        while (x < N && y < M && a[a0 + x] === b[b0 + y]) {
          x++
          y++
        }
        vf[off + k] = x
        // 论文原文的相交判定：正向 D-path 与反向 (D-1)-path 在 [delta-(D-1), delta+(D-1)] 上相遇
        if (odd && k >= delta - d + 1 && k <= delta + d - 1 && x + vr[off + delta - k] >= N) {
          return { x: a0 + x0, y: b0 + y0, u: a0 + x, v: b0 + y }
        }
      }
      // 反向推进
      for (let k = -d; k <= d; k += 2) {
        let x: number
        if (k === -d || (k !== d && vr[off + k - 1] < vr[off + k + 1])) x = vr[off + k + 1]
        else x = vr[off + k - 1] + 1
        let y = x - k
        const x0 = x
        const y0 = y
        while (x < N && y < M && a[a1 - x - 1] === b[b1 - y - 1]) {
          x++
          y++
        }
        vr[off + k] = x
        if (!odd && x + vf[off + delta - k] >= N && k >= delta - d && k <= delta + d) {
          return { x: a1 - x, y: b1 - y, u: a1 - x0, v: b1 - y0 }
        }
      }
    }
    return null
  }
}

/** 合并相邻同类操作，减少下游行数 */
function merge(ops: EditOp[]): EditOp[] {
  const out: EditOp[] = []
  for (const op of ops) {
    const last = out[out.length - 1]
    if (last && last.kind === op.kind && last.a1 === op.a0 && last.b1 === op.b0) {
      last.a1 = op.a1
      last.b1 = op.b1
    } else {
      out.push({ ...op })
    }
  }
  return out
}

/** 把若干操作按「删一段 + 插一段」配对成变更块，方便并排渲染 */
export interface ChangeBlock {
  del: EditOp | null
  ins: EditOp | null
  eq: EditOp | null
}

export function groupOps(ops: EditOp[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = []
  let pendingDel: EditOp | null = null
  for (const op of ops) {
    if (op.kind === 'del') {
      pendingDel = op
      continue
    }
    if (op.kind === 'ins') {
      blocks.push({ del: pendingDel, ins: op, eq: null })
      pendingDel = null
      continue
    }
    if (pendingDel) {
      blocks.push({ del: pendingDel, ins: null, eq: null })
      pendingDel = null
    }
    blocks.push({ del: null, ins: null, eq: op })
  }
  if (pendingDel) blocks.push({ del: pendingDel, ins: null, eq: null })
  return blocks
}
