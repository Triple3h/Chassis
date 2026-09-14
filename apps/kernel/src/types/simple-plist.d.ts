/**
 * simple-plist 无官方类型声明（registry 上没有 @types/simple-plist）。
 * 这里只声明我们实际用到的 API 面。
 */
declare module 'simple-plist' {
  export function readFile(
    file: string,
    callback: (err: Error | null, result?: Record<string, unknown>) => void,
  ): void
  export function readFileSync(file: string): Record<string, unknown>
  export function parse(
    content: string | Buffer,
    callback: (err: Error | null, result?: Record<string, unknown>) => void,
  ): void
  export function writeFile(
    file: string,
    data: Record<string, unknown>,
    callback: (err: Error | null) => void,
  ): void
  const plist: {
    readFile: typeof readFile
    readFileSync: typeof readFileSync
    parse: typeof parse
    writeFile: typeof writeFile
  }
  export default plist
}
