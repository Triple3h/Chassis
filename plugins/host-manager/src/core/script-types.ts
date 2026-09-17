/**
 * script 命令的入参 / 返回值契约。UI 与 Node 两侧共用，改一处两边都会报类型错。
 * 对应 src/no-view/hosts-read.ts 与 hosts-write.ts。
 */

export interface BackupInfo {
  name: string
  size: number
  mtime: number
}

export interface HostsReadArgs {
  /** 附带磁盘备份列表 */
  backups?: boolean
  /** 读取指定备份文件的内容（填了就不读系统 hosts） */
  backup?: string
}

export interface HostsReadResult {
  ok: boolean
  /** 系统 hosts 的绝对路径 */
  path: string
  content: string
  size: number
  mtime: number
  /** 文件开头是否带 BOM（写回时要保持原样） */
  bom: boolean
  /** binary 表示文件不是合法 UTF-8，内容按字节直译，中文注释会显示异常 */
  encoding: 'utf8' | 'binary'
  /** 当前进程有没有直接写权限；false 表示保存时需要提权 */
  writable: boolean
  platform: string
  backups?: BackupInfo[]
  error?: string
}

export type WriteMode = 'auto' | 'direct' | 'privileged'

export interface HostsWriteArgs {
  /**
   * 本插件要写进去的**托管区**文本（含 `# >>> host-manager >>>` / `# <<< host-manager <<<` 两个标记）。
   * 空串 = 把托管区从文件里摘掉。
   *
   * 为什么不是整份文件内容：区外那些行（系统行、VPN 启动时自己加的）不归我们管。
   * 写的一刻由 script 侧重新读一遍文件、只把标记之间的那一段换掉 ——
   * 加载页面之后、点保存之前别的程序加的行，一条都不会被覆盖。
   */
  region: string
  /**
   * 顺带从**托管区之外**删掉的行（逐字匹配的原文，每行最多删一次）。
   * 只用于「区外条目收进块」：那条记录已经被搬进托管区了，外面这份要去掉，否则会重复。
   * 对不上的行静默跳过 —— 宁可留下，也不误删别的程序写的东西。
   */
  remove?: string[]
  /** auto（默认）：先直写，权限不足再提权；direct：只直写；privileged：直接提权 */
  mode?: WriteMode
  /** 写入前是否备份，默认 true */
  backup?: boolean
}

export interface HostsWriteResult {
    ok: boolean
    /**
     * direct      —— 进程本身有写权限，直接写成功
     * privileged  —— 走了系统提权（macOS 弹管理员授权）
     * manual      —— 提权不可用，已把待写入内容落盘，需要用户手工执行命令
     * none        —— 什么都没做（没有改动，或校验不通过）
     */
    method: 'direct' | 'privileged' | 'manual' | 'none'
    path: string
    /** 文件内容是否真的变了；false 表示托管区与磁盘上的一致，没写也没备份 */
    changed?: boolean
    /** 备份文件名与完整路径 */
    backup?: string
    backupPath?: string
    /** manual 时的待生效文件路径与建议命令 */
    pendingPath?: string
    command?: string
    /** 写完回读是否与目标内容逐字节一致 */
    verified?: boolean
    error?: string
}

/**
 * `hosts-permission`（script）：免授权写入的开关。
 *
 * 系统 hosts 属 root，默认每写一次弹一次授权框。这里做的是「一次性授权」：
 * 把文件的写权限授给当前账户（macOS/Linux = POSIX ACL `chmod +a`），
 * 之后保存就直接写、不再弹窗；随时可撤销。uTools / SwitchHosts 引导用户
 * 手动做的也是这件事（Windows 上是文件属性里勾「写入」）。
 */
export type PermissionAction = 'status' | 'grant' | 'revoke'

export interface HostsPermissionArgs {
  /** 缺省 = status（只查询，不动权限） */
  action?: PermissionAction
}

export interface HostsPermissionResult {
  ok: boolean
  action: PermissionAction
  /** ACL 里有没有本插件加的那条（可能为 true 而 writable 仍为 false，反之亦然） */
  granted: boolean
  /** 当前进程能不能直接写目标文件（access W_OK） */
  writable: boolean
  path: string
  platform: string
  username?: string
  /**
   * none       —— 只查询，没动权限
   * direct     —— 目标状态已经达成，没有提权（不弹框）
   * privileged —— 真的走了系统授权框
   */
  method: 'none' | 'direct' | 'privileged'
  /** 展示用的等价命令（想手工做的话就是这条） */
  command?: string
  error?: string
}
