/**
 * 并发控制（移植自 ZTools `core/commandScanner/utils.ts`，MIT，见 docs/THIRD-PARTY.md）。
 * 注意：返回顺序不保证与输入一致，调用方需要保序时自行按下标回填。
 */
export async function pLimit<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = []
  const executing: Promise<void>[] = []

  for (const task of tasks) {
    const promise = task().then((result) => {
      results.push(result)
      const idx = executing.indexOf(promise)
      if (idx >= 0) executing.splice(idx, 1)
    })
    executing.push(promise)
    if (executing.length >= concurrency) await Promise.race(executing)
  }

  await Promise.all(executing)
  return results
}

/** 保序版：按输入下标回填结果（扫描应用时用来保持稳定顺序） */
export async function pMapOrdered<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  await pLimit(
    items.map((item, index) => async () => {
      out[index] = await mapper(item, index)
    }),
    concurrency,
  )
  return out
}
