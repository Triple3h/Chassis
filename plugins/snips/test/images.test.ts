import assert from 'node:assert/strict'
import { dataUrlToBlob, imageFileName, imageTooLarge, isImageDataUrl } from '../src/core/images'
import { IMAGE_MAX_CHARS } from '../src/core/types'

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

console.log('data URL → Blob')

test('base64 PNG 还原出正确字节', () => {
  // 1x1 透明 PNG
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  const blob = dataUrlToBlob(png)
  assert.ok(blob)
  assert.equal(blob?.type, 'image/png')
  assert.ok((blob?.size ?? 0) > 60, `解出来的字节数应该接近 68，实际 ${blob?.size}`)
  assert.ok((blob?.size ?? 0) < 100)
})

test('URL 编码的非 base64 data URL 也能解析', () => {
  const blob = dataUrlToBlob('data:text/plain,%E4%BD%A0%E5%A5%BD')
  assert.equal(blob?.type, 'text/plain')
})

test('形状不对返回 null', () => {
  assert.equal(dataUrlToBlob('https://example.com/a.png'), null)
  assert.equal(dataUrlToBlob('data:image/png;base64,%%%'), null)
})

console.log('校验与命名')

test('isImageDataUrl 只认图片', () => {
  assert.equal(isImageDataUrl('data:image/png;base64,AAA'), true)
  assert.equal(isImageDataUrl('data:text/plain;base64,AAA'), false)
})

test('体积上限', () => {
  assert.equal(imageTooLarge('x'.repeat(IMAGE_MAX_CHARS)), false)
  assert.equal(imageTooLarge('x'.repeat(IMAGE_MAX_CHARS + 1)), true)
})

test('文件名带扩展名并洗掉非法字符', () => {
  assert.equal(imageFileName('截图 1/2', 'data:image/jpeg;base64,AA'), '截图 1_2.jpg')
  assert.equal(imageFileName('', 'data:image/png;base64,AA'), '快贴图片.png')
  assert.equal(imageFileName('标题', 'data:image/png;base64,AA', '1758000000000'), '标题-1758000000000.png')
})

console.log(`\n通过 ${passed} 项`)
