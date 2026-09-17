/**
 * 状态条数据（`services/systemStats.ts`）：**启动台自身**的 CPU / 内存采样。
 *
 * 守四件事：
 *  - **内存 = 壳 + 内核两进程之和**（"启动台一共占多少"是两半拼起来的，
 *    任何一半丢了都会让用户低估 —— 而低估正是这个数字被做出来的理由）；
 *  - **CPU 是差分值**：累计 CPU 时间 ÷ 墙钟 ÷ 核心数，且拿不到壳时**记 null**，
 *    绝不拿一半的差值冒充整体（那会让读数在不同量级之间跳，比没有还糟）；
 *  - **数值范围合法**（0–100、已用 ≤ 总量）：状态条画的是"一眼看懂"的数字，
 *    一个负数或者 300% 会让用户从此不再看它；
 *  - **并发读取共享同一次采样**：UI 轮询与其它调用撞上时不能各自算一遍。
 */
import os from 'node:os'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { SystemStatsSampler } from '../../apps/kernel/src/services/systemStats'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('启动台自身占用：内存是壳 + 内核两进程之和', async () => {
  const shellRss = 80 * 1024 * 1024
  const sampler = new SystemStatsSampler({ shellUsage: async () => ({ rss: shellRss, cpuMs: 1000 }) })
  sampler.warmup()

  // 首次：`warmup` 的基线只有内核那一半（拿壳要走异步 IPC）⇒ 不给出 CPU 数字。
  // 这里必须守住 —— 含壳与不含壳的累计值相减，会把壳"开机以来"的 CPU 全算进这一刻（实测 312%）。
  const first = await sampler.read()
  assertEqual(first.app.cpu, null, '基线不含壳时不能给 CPU 数字')
  assertEqual(first.app.rssShell, shellRss, '壳的内存应当原样进来')

  await sleep(40)
  const stats = await sampler.read()
  assert(stats.app.rssKernel > 0, '内核自身的 RSS 应当大于 0')
  assertEqual(stats.app.rss, stats.app.rssShell + stats.app.rssKernel, '总量必须是两进程之和')
  assertEqual(stats.app.cores, os.cpus().length, '核心数用于把 CPU 归一成"占整机"')
  assert(
    stats.app.cpu !== null && stats.app.cpu >= 0 && stats.app.cpu <= 100,
    `CPU 应当是 0–100 的数，实际 ${stats.app.cpu}`,
  )
})

test('壳读不到（standalone）时退化成"只报内核"，CPU 记 null', async () => {
  const sampler = new SystemStatsSampler({ shellUsage: async () => null })
  sampler.warmup()
  await sleep(20)
  const first = await sampler.read()
  assertEqual(first.app.rssShell, 0, '没有壳就没有壳的内存')
  assert(first.app.rss > 0, '内核那一半仍然要报出来')
  assertEqual(first.app.cpu, null, '拿不到壳的累计 CPU 时不能假装整体')
})

test('CPU 差分：累计时间增长会按核心数归一成"占整机"的百分比', async () => {
  // 造一个"壳在持续烧 CPU"的场景：每次读，累计 CPU 都涨 600ms
  let cpuMs = 0
  const sampler = new SystemStatsSampler({
    shellUsage: async () => {
      cpuMs += 600
      return { rss: 1024, cpuMs }
    },
  })
  sampler.warmup()
  await sampler.read() // 先建立含壳的基线
  await sleep(300)
  const stats = await sampler.read()
  const cores = os.cpus().length || 1
  // 壳那一份独占 600ms / 300ms / cores ⇒ 至少是 100/cores 的一半（内核自身只会更多）
  const floor = 100 / cores / 2
  assert(
    stats.app.cpu !== null && stats.app.cpu >= floor,
    `CPU 百分比应当至少 ${floor.toFixed(1)}%，实际 ${stats.app.cpu}`,
  )
  assert(stats.app.cpu <= 100, `占整机的百分比不该超过 100%，实际 ${stats.app.cpu}`)
})

test('整机对照数据（CPU / 内存 / 负载）仍然齐全且合法', async () => {
  const sampler = new SystemStatsSampler({ shellUsage: async () => null })
  sampler.warmup()
  const stats = await sampler.read()

  assert(stats.cpu >= 0 && stats.cpu <= 100, `整机 CPU 应当落在 0–100，实际 ${stats.cpu}`)
  assert(stats.memTotal > 0, '内存总量应当大于 0')
  assert(
    stats.memUsed > 0 && stats.memUsed <= stats.memTotal,
    `已用内存应当落在 (0, 总量]，实际 ${stats.memUsed}/${stats.memTotal}`,
  )
  assertEqual(stats.loadAvg.length, 3, '负载应当是 1 / 5 / 15 三档')
  assert(Math.abs(stats.sampledAt - Date.now()) < 5000, '采样时刻应当就是刚才')

  // 第二次读取：预热 + 上次采样都在，直接差分（不等待短窗口采样）
  const startedAt = Date.now()
  await sampler.read()
  assert(Date.now() - startedAt < 200, '已有新鲜采样时不应该再等一个采样窗口')
})

test('并发读取共享同一次采样（UI 轮询与其它调用撞上时不会各算一遍）', async () => {
  const sampler = new SystemStatsSampler({ shellUsage: async () => ({ rss: 4096, cpuMs: 1 }) })
  sampler.warmup()
  const [a, b] = await Promise.all([sampler.read(), sampler.read()])
  assertEqual(a.sampledAt, b.sampledAt, '同一批并发读取应当拿到同一份采样')
})

const failed = await run('启动台自身占用采样')
if (failed > 0) process.exit(1)
