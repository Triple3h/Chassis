import assert from 'node:assert/strict'
import {
  applyContent,
  countChars,
  createNote,
  exportHtml,
  filterNotes,
  noteFileName,
  noteSummary,
  noteTitle,
  relativeTime,
  renameNote,
  sortNotes,
} from '../src/core/notes'
import type { Note } from '../src/core/notes'

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

console.log('标题与摘要')

test('标题优先取首个 # 标题', () => {
  assert.equal(noteTitle('# 会议纪要\n正文'), '会议纪要')
  assert.equal(noteTitle('没有标题\n第二行'), '没有标题')
  assert.equal(noteTitle('   \n\n'), '未命名笔记')
})

test('超长标题截断', () => {
  const title = noteTitle(`# ${'长'.repeat(50)}`)
  assert.equal(title.length, 40)
  assert.ok(title.endsWith('…'))
})

test('摘要取前两行', () => {
  assert.equal(noteSummary('# 标题\n第一行\n第二行\n第三行'), '标题 · 第一行')
})

console.log('增删改')

test('createNote 生成默认字段', () => {
  const note = createNote(1000, '# 待办清单')
  assert.equal(note.title, '待办清单')
  assert.equal(note.createdAt, 1000)
  assert.equal(note.pinned, false)
})

test('改内容会同步标题与更新时间', () => {
  const note = createNote(1000, '# 旧标题')
  const next = applyContent(note, '# 新标题\n内容', 2000)
  assert.equal(next.title, '新标题')
  assert.equal(next.updatedAt, 2000)
})

test('改标题不动内容', () => {
  const note = createNote(1000, '正文')
  const next = renameNote(note, '手改的标题', 1500)
  assert.equal(next.title, '手改的标题')
  assert.equal(next.content, '正文')
  assert.equal(renameNote(next, '   ', 1600).title, '手改的标题', '空标题不该把名字抹掉')
})

console.log('排序与过滤')

const pool: Note[] = [
  { id: '1', title: '会议纪要', content: '讨论了启动台', createdAt: 1, updatedAt: 100, pinned: false },
  { id: '2', title: '读书笔记', content: 'markdown 排版', createdAt: 1, updatedAt: 300, pinned: false },
  { id: '3', title: '置顶的', content: '先看我', createdAt: 1, updatedAt: 200, pinned: true },
]

test('置顶优先，其余按最近改动', () => {
  assert.deepEqual(sortNotes(pool).map((n) => n.id), ['3', '2', '1'])
})

test('搜索命中标题与正文', () => {
  assert.deepEqual(filterNotes(pool, 'markdown').map((n) => n.id), ['2'])
  assert.deepEqual(filterNotes(pool, '纪要').map((n) => n.id), ['1'])
  assert.deepEqual(filterNotes(pool, '').map((n) => n.id), ['3', '2', '1'])
})

console.log('统计与导出')

test('中英混排的字数', () => {
  const stats = countChars('# 标题\nhello world 你好')
  assert.equal(stats.words, 2 + 2 + 2, '中文字 + 英文词')
  assert.equal(stats.lines, 2)
  assert.ok(stats.chars > 10)
})

test('导出 HTML 内联样式且转义标题', () => {
  const html = exportHtml({ ...createNote(1, '**粗体**'), title: '<标题>' })
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('<strong>粗体</strong>'))
  assert.ok(html.includes('&lt;标题&gt;'))
})

test('文件名洗掉路径分隔符', () => {
  assert.equal(noteFileName({ ...createNote(1), title: 'a/b:c' }, 'md'), 'a_b_c.md')
  assert.equal(noteFileName({ ...createNote(1), title: '  ' }, 'html'), '未命名笔记.html')
})

test('相对时间', () => {
  const now = new Date('2026-09-17T15:04:00').getTime()
  assert.equal(relativeTime(now - 20_000, now), '刚刚')
  assert.equal(relativeTime(new Date('2026-09-17T09:00:00').getTime(), now), '今天 09:00')
  assert.equal(relativeTime(new Date('2026-09-16T09:00:00').getTime(), now), '昨天 09:00')
})

console.log(`\n通过 ${passed} 项`)
