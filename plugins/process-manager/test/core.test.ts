import assert from 'node:assert/strict'
import {
  formatBytes,
  formatClock,
  formatPercent,
  formatUptime,
  killTargetFromProc,
  matchesPortQuery,
  matchesProcQuery,
  memoryShare,
  sortPorts,
  sortProcs,
  stateLabel,
} from '../src/core/format'
import type { PortEntry, ProcEntry } from '../src/core/types'

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err instanceof Error ? err.stack : err)
    process.exitCode = 1
  }
}

function port(patch: Partial<PortEntry>): PortEntry {
  return {
    port: 3000,
    protocol: 'tcp',
    address: '*',
    state: 'listen',
    pid: 100,
    process: 'node',
    user: 'me',
    memory: 1024,
    risk: 'safe',
    selfRelated: false,
    ...patch,
  }
}

function proc(patch: Partial<ProcEntry>): ProcEntry {
  return { pid: 100, name: 'node', user: 'me', cpu: 1, memory: 1024, parent: 1, risk: 'safe', selfRelated: false, ...patch }
}

console.log('format')

await test('字节格式化：单位、精度与空值', () => {
  assert.equal(formatBytes(0), '0 B', '0 字节不进 KB 档')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.00 KB')
  assert.equal(formatBytes(1536), '1.50 KB')
  assert.equal(formatBytes(154 * 1024 * 1024), '154 MB', '超过 100 不带小数')
  assert.equal(formatBytes(16 * 1024 ** 3), '16.0 GB', '10–100 保留一位')
  assert.equal(formatBytes(null), '—')
  assert.equal(formatBytes(undefined), '—')
  assert.equal(formatBytes(Number.NaN), '—')
})

await test('CPU 百分比：0 就是 0%，小于 10 保留一位', () => {
  assert.equal(formatPercent(0), '0%')
  assert.equal(formatPercent(5.56), '5.6%')
  assert.equal(formatPercent(9.94), '9.9%')
  assert.equal(formatPercent(42.6), '43%')
  assert.equal(formatPercent(null), '0%')
})

await test('内存占比：总量未知时不给数字', () => {
  assert.equal(memoryShare(1024, 4096), 25)
  assert.equal(memoryShare(1024, 0), null)
  assert.equal(memoryShare(null, 4096), null)
})

await test('时钟格式化补零', () => {
  const ms = new Date(2026, 8, 19, 9, 5, 3).getTime()
  assert.equal(formatClock(ms), '09:05:03')
  assert.equal(formatClock(0), '—')
})

await test('运行时长按档位显示', () => {
  const now = 1_800_000_000_000
  const secs = now / 1000
  assert.equal(formatUptime(secs - 30, now), '30 秒')
  assert.equal(formatUptime(secs - 5 * 60, now), '5 分钟')
  assert.equal(formatUptime(secs - (2 * 3600 + 5 * 60), now), '2 小时 5 分')
  assert.equal(formatUptime(secs - (4 * 86400 + 3 * 3600), now), '4 天 3 小时')
  assert.equal(formatUptime(0, now), '—')
  assert.equal(formatUptime(null, now), '—')
})

await test('socket 状态标签', () => {
  assert.equal(stateLabel('listen'), '监听')
  assert.equal(stateLabel('established'), '已连接')
  assert.equal(stateLabel(''), '—')
  assert.equal(stateLabel('syn_recv'), 'SYN_RECV')
})

console.log('filter')

await test('端口过滤：端口号 / :端口 / 进程名 / PID / 用户 / 协议', () => {
  const entry = port({ port: 3000, process: 'node', pid: 51234, user: 'triple3h' })
  assert.ok(matchesPortQuery(entry, ''), '空查询全通过')
  assert.ok(matchesPortQuery(entry, '3000'))
  assert.ok(matchesPortQuery(entry, ':3000'), '带冒号的写法是直觉输入')
  assert.ok(matchesPortQuery(entry, '30'), '包含即命中')
  assert.ok(matchesPortQuery(entry, 'NODE'), '大小写不敏感')
  assert.ok(matchesPortQuery(entry, '51234'))
  assert.ok(matchesPortQuery(entry, 'triple'))
  assert.ok(matchesPortQuery(entry, 'tcp'))
  assert.equal(matchesPortQuery(entry, '5432'), false)
  assert.equal(matchesPortQuery(entry, 'postgres'), false)
})

await test('进程过滤：名称 / PID / 用户', () => {
  const entry = proc({ name: 'OrbStack Helper', pid: 949, user: 'me' })
  assert.ok(matchesProcQuery(entry, ''))
  assert.ok(matchesProcQuery(entry, 'orbstack'))
  assert.ok(matchesProcQuery(entry, 'helper'))
  assert.ok(matchesProcQuery(entry, '949'))
  assert.equal(matchesProcQuery(entry, 'docker'), false)
})

console.log('sort')

await test('端口默认按端口号升序，同端口按 PID', () => {
  const list = sortPorts([port({ port: 8080 }), port({ port: 3000, pid: 20 }), port({ port: 3000, pid: 10 })], 'port')
  assert.deepEqual(
    list.map((entry) => [entry.port, entry.pid]),
    [
      [3000, 10],
      [3000, 20],
      [8080, 100],
    ],
  )
})

await test('端口可按内存排序，缺内存的排最后', () => {
  const list = sortPorts([port({ port: 1, memory: null }), port({ port: 2, memory: 100 }), port({ port: 3, memory: 999 })], 'memory')
  assert.deepEqual(list.map((entry) => entry.port), [3, 2, 1])
})

await test('进程默认按 CPU 降序（内存做次序）', () => {
  const list = sortProcs([proc({ pid: 1, cpu: 5 }), proc({ pid: 2, cpu: 50 }), proc({ pid: 3, cpu: 5, memory: 2048 })], 'cpu')
  assert.deepEqual(list.map((entry) => entry.pid), [2, 3, 1])
})

await test('进程可按 PID / 名称排序', () => {
  const list = [proc({ pid: 30, name: 'b' }), proc({ pid: 10, name: 'a' })]
  assert.deepEqual(sortProcs(list, 'pid').map((entry) => entry.pid), [10, 30])
  assert.deepEqual(sortProcs(list, 'name').map((entry) => entry.name), ['a', 'b'])
})

console.log('kill target')

await test('从进程行取终止目标（带上占用端口）', () => {
  const target = killTargetFromProc(proc({ pid: 51234, name: 'node', cpu: 12.5, risk: 'caution' }), [3000, 5173])
  assert.equal(target.pid, 51234)
  assert.equal(target.name, 'node')
  assert.equal(target.cpu, 12.5)
  assert.equal(target.risk, 'caution')
  assert.deepEqual(target.ports, [3000, 5173])
  assert.equal(target.selfRelated, false)
})

console.log(`\n${passed} 项通过`)
