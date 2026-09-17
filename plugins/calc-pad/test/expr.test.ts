import assert from 'node:assert/strict'
import { evaluate, tokenize, assignedName } from '../src/core/expr'

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err instanceof Error ? err.stack : err)
    process.exitCode = 1
  }
}

function value(expr: string, scope = { vars: {} as Record<string, number> }): number {
  const result = evaluate(expr, scope)
  if (!result.ok) throw new Error(`期望算得出结果，实际报错：${result.error}`)
  return result.value
}

function error(expr: string, scope = { vars: {} as Record<string, number> }): string {
  const result = evaluate(expr, scope)
  if (result.ok) throw new Error(`期望报错，实际算出 ${result.value}`)
  return result.error
}

console.log('四则与优先级')

test('加减乘除', () => {
  assert.equal(value('55+88+7689*543'), 4175270)
  assert.equal(value('1 + 2 * 3'), 7)
  assert.equal(value('(1 + 2) * 3'), 9)
  assert.equal(value('10 / 4'), 2.5)
})

test('中文全角符号也能算', () => {
  assert.equal(value('（2＋3）×4'), 20)
})

test('幂右结合，** 等价于 ^', () => {
  assert.equal(value('2^3^2'), 512)
  assert.equal(value('2**10'), 1024)
})

test('一元负号与括号', () => {
  assert.equal(value('-3^2'), -9)
  assert.equal(value('(-3)^2'), 9)
})

console.log('百分号与取模')

test('后缀百分号', () => {
  assert.equal(value('50%'), 0.5)
  assert.equal(value('200 * 15%'), 30)
})

test('二元取模', () => {
  assert.equal(value('10 % 3'), 1)
  assert.equal(value('10 mod 4'), 2)
})

console.log('函数与常量')

test('常用函数', () => {
  assert.equal(value('sqrt(16)'), 4)
  assert.equal(value('max(3, 7, 5)'), 7)
  assert.equal(value('min(3, 7, 5)'), 3)
  assert.equal(value('round(3.14159, 2)'), 3.14)
  assert.equal(value('abs(-8)'), 8)
})

test('常量与隐式乘法', () => {
  assert.ok(Math.abs(value('2pi') - Math.PI * 2) < 1e-12)
  assert.equal(value('2(3+4)'), 14)
})

test('参数个数不对要报错', () => {
  assert.ok(error('sqrt(1, 2)').includes('参数'))
  assert.ok(error('max(1)').includes('参数'))
})

test('未知变量与函数', () => {
  assert.ok(error('foo(1)').includes('未知的变量或函数'))
  assert.ok(error('bar + 1').includes('未知的变量或函数'))
})

console.log('变量与 ans')

test('赋值并复用', () => {
  const first = evaluate('a = 3 * 7')
  assert.ok(first.ok)
  assert.equal(first.value, 21)
  const second = evaluate('a / 2', { vars: first.vars })
  assert.ok(second.ok)
  assert.equal(second.value, 10.5)
})

test('ans 引用上一行结果', () => {
  const result = evaluate('ans + 1', { vars: {}, last: 41 })
  assert.ok(result.ok)
  assert.equal(result.value, 42)
})

test('没有上一行结果时 ans 报错', () => {
  assert.ok(error('ans + 1').includes('ans'))
})

console.log('错误与边界')

test('除零与括号不匹配', () => {
  assert.equal(error('1 / 0'), '除数不能为 0')
  assert.equal(error('(1 + 2'), '括号不匹配')
  assert.equal(error('1 + '), '表达式不完整')
})

test('空输入与多余输入', () => {
  assert.equal(error('   '), '缺少表达式')
  assert.ok(error('(1 + 2))').includes('多出来的输入'))
  assert.equal(value('1 2 3'), 6, '相邻的操作数按隐式乘法算（和 2pi 同一套规则）')
})

test('千分位数字可以带逗号', () => {
  assert.equal(value('1,234 + 1'), 1235)
  assert.equal(value('max(1,2)'), 2)
})

test('tokenize 拒绝未知字符', () => {
  const tokens = tokenize('1 & 2')
  assert.ok(!Array.isArray(tokens))
})

console.log('赋值名识别')

test('assignedName 只认单个等号', () => {
  assert.equal(assignedName('total = 1 + 2'), 'total')
  assert.equal(assignedName('1 + 2'), undefined)
  assert.equal(assignedName('a == b'), undefined)
})

console.log(`\n通过 ${passed} 项`)
