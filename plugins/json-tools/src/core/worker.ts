/// <reference lib="webworker" />
import { formatJson, type FormatOptions, type FormatResult } from './format'
import { buildTree, type BuildTreeOptions, type FlatTree } from './tree'
import type { JsonIssue } from './format'

export interface TreeRequest extends BuildTreeOptions {
  text: string
}

export type WorkerRequest =
  | { id: number; op: 'format'; text: string; options: FormatOptions }
  | { id: number; op: 'tree'; text: string; options: BuildTreeOptions }

export type WorkerResponse =
  | { id: number; op: 'format'; result: FormatResult }
  | { id: number; op: 'tree'; tree?: FlatTree; issue?: JsonIssue }

interface Scope {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage: (data: unknown) => void
}

const scope = self as unknown as Scope

scope.onmessage = (e: MessageEvent) => {
  const req = e.data as WorkerRequest
  try {
    if (req.op === 'format') {
      scope.postMessage({ id: req.id, op: 'format', result: formatJson(req.text, req.options) })
    } else {
      const tree = buildTree(req.text, req.options)
      scope.postMessage({ id: req.id, op: 'tree', tree })
    }
  } catch (err) {
    const issue: JsonIssue = {
      message: err instanceof Error ? err.message : String(err),
      index: 0,
      line: 1,
      column: 1,
      snippet: '',
    }
    if (req.op === 'format') {
      scope.postMessage({
        id: req.id,
        op: 'format',
        result: { ok: false, output: '', issue, stats: { inChars: req.text.length, outBytes: 0, outLines: 0, nodes: 0, depth: 0 } },
      })
    } else {
      scope.postMessage({ id: req.id, op: 'tree', issue })
    }
  }
}
