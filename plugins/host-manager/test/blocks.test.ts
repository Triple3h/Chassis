import assert from 'node:assert/strict'
import {
  REGION_BEGIN,
  REGION_END,
  addBlockEntries,
  adoptOutsideEntry,
  applyLayer,
  blockById,
  blocksFromArchive,
  conflictsOf,
  createBlock,
  locateEntry,
  moveBlock,
  outsideEntries,
  parseBlocksDoc,
  previewLines,
  removeBlock,
  removeBlockEntry,
  removeOutsideLines,
  renameBlock,
  renderFile,
  renderRegion,
  restoreBlock,
  restoreBlockEntry,
  setBlockEnabled,
  spliceRegion,
  splitRegion,
  statsOf,
  stripLayerText,
  updateBlockEntry,
} from '../src/core/blocks'

/**
 * 块模型测试。两条不能破的线：
 *   1. **区外内容逐字节不动** —— 系统行、VPN 自己加的行，我们一个字节都不该改；
 *   2. **块开关可逆** —— 关掉再打开，条目与格式必须回到原样（宿主里就靠这个开关换环境）。
 */

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

/* --------------------------------------------------------------- 样本 */

const SYSTEM = `##
# Host Database
##
127.0.0.1\tlocalhost
::1             localhost
`

const VPN = `# WireGuard 启动时自己加的行
10.8.0.1\tvpn.internal.example.com
`

/** 规范形态：区外 → 空行 → 托管区（末尾无 tail） */
const CANONICAL = `${SYSTEM}
${VPN}
${REGION_BEGIN}
# @block 开发环境
10.0.0.1  dev.example.com\t# 主站
10.0.0.2\tapi.dev.example.com
# @/block
# @block 备用线路 | off
# 10.0.0.9\tbackup.example.com
# @/block
${REGION_END}
`

/** 托管区在中间：前后都有区外内容 */
const MIDDLE = `127.0.0.1\tlocalhost

${REGION_BEGIN}
# @block A
1.1.1.1\ta.example.com
# @/block
${REGION_END}

# 后面还有别的程序写的
2.2.2.2\tlater.example.com
`

console.log('解析')

test('没有托管区：整份文件都算外部内容，块列表为空', () => {
  const doc = parseBlocksDoc(SYSTEM + VPN)
  assert.equal(doc.blocks.length, 0)
  assert.equal(doc.hasRegion, false)
  assert.equal(statsOf(doc).outside, 3)
  assert.equal(renderRegion(doc), '', '没有块 ⇒ 托管区文本为空（保存时会整段消失）')
  assert.equal(renderFile(doc), SYSTEM + VPN, '不动文件')
})

test('两个块都读出来，条目字段、开关、备注都在', () => {
  const doc = parseBlocksDoc(CANONICAL)
  assert.equal(doc.blocks.length, 2)
  assert.equal(doc.blocks[0].name, '开发环境')
  assert.equal(doc.blocks[0].enabled, true)
  assert.equal(doc.blocks[1].name, '备用线路')
  assert.equal(doc.blocks[1].enabled, false, '带 | off 的块是关闭的')

  const entries = doc.blocks[0].body.lines.filter((l) => l.kind === 'entry')
  assert.equal(entries.length, 2)
  assert.equal(entries[0].ip, '10.0.0.1')
  assert.deepEqual(entries[0].names, ['dev.example.com'])
  assert.equal(entries[0].comment, '主站')
  assert.equal((entries[0] as { raw: string }).raw, '10.0.0.1  dev.example.com\t# 主站\n')

  const off = doc.blocks[1].body.lines.find((l) => l.kind === 'entry')
  assert.ok(off)
  assert.equal(off.disabled, false, '块关着，但这一行本身是启用的（再打开时不该变成禁用）')
})

test('托管区在中间时，前后两段外部内容都留着', () => {
  const doc = parseBlocksDoc(MIDDLE)
  assert.equal(doc.blocks.length, 1)
  assert.equal(renderFile(doc), MIDDLE, '规范形态下解析再渲染必须逐字节一致')
})

test('外部条目按文件顺序列出来（head 在前、tail 在后）', () => {
  const doc = parseBlocksDoc(MIDDLE)
  const list = outsideEntries(doc)
  assert.deepEqual(
    list.map((l) => l.ip),
    ['127.0.0.1', '2.2.2.2'],
  )
})

test('散在区域里、没被块包住的行不会丢（归到一个未分组的块）', () => {
  const text = `${REGION_BEGIN}\n1.1.1.1\tloose.example.com\n# @block A\n2.2.2.2\ta.example.com\n# @/block\n${REGION_END}\n`
  const doc = parseBlocksDoc(text)
  assert.equal(doc.blocks.length, 2)
  assert.equal(doc.blocks[0].name, '未分组')
  assert.equal(doc.blocks[0].body.lines.filter((l) => l.kind === 'entry').length, 1)
})

test('结束标记缺失也能读（区域一直到文件末尾）', () => {
  const text = `${REGION_BEGIN}\n# @block A\n1.1.1.1\ta.example.com\n`
  const doc = parseBlocksDoc(text)
  assert.equal(doc.blocks.length, 1)
  assert.equal(doc.tail.lines.length, 0)
})

console.log('块开关')

test('关掉块：块体整段注释，标记行带 | off', () => {
  const doc = parseBlocksDoc(CANONICAL)
  setBlockEnabled(doc, doc.blocks[0].id, false)
  const out = renderFile(doc)
  assert.ok(out.includes('# @block 开发环境 | off\n'), '标记行要写明关闭')
  assert.ok(out.includes('# 10.0.0.1  dev.example.com\t# 主站\n'), '原样注释掉（分隔符与备注都留着）')
  assert.ok(out.includes('# 10.0.0.2\tapi.dev.example.com\n'))
})

test('行级禁用叠在块级关闭上：两层注释，打开块后回到原本的禁用状态', () => {
  const text = `${REGION_BEGIN}\n# @block A\n1.1.1.1\ta.example.com\n# 2.2.2.2\tb.example.com\n# @/block\n${REGION_END}\n`
  const doc = parseBlocksDoc(text)
  assert.equal(doc.blocks[0].body.lines.filter((l) => l.kind === 'entry')[1].disabled, true)

  setBlockEnabled(doc, doc.blocks[0].id, false)
  const off = renderFile(doc)
  assert.ok(off.includes('# # 2.2.2.2\tb.example.com\n'), '本来就禁用的会叠两层')

  setBlockEnabled(doc, doc.blocks[0].id, true)
  assert.equal(renderFile(doc), text, '开回来一字不差')
})

test('关掉再打开：回到一模一样的文本', () => {
  const doc = parseBlocksDoc(CANONICAL)
  const id = doc.blocks[0].id
  setBlockEnabled(doc, id, false)
  setBlockEnabled(doc, id, true)
  assert.equal(renderFile(doc), CANONICAL)
})

test('关闭 → 解析回来 → 再渲染，文本稳定（幂等）', () => {
  const doc = parseBlocksDoc(CANONICAL)
  setBlockEnabled(doc, doc.blocks[0].id, false)
  const once = renderFile(doc)
  const again = renderFile(parseBlocksDoc(once))
  assert.equal(again, once)
  const reparsed = parseBlocksDoc(once)
  assert.equal(reparsed.blocks[0].enabled, false)
  assert.equal(reparsed.blocks[0].body.lines.filter((l) => l.kind === 'entry').length, 2)
})

test('层的加/解是一对（含空行与 CRLF）', () => {
  const text = '1.1.1.1 a\n\n# 注释\n'
  assert.equal(stripLayerText(applyLayer(text)), text)
  const crlf = '# 1.1.1.1 a\r\n\r\n'
  assert.equal(applyLayer(stripLayerText(crlf)), crlf)
})

console.log('手术式替换')

test('spliceRegion 只换托管区，区外逐字节保留', () => {
  const doc = parseBlocksDoc(CANONICAL)
  setBlockEnabled(doc, doc.blocks[1].id, true)
  const next = spliceRegion(CANONICAL, renderRegion(doc))
  assert.ok(next.startsWith(SYSTEM + '\n' + VPN), '区外原样（含各自的行尾）')
  assert.ok(next.includes('# @block 备用线路\n10.0.0.9\tbackup.example.com\n'), '第二块被打开（注释层去掉）')
  assert.ok(!next.includes('| off'))
})

test('文件里没有托管区时，区域追加到末尾并补一个空行', () => {
  const doc = parseBlocksDoc(SYSTEM)
  createBlock(doc, '新块')
  const next = spliceRegion(SYSTEM, renderRegion(doc))
  assert.ok(next.startsWith(SYSTEM), '原文一个字不动')
  assert.ok(next.endsWith(`${REGION_BEGIN}\n# @block 新块\n# @/block\n${REGION_END}\n`))
  assert.ok(next.includes('\n\n# >>> host-manager'), '与原文之间留一个空行')
})

test('移除托管区后回到「谁都没管过」的样子', () => {
  const next = spliceRegion(MIDDLE, '')
  assert.ok(!next.includes(REGION_BEGIN) && !next.includes('a.example.com'))
  assert.ok(next.includes('127.0.0.1\tlocalhost'))
  assert.ok(next.includes('2.2.2.2\tlater.example.com'))
})

test('末尾没有换行符的文件也能接上区域', () => {
  const next = spliceRegion('1.1.1.1 a.example.com', `${REGION_BEGIN}\n${REGION_END}\n`)
  assert.ok(next.startsWith('1.1.1.1 a.example.com\n'))
})

test('removeOutsideLines 只删点名的那几行，且每行最多删一次', () => {
  const text = `1.1.1.1\tdup.example.com\n2.2.2.2\tkeep.example.com\n1.1.1.1\tdup.example.com\n`
  const next = removeOutsideLines(text, ['1.1.1.1\tdup.example.com\n'])
  assert.equal(next, '2.2.2.2\tkeep.example.com\n1.1.1.1\tdup.example.com\n')
})

test('removeOutsideLines 不会碰托管区里的同名行', () => {
  const doc = parseBlocksDoc(CANONICAL)
  const next = removeOutsideLines(CANONICAL, ['10.0.0.1  dev.example.com\t# 主站\n'])
  const again = parseBlocksDoc(next)
  assert.equal(again.blocks[0].body.lines.filter((l) => l.kind === 'entry').length, 2, '块里的行不动')
  assert.equal(renderRegion(again), renderRegion(doc))
})

console.log('条目操作')

test('块内增删改：新增的是「脏行」，删了能原位撤销', () => {
  const doc = parseBlocksDoc(CANONICAL)
  const block = doc.blocks[0]
  const added = addBlockEntries(doc, block.id, [
    { ip: '10.0.0.3', names: ['x.example.com'], comment: '新增', disabled: false },
  ])
  assert.equal(added.length, 1)
  assert.ok(renderFile(doc).includes('10.0.0.3\tx.example.com\t# 新增\n'), '新增行用文件主分隔符与换行符')

  const removed = removeBlockEntry(doc, block.id, added[0].id)
  assert.ok(removed)
  assert.ok(!renderFile(doc).includes('x.example.com'))
  restoreBlockEntry(doc, removed)
  assert.ok(renderFile(doc).includes('x.example.com'))
})

test('改条目字段只影响那一行', () => {
  const doc = parseBlocksDoc(CANONICAL)
  const block = doc.blocks[0]
  const line = block.body.lines.find((l) => l.kind === 'entry')
  assert.ok(line)
  updateBlockEntry(doc, block.id, line.id, { ip: '10.9.9.9' })
  const out = renderFile(doc)
  assert.ok(out.includes('10.9.9.9  dev.example.com  # 主站\n'), '沿用原行的分隔符（重渲染时备注前也用同一个）')
  assert.ok(out.includes('10.0.0.2\tapi.dev.example.com\n'), '别的行纹丝不动')
})

test('块可以改名与上下移动，删了能原位放回', () => {
  const doc = parseBlocksDoc(CANONICAL)
  const [a, b] = doc.blocks
  renameBlock(doc, a.id, '开发环境（改）')
  assert.ok(renderRegion(doc).includes('# @block 开发环境（改）\n'))
  assert.equal(moveBlock(doc, b.id, -1), true)
  assert.deepEqual(
    doc.blocks.map((x) => x.name),
    ['备用线路', '开发环境（改）'],
  )
  assert.equal(moveBlock(doc, b.id, -1), false, '已经在最前面了')

  const removed = removeBlock(doc, a.id)
  assert.ok(removed)
  assert.equal(doc.blocks.length, 1)
  restoreBlock(doc, removed)
  assert.equal(doc.blocks.length, 2)
})

test('块名里的 | 与换行会被压掉，标记语法不会被破坏', () => {
  const doc = parseBlocksDoc(CANONICAL)
  renameBlock(doc, doc.blocks[0].id, '一个 | 两个\n三个')
  const again = parseBlocksDoc(renderFile(doc))
  assert.equal(again.blocks[0].name, '一个 两个 三个')
  assert.equal(again.blocks.length, 2)
})

console.log('区外条目')

test('收进块：区外摘掉 + 落进目标块 + 给出要删的原文', () => {
  const doc = parseBlocksDoc(CANONICAL)
  const target = outsideEntries(doc).find((l) => l.ip === '10.8.0.1')
  assert.ok(target)
  const adopted = adoptOutsideEntry(doc, target.id, { newBlockName: 'VPN 纳管' })
  assert.ok(adopted)
  assert.equal(adopted.raw, '10.8.0.1\tvpn.internal.example.com\n')

  const preview = renderFile(doc)
  assert.ok(preview.includes('# @block VPN 纳管\n10.8.0.1\tvpn.internal.example.com\n'), '落进新块')
  assert.ok(!splitRegion(preview).head.includes('10.8.0.1'), '预览里区外那条已经没了')

  // 真正写下去的内容 = 磁盘原文 + 删掉点名的行 + 换掉托管区，必须和预览一模一样
  const written = spliceRegion(removeOutsideLines(CANONICAL, [adopted.raw]), renderRegion(doc))
  assert.equal(written, preview, '「右栏预览」与「实际写入」不能有二话')
})

test('收进已有的块', () => {
  const doc = parseBlocksDoc(CANONICAL)
  const target = outsideEntries(doc)[0]
  const block = doc.blocks[1]
  const adopted = adoptOutsideEntry(doc, target.id, { blockId: block.id })
  assert.ok(adopted)
  assert.ok(blockById(doc, block.id))
  assert.equal(locateEntry(doc, adopted.entry.id)?.block.id, block.id)
})

console.log('统计与冲突')

test('统计：条目数、生效数、区外条数与认不出的行数', () => {
  const doc = parseBlocksDoc(CANONICAL)
  const stats = statsOf(doc)
  assert.equal(stats.blocks, 2)
  assert.equal(stats.entries, 3)
  assert.equal(stats.enabled, 2, '关掉的块里的条目不算生效')
  assert.equal(stats.disabled, 1)
  assert.equal(stats.outside, 3)
})

test('跨块 + 跨区外判冲突', () => {
  const text = `${REGION_BEGIN}\n# @block A\n1.1.1.1\tsame.example.com\n# @/block\n${REGION_END}\n2.2.2.2\tsame.example.com\n`
  const doc = parseBlocksDoc(text)
  const ids = conflictsOf(doc)
  assert.equal(ids.size, 2, '块里那条与区外那条都该被标出来')
})

test('关掉的块不参与冲突判定', () => {
  const text = `${REGION_BEGIN}\n# @block A | off\n# 1.1.1.1\tsame.example.com\n# @/block\n${REGION_END}\n2.2.2.2\tsame.example.com\n`
  assert.equal(conflictsOf(parseBlocksDoc(text)).size, 0)
})

console.log('预览')

test('预览行与最终文本一一对应（同一个游程）', () => {
  const doc = parseBlocksDoc(MIDDLE)
  setBlockEnabled(doc, doc.blocks[0].id, false)
  const joined = previewLines(doc)
    .map((l) => l.text + l.nl)
    .join('')
  assert.equal(joined, renderFile(doc))
  const rows = previewLines(doc)
  assert.equal(rows.filter((l) => l.kind === 'block-head').length, 1)
  // 区域开始 / 块结束 / 区域结束
  assert.equal(rows.filter((l) => l.kind === 'marker').length, 3)
  assert.ok(rows.some((l) => l.blockId === doc.blocks[0].id && l.disabled), '关掉的块里的行标成不生效')
})

console.log('存档还原')

test('新存档（托管区文本）直接还原成块', () => {
  const doc = parseBlocksDoc(CANONICAL)
  const blocks = blocksFromArchive(renderRegion(doc), doc.eol, doc.sep, '存档')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1].name, '备用线路')
  assert.equal(blocks[1].enabled, false)
})

test('块功能之前的老存档（整份文件）整包收成一个块，一条不丢', () => {
  const doc = parseBlocksDoc('')
  const blocks = blocksFromArchive(SYSTEM + VPN, doc.eol, doc.sep, '存档 · 2026')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].name, '存档 · 2026')
  assert.equal(blocks[0].body.lines.filter((l) => l.kind === 'entry').length, 3)
})

console.log('性能')

test('两万行托管区解析 + 渲染保持线性（< 800ms）', () => {
  const rows = Array.from({ length: 20000 }, (_, i) => `10.0.${(i / 256) | 0}.${i % 256}\thost-${i}.example.com`)
  const text = `${REGION_BEGIN}\n# @block 大块\n${rows.join('\n')}\n# @/block\n${REGION_END}\n`
  const t0 = performance.now()
  const doc = parseBlocksDoc(text)
  const out = renderFile(doc)
  const dt = performance.now() - t0
  console.log(`    2 万行解析 + 渲染耗时 ${dt.toFixed(1)}ms`)
  assert.equal(statsOf(doc).entries, 20000)
  assert.equal(out, text, '规范形态下逐字节还原')
  assert.ok(dt < 800, `耗时 ${dt.toFixed(0)}ms`)
})

console.log(`\n通过 ${passed} 项`)
