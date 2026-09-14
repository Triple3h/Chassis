/** 清单/产物层的错误码（plugin-spec §14）。运行时错误码见 §7.3。 */
export type ManifestErrorCode =
  | 'MANIFEST_INVALID'
  | 'API_VERSION_UNSUPPORTED'
  | 'CAPABILITY_UNKNOWN'
  | 'ENTRY_MISSING'
  | 'PLUGIN_ID_CONFLICT'

/** 运行时错误码（plugin-spec §7.3） */
export type RuntimeErrorCode =
  | 'CAPABILITY_DENIED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'BAD_ARGS'
  | 'BUSY'
  | 'INTERNAL'
  | 'SCRIPT_ERROR'
  | 'CONTRACT_VIOLATION'
  | 'SESSION_INVALID'
  | 'FORBIDDEN'

export type LauncherErrorCode = ManifestErrorCode | RuntimeErrorCode

export class LauncherError extends Error {
  readonly code: LauncherErrorCode
  readonly detail?: unknown

  constructor(code: LauncherErrorCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'LauncherError'
    this.code = code
    this.detail = detail
  }

  toJSON(): { code: LauncherErrorCode; message: string } {
    return { code: this.code, message: this.message }
  }
}

export interface ErrorShape {
  code: LauncherErrorCode
  message: string
}

/** 把任意抛出物转成 { code, message }（永不抛出） */
export function toErrorShape(err: unknown, fallback: RuntimeErrorCode = 'INTERNAL'): ErrorShape {
  if (err instanceof LauncherError) return { code: err.code, message: err.message }
  if (err instanceof Error) return { code: fallback, message: err.message || String(err) }
  return { code: fallback, message: String(err) }
}
