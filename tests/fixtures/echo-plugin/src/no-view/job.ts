/** no-view 契约：执行 = 拉起同名脚本产物（worker_threads） */
import { ctx, done, log, onError, progress, storage } from '@launcher/api-node'

onError()
const { command, args, dataPath, pluginPath, mode } = ctx()

log('job 开始', { command, dataPath, mode }, 'info')
progress(0.5, { step: 'halfway' })

const runs = ((await storage.get<number>('runs')) ?? 0) + 1
await storage.set('runs', runs)

done({
  command,
  args,
  mode,
  runs,
  dataPathEndsWith: dataPath.endsWith('echo-plugin'),
  pluginPathIsReadOnlySource: pluginPath.length > 0,
})
