/** 极简断言/用例收集（requirements §11：无测试框架） */

interface Case {
  name: string
  fn: () => void | Promise<void>
}

const queue: Case[] = []
const failures: string[] = []
let passed = 0

export function test(name: string, fn: () => void | Promise<void>): void {
  queue.push({ name, fn })
}

export function assert(condition: unknown, message = '断言失败'): asserts condition {
  if (!condition) throw new Error(message)
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(`${message ?? '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

export function assertDeepEqual(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message ?? '结构不相等'}：期望 ${b}，实际 ${a}`)
}

export async function assertRejects(fn: () => Promise<unknown>, code?: string, message?: string): Promise<void> {
  try {
    await fn()
  } catch (err) {
    const actual = (err as { code?: string }).code
    if (code && actual !== code) {
      throw new Error(`${message ?? '错误码不符'}：期望 ${code}，实际 ${actual ?? '(无 code)'} — ${String(err)}`)
    }
    return
  }
  throw new Error(message ?? '期望抛出错误，但没有')
}

export async function run(title = '测试'): Promise<number> {
  process.stdout.write(`\n${title}\n`)
  for (const item of queue) {
    try {
      await item.fn()
      passed += 1
      process.stdout.write(`  ✓ ${item.name}\n`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push(`${item.name}: ${message}`)
      process.stdout.write(`  ✗ ${item.name}\n      ${message}\n`)
    }
  }
  process.stdout.write(`\n  ${passed} 通过，${failures.length} 失败\n`)
  return failures.length
}
