/** 重建应用索引（no-view 命令：用户主动触发的后台任务） */
import { ctx, done, fail, log, onError, progress } from '@launcher/api-node'
import { scanApplications } from '../core/scanner'
import { saveIndex } from '../core/store'
import { indexAgeDays } from '../core/store'

onError()
const { dataPath } = ctx()

try {
  if (process.platform !== 'darwin') {
    done({ ok: false, reason: '仅支持 macOS' })
  } else {
    const before = await indexAgeDays()
    progress(0.1, { step: 'scan' })
    const result = await scanApplications()
    progress(0.75, { step: 'save', apps: result.apps.length })
    await saveIndex(result.apps)
    log(`索引已重建：${result.apps.length} 个应用`, { durationMs: result.durationMs }, 'info')
    done({
      ok: true,
      apps: result.apps.length,
      durationMs: result.durationMs,
      previousIndexAgeDays: before,
      dirs: result.scannedDirs,
      dataPath,
    })
  }
} catch (err) {
  fail(err)
}
