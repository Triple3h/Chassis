/**
 * 桥调用去重（§11 过渡期双协议）：
 * SDK 每次调用发两条信封，底座只处理原生那条，平铺副本必须丢弃。
 */
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createCallDedupe } from '../../apps/launcher-ui/src/lib/bridge-calls'

test('原生信封先到，随后的同 id 平铺副本被丢弃', () => {
  const dedupe = createCallDedupe()
  assertEqual(dedupe.isDuplicate(1, true), false, '原生要放行')
  assertEqual(dedupe.isDuplicate(1, false), true, '平铺副本要丢弃')
})

test('只发平铺的老插件不受影响（没有原生信封就不去重）', () => {
  const dedupe = createCallDedupe()
  assertEqual(dedupe.isDuplicate(7, false), false)
  assertEqual(dedupe.isDuplicate(8, false), false)
})

test('id 不同互不影响', () => {
  const dedupe = createCallDedupe()
  dedupe.isDuplicate(3, true)
  assertEqual(dedupe.isDuplicate(4, false), false)
  assertEqual(dedupe.isDuplicate(3, false), true)
})

test('原生信封重复到达时仍然放行（不做业务去重）', () => {
  const dedupe = createCallDedupe()
  assertEqual(dedupe.isDuplicate(5, true), false)
  assertEqual(dedupe.isDuplicate(5, true), false)
  assertEqual(dedupe.isDuplicate(5, false), true)
})

test('超过容量后老 id 被淘汰，不再误判为重复', () => {
  const dedupe = createCallDedupe(3)
  for (const id of [1, 2, 3]) dedupe.isDuplicate(id, true)
  dedupe.isDuplicate(4, true) // 挤掉 1
  assertEqual(dedupe.isDuplicate(1, false), false, '1 已被淘汰，不该丢弃')
  assertEqual(dedupe.isDuplicate(4, false), true)
})

const failed = await run('桥调用去重（UI）')
if (failed > 0) process.exit(1)
