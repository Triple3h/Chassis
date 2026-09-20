# Windows 热更新调研（Shell / Kernel / Plugin）

> 状态：**调研清单**（2026-09-20 起草，未开工）｜范围：**用户态三层**（OS 内核 / 驱动见 §0 末条，不在范围）
> 关联：`docs/kernel-hot-update.md`（内核更新机制；§11 的 Windows 边界正是本文要回答的问题）｜`docs/shell-hot-update.md`（壳更新机制）｜`docs/plugin-spec.md` §6.4（插件更新机制）｜`docs/launcher-requirements.md`（M6 Windows 口径）
> 用法：`- [ ]` = 待办，做完勾掉；§3 的「实测」列直接填结论。结论落地后，**行为口径进上面三份文档**，本文作过程材料归档。

## 0. 范围与口径

| 对象 | 实体 | Windows 现状 |
|---|---|---|
| Shell | Tauri 应用本体（`Chassis.exe`） | 绿色版 zip 进更新源 + **自动安装已实现**（2026-09-20：`swap.ps1` 在壳退出后换目录）|
| Kernel | `launcher-kernel.exe`（普通用户态进程） | 打包版外置到 `<dataRoot>/kernel/`；二进制热替换**明确跳过** |
| Plugin | 插件目录（`index.html` + `dist/<name>.exe`） | 机制与 macOS 共用，但**从未在 Windows 真机验证**更新路径 |

- 「热更新」的验收口径：**用户显式确认才更新** / 失败可回滚 / 用户数据（`%APPDATA%\Chassis`）零丢失 / 全程有日志（失败能定位到具体一步）。
- 单层 Go/No-Go：**Shell** = 换包后新版本可用且托盘 / 热键 / 单实例正常；**Kernel** = 进程自动拉起、UI 自动导航到新端口、连续 2 次启动失败自动回滚；**Plugin** = 换版后用户数据保留、旧版可回退、正在跑的进程先退干净。
- 否决线：任何一步需要用户手动删文件 / 重启电脑才能收敛 ⇒ 该方案 No-Go（`MOVEFILE_DELAY_UNTIL_REBOOT` 只作壳本体的最后兜底，不算热更新）。
- **OS 内核 / 驱动热更新不在范围**：本体不加载驱动、不注册 Windows 服务，全是用户态 API（UIA / PSAPI / Toolhelp / icacls）。
  旁注：该线本身也不可行 —— PatchGuard + DSE + HVCI 封死第三方内核态补丁，Windows hotpatch 是微软自家通道（Win11 企业版 24H2 + VBS/Intune）。
  将来若需常驻系统级组件，那是 **Windows 服务**（仍不是驱动），届时另立项。

## 1. 预判结论（待 §3 实验校正）

| 层 | 预判 | 卡点 | 量级 |
|---|---|---|---|
| Plugin | ✅ 可行（最容易） | 正在运行的插件 exe / WebView2 缓存锁住插件目录；杀软瞬时锁；孙进程握锁 | 实测 + 小改（退避、进程树收口） |
| Kernel | ✅ 可行 | 替换动作不能在内核自己进程里做（写不了运行中的自己）⇒ 移到壳；回滚写法（`restore()` 删自身）在 Windows 必失败 | 壳侧一段替换逻辑 + 回滚改路 + 契约测试 |
| Shell | ✅ 可行但最重 | 改的是应用本体：单实例让位、helper 自身不能被锁、签名 / SmartScreen、安装位置可写性 | helper 路线为主；NSIS 另算 |
| OS 内核/驱动 | ❌ 不可行（且不在范围） | PatchGuard / DSE / HVCI；微软 hotpatch 不对第三方开放 | 0（排除） |

- **置信度前提**：三层结论都压在 §3 那张文件锁表上。若「同卷 rename 运行中 exe」实测也不允许，
  Kernel / Plugin 退化为「先退进程再替换」——结论仍是可行，只是回滚窗口更窄、必须由壳或守护方代做。
- 建议顺序：**先插件**（成本最低、最快拿到真机数据）→ 用同一套替换原语做内核 → 壳放最后（或维持「提示 + 手动换包」）。
- 跨平台影响面（哪些改动会碰到 macOS 共享路径）与优雅实现方向见 §5。

## 2. 现状盘点（调研起点）

| 位置 | 事实 |
|---|---|
| `apps/kernel/src/hot/binary.rs` | `stage` / `probe`（`--hot-probe`）/ `apply_to` / `restore` / `boot_guard` / `mark_boot_success` / `status_payload`；`status_payload.supported` **不含 windows**；`restore()` = 删目标 + rename 备份回 |
| `apps/kernel/src/hot/mod.rs` | generation 状态机 + 分发层（跨平台，与 OS 无关） |
| `apps/shell/src/sidecar.rs` + `lib.rs` | 壳 = 内核父进程：`supervise` 重启预算、`kernel/restarting` 记为计划内重启、`wait_ready` + 重新导航窗口；打包版内核外置到 `<dataRoot>/kernel/` |
| `apps/shell/src/update.rs` | `can_self_update()` 非 macOS 恒 `false`；helper = `<dataRoot>/hot/shell/swap.sh`（macOS only） |
| `apps/kernel/src/plugin/manager.rs` | `install_prepared` = disable(Reload) → `move_to_backup`（rename）→ `rename_with_retry(staging → target)` → scan + load → 失败 `move_to_failed` + `restore_backup` |
| `apps/kernel/src/exec.rs` | `terminate()` = `start_kill` + `wait`（插件子进程回收） |
| `scripts/pack-win.mjs` | 绿色版产物 = `Chassis.exe` + `resources/{kernel,ui,builtin-plugins}`；解压即用，无安装器 |
| `.github/workflows/build-windows.yml` | Windows CI 只跑 `cargo test --workspace` + 打包；TS 侧测试仍只在 Linux（文件内 TODO） |
| 依赖约定 | Windows 原生 API 统一走 `windows` crate **0.61**（与 tauri 依赖树对齐，避免两份编译）；新增能力按需加 feature |

## 3. P0：文件锁基线实验（先做，其它结论都依赖它）

**探针要求**：单 exe 双模式（父进程 → 拉起自身 `--child` 并互测），每项独立、输出 JSON；每项跑 3 次、Defender 开 / 关各一轮；VM 快照。

| # | 实验（对**正在运行**的 exe） | 预期 | 实测 |
|---|---|---|---|
| E1 | 覆盖写自身（`CreateFile` 写 / `fs::copy` 到它） | 失败（共享冲突） | 待测 |
| E2 | 同卷 rename 自身 → 新名字 | 大概率成功 | 待测 |
| E3 | 删除自身 | 失败 / 延迟删除 | 待测 |
| E4 | rename 自身**所在目录** | 不确定（关键，决定 `install_prepared` 是否等价） | 待测 |
| E5 | rename / 删除目录内**未被加载**的文件 | 一般成功 | 待测 |
| E6 | 刚写入的文件立刻 rename / 删除（杀软实时扫描） | 偶发失败，时长不可控 | 待测 |
| E7 | 跨卷 rename（staging 与目标不同盘） | 非原子 / 可能直接失败 | 待测 |
| E8 | 有子进程仍在运行（插件 spawn 的孙进程）时换其 exe | 失败（句柄未释放） | 待测 |

- [ ] 探针写完并在 Win11 x64 快照上跑完 E1–E8
- [ ] 把「实测」列填掉，并据此修正 §1 置信度与 §4 的实现选择

## 4. 三层方案与改动点

### 4.1 Plugin（先做）

- 机制已具备：`install_prepared`（staging → 备份 → 原子 rename → load → 回滚）与 `.backup` / `.failed` 台账都跨平台。
- [ ] Windows 真机跑通三条路径：覆盖更新 / 首次安装 / 卸载重装；确认 `.backup` 与 `extensions/` **同卷**（rename 才原子）
- [ ] 确认 `disable` 后**整棵进程树**退出（孙进程握锁 ⇒ 评估 Job Object：`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，`windows` feature `Win32_System_JobObjects`）
- [x] `rename_with_retry` 升级为退避重试 + **只重试瞬时错误**（**已落地 2026-09-20**：策略与判定收口在 `util::fsx` 的
      `RetryPolicy` / `is_transient` / `retry(_async)`，`plugin/manager.rs` 与 `hot/binary.rs` 两个调用点共用；
      E6（杀软锁）真机仍待验）
- [ ] 插件页 iframe 正打开时换插件目录（WebView2 缓存句柄，依赖 E4/E5）
- [ ] 回滚路径复测：新版 load 失败 → `move_to_failed` + `restore_backup` → `plugin/reloaded` 广播

### 4.2 Kernel（方案 A：把替换动作移进壳的重启窗口）

内核本来就「优雅退出 → 壳拉起」，所以 Windows 上不需要热替换运行中的 exe，只差**替换的执行者**：

```
内核 stage + probe（已有）→ 写 pending（已有）→ 通知壳 kernel/restarting（已有）
→ 内核退出 → 【新增】壳在拉起前完成替换 → 拉起新内核 → 就绪即确认（已有）
```

- [x] **仅 Windows**：`binary apply` 改为「登记待替换 + 通知壳」，不再在自身进程里写目标
      （**已落地 2026-09-20**：`hot::binary::plan_shell_swap` + `swap_owner_for`；macOS 默认路径一字未动，见 §5.4 不变量 1）
- [x] 回滚改路：`restore()` 删不掉运行中的自己 ⇒ 选 **② 由壳代做**
      （**已落地**：连续两次启动未就绪时守卫只登记 `revert`，壳在下次启动前换回）
- [x] 保留 `boot_guard` 的「连续 2 次启动未就绪 ⇒ 回滚」语义（attempts 记账跨平台未变）
- [x] UI 同包：台账带 `uiStaged/uiTarget/uiBackup`，壳换核时一起换（失败整体退回，不留半替换）
- [x] 壳侧防护：替换失败 ⇒ 保持旧版本可拉起 + 清台账 + 写回执（`swap-result.json`，内核启动时记进热日志）
- [x] 打开 `status_payload.supported` 的 windows 分支，并新增 `swapOwner` 字段（§5.3-4 状态外化）

### 4.3 Shell（三选一，倾向 A）

> **方案 A 已落地（2026-09-20）**：产物进更新源（`app-release.yml` 的 `windows` job + `pack-app.mjs --platform windows`）
> + `apps/shell/src/update.rs` 的 `InstallKind`（`MacBundle` / `WindowsDir`）+ `swap.ps1` helper
> （等进程退出 → 整目录 rename → 重启；回滚三重保险与 macOS 完全共用）。
> 仍未做：B（NSIS / MSIX 安装器，装到 `Program Files` 才需要）与 Windows 真机验证。

- [ ] **A. helper 路线**（绿色版，对齐 macOS `swap.sh` 思路）：
  - candidate 解压到 `<dataRoot>/hot/shell/` → 写台账 → helper（复制到临时目录的 exe 或 `.cmd`）等壳退出 → 替换 `Chassis.exe` + `resources/` → 失败回滚 → 重启
  - [ ] 替换动作 = rename 旧 → rename 新（依赖 E4）
  - [ ] 单实例互斥让位（旧实例退干净、新实例才允许起）
  - [ ] 可写性探测（对标 macOS `is_writable`；解压到 Program Files / 受控文件夹 ⇒ 降级为「提示手动更新」）
  - [ ] helper 自锁与 DLL 劫持防护（固定目录 + 全路径 + 精简环境）
  - [ ] 重启后托盘 / 热键 / 窗口导航重建
- [ ] **B. NSIS 安装器**：`cargo tauri build --bundles nsis`（需 tauri-cli）；UAC、SmartScreen 签名要求更高。当前仓库**无任何 NSIS 产物 / 脚本**，属纯新增
- [ ] **C. 维持手动换包**（零成本，兜底；现状即 C）

## 5. 跨平台影响与实现约束（macOS 不变量）

> 结论：§4 的 9 项改动里只有 3 项落在 macOS 共享路径上，其余为 Windows 独占。
> 守住 §5.4 的三条不变量 + §5.3-2（壳侧替换台账驱动），**macOS 兼容性与功能表现零变化**。

### 5.1 逐项影响面

| # | 改动（§4） | 落点（共享 / 独占） | 对 macOS 的影响 | 判定 |
|---|---|---|---|---|
| 1 | 插件 `rename_with_retry` 改更长退避 | `plugin/manager.rs`（**共享**，3 个调用点：落地 / 备份 / 回滚） | 成功路径不变；失败路径 0.5s → 2–3s；且现在对永久错误（`EXDEV` / `EPERM`）也白等 | ✅ **已落地**（2026-09-20）：只重试瞬时错误 ⇒ macOS 连失败延迟都更短（永久错误立即返回） |
| 2 | 插件进程 Job Object 收口 | `exec.rs` 唯一 spawn 点（`kill_on_drop(true)`）（独占） | 无（`cfg(windows)` + unix 空实现）；注意 `kill_on_drop` 只回收直接子进程 | 安全 |
| 3 | 内核 `apply` 改为「登记 + 通知壳」 | `hot/binary.rs::apply_to`（**共享**） | ⚠️ **最大回归风险**：做成默认路径 ⇒ macOS 不再自己换核、热更新静默失效；pending 照写 ⇒ 守卫两次启动后「回滚到同版本」 | ✅ **已落地**（2026-09-20）：按**壳自报能力**分流（`swap_owner_for`），macOS 默认路径一字未动 |
| 4 | `restore()` 改 rename 互换 | `hot/binary.rs::restore`（**共享**） | unix rename 本就原子替换（现有先 `remove_file` 多余）；需防 `.old` 残留与失败语义变化 | ✅ **已落地**（2026-09-20）：不改 unix 分支，回滚改由壳执行（`revert` 登记） |
| 5 | `status_payload.supported` 打开 windows | `hot/binary.rs` | 零影响（macOS 已是 true） | ✅ **已落地**（2026-09-20）：顺带外化 `swapOwner` |
| 6 | 壳在重启窗口替换内核 | `apps/shell/src/sidecar.rs`（新增） | 台账驱动 ⇒ macOS 天然不触发；写成 `#[cfg(windows)]` ⇒ 该路径在 macOS 永远测不到 | ✅ **已落地**（2026-09-20）：`apps/shell/src/kernel_swap.rs`，台账驱动 + 7 条单测（macOS 上跑） |
| 7 | `can_self_update()` 加 Windows 分支 | `apps/shell/src/update.rs` | macOS 分支（bundle + 可写性）一字不动 | 安全 |
| 8 | `PendingUpdate` / 新台账字段 | `hot/binary.rs`（共享） | 新字段必须 `#[serde(default)]`：旧内核读到新台账会按「损坏」丢弃并回滚 | ✅ **已落地**（2026-09-20）：新字段全部 `#[serde(default)]`，壳侧解析器全字段容错 |
| 9 | UI / 契约 | `apps/launcher-ui` | 只读 `/api/hot/status`，加字段向后兼容；**不给 UI 加平台分支** | 安全 |

### 5.2 具体平台差异（实现时必须分开处理）

| 维度 | macOS | Windows |
|---|---|---|
| 文件替换 | rename 原子替换已存在目标（同卷，含被占用目录） | 可覆盖普通文件，**不能覆盖运行中的映像**；删除同样失败 / 延迟 |
| 进程终止 | 信号 + 进程组，可整组收 | `TerminateProcess` 只管直接子进程 ⇒ 孙进程握锁；**Job Object 是唯一正解** |
| 权限位 | `set_executable` 0755（已有 `#[cfg(unix)]`） | 无权限位概念（现状已对） |
| 代码签名 | `.app` 内换核让签名失效 ⇒ `SIGNED_BUNDLE` 拒绝，**不放开** | 外置内核无签名约束；将来壳 helper 才需要 Authenticode |
| 时机顺序 | **先换后重启**（内核自己换完再退出） | **先退、后换、再拉起**（顺序颠倒会连带 pending 写入时机与守卫判定一起错） |
| 数据目录 | `~/Library/Application Support/Chassis` | `%APPDATA%\Chassis`（两边都走 `data_root`，不硬编码） |

### 5.3 优雅实现方向（四个收口）

1. **一处收口 + `imp` 分模块**：沿用仓库 house pattern（`primitives/selection.rs` / `usage.rs` / `opener.rs` 的 `#[cfg(target_os = "macos")] mod imp`）。新增两个收口 —— `fsx::replace_file(from, to)` 与 `proc::adopt(child)`；**调用点不写 `#[cfg]`**，平台差异只活在实现里。
2. **跨进程协作数据化，不条件编译**：壳 ↔ 内核的「谁在重启间隙换核」用台账（`pending-swap.json`）表达。macOS 上可单测 / 契约测试主动构造该台账，验证壳的换核与回滚路径；Windows 真机只是换个生产者。
3. **策略参数化 + 只重试瞬时错误**（✅ 已落地 2026-09-20）：`RetryPolicy { backoff_ms: &[u64] }`（显式退避表，
   长度 = 可重试次数）逻辑一份、常量按平台取（`RENAME_POLICY`：Windows `100/200/400/800/800` ≈ 2.3s，unix `50/100` = 150ms）；
   `is_transient` 只认瞬时占用（Windows 共享 / 锁冲突与 `PermissionDenied`，unix `EBUSY` / `ETXTBSY`），
   `EXDEV`、`NotFound`、unix `EACCES` 等永久错误立即返回 —— 顺带消掉 macOS 上「白等」。
4. **状态外化，调用方不判平台**：`hot/status` 增加 `swapOwner`（`kernel` / `shell`）等字段；UI 与测试只读状态，不做平台判断。

### 5.4 macOS 不变量与回归守护

三条不能退步的不变量：

1. 内核换核仍由**内核自己**完成（defer 不是默认路径）；
2. `.app` 内仍拒绝（`SIGNED_BUNDLE` 不放开）；
3. 「连续 2 次启动未就绪 ⇒ 自动回滚」的语义与字段不变。

- [ ] 现有回归基线：`cargo test --workspace` 的 `hot::*` 与 `plugin::*` 用例全绿
- [ ] 新增用例：在 macOS 上构造 Windows 台账，证明 defer 路径可跑通、且 macOS 默认不走它
- [ ] 契约测试：`kernel-hot*`（含回滚）+ 插件安装 / 回滚（`tests/contract/`）
- [ ] 落地时同步文档：`kernel-hot-update.md` §6/§11、`shell-hot-update.md`（壳新增职责）、`architecture.md` §7（新台账进数据目录布局）、`plugin-spec.md` 平台列、`requirements` M6/M8 验收

## 6. 业界实践（可借鉴实现）

| 层 | 项目 / 机制 | 借鉴点 | 注意 |
|---|---|---|---|
| 壳 | **Velopack**（Squirrel.Windows 后继，活跃） | 「退出后由 Update.exe 替换」+ delta 包；绿色版友好 | 与方案 A 同构 |
| 壳 | Tauri v2 updater（NSIS / MSI） | 与壳同栈的安装版路径 | 需 NSIS 脚本 + 签名 |
| 壳 | Squirrel 的「版本目录 + 指针切换」 | 不覆盖旧 exe：新版进新目录、重启切指针 | 免锁，但有清理策略成本 |
| 壳 | Google Omaha（Chrome）/ WinSparkle / MSIX / ClickOnce / WinGet | Omaha 常驻更新服务；MSIX 商店托管 | 参考机制，不直接引 |
| 内核 | Rust crate `self-replace` / `self_update` | 专门的 Windows 自替换封装（rename + 重试 + 延迟兜底） | 先读源码当技术依据 |
| 内核 | Chromium component updater | 独立于主程序的组件热更新（与本项目通道同构） | 服务 / 提权模型较重 |
| 插件 | .NET `AssemblyLoadContext`（可卸载）/ OSGi / Go plugin（不可卸载）/ VS Code extension host | 佐证「进程内卸载不可靠 ⇒ 进程即插件最稳」 | 本项目已是进程模型 |
| 驱动 | Linux kpatch / livepatch、Windows hotpatch | 对照材料，说明 Windows 无第三方等价物 | 仅结论引用 |

## 7. GitHub 检索方案

**关键词矩阵**：

- 自更新 / 替换：`windows self-update`、`replace running exe`、`rename running executable`、`MOVEFILE_DELAY_UNTIL_REBOOT`、`PendingFileRenameOperations`、`FILE_SHARE_DELETE rename`、`updater helper process windows`
- 框架：`squirrel windows`、`velopack`、`winsparkle`、`omaha updater`、`tauri updater nsis`、`msix app installer`
- 进程树 / 锁：`job object kill process tree`、`TerminateProcess file lock`、`process tree handle release windows`
- 插件热更新：`AssemblyLoadContext unload`、`hot reload native dll`、`osgi bundle lifecycle`、`plugin process supervisor rust`

**检索式（可直接粘）**：

```
topic:auto-update language:rust stars:>200 archived:false pushed:>2025-01-01
topic:updater windows desktop stars:>500
"MOVEFILE_DELAY_UNTIL_REBOOT" (path:*.rs OR path:*.cpp)      # 代码搜索
"FILE_SHARE_DELETE" "rename" exe                             # 代码搜索
is:issue "replace running exe" windows updater               # 踩坑讨论
```

**筛选条件**：`stars:>200`、`pushed:>2025-01-01`（排除停维护，如 Squirrel.Windows）、`archived:false`、license（MIT / Apache 优先）、issue 活跃度。

**记录表模板**：`项目 | 机制一句话 | 关键证据（commit / issue / 文档链接）| 可借鉴点 | 与本项目的差异 | 结论（采纳 / 参考 / 排除）`

**非 GitHub 来源**：MS Learn（MoveFileEx / Job Objects / PendingFileRenameOperations / Authenticode 与 SmartScreen / MSIX 更新）、Velopack 与 Tauri updater 文档、Chromium component updater 设计文档。

## 8. 风险与注意事项

| 维度 | 风险 | 场景 | 缓解 / 验证 |
|---|---|---|---|
| 稳定性 | 半替换（新 exe 已落、UI 没换） | 内核与 UI 同包中断 | pending 台账 + 同进同退；Windows 上补「替换动作原子化」实测 |
| 稳定性 | **回滚失效** | 新版起不来要恢复备份 | `restore()` 删自身必失败 ⇒ rename 互换或交给壳（§4.2） |
| 稳定性 | 重启预算被吃光 | 热更新重启撞上壳 `MAX_RESTARTS` | 复用 `kernel/restarting`（计划内重启）语义，Windows 复测 |
| 稳定性 | 孙进程握锁 | 插件 spawn 的子进程未回收 | Job Object；换目录前等句柄归零 |
| 稳定性 | 断电 / 强杀 | pending 未清 | 启动守卫语义（attempts≥2）在 Windows 复测 |
| 安全 | 签名与 SmartScreen | 未签名 helper / exe 被拦或报警 | 复用固定签名思路做 Authenticode；文档写明「换包会改签名」 |
| 安全 | 校验缺口 | v1 内核不校验候选二进制哈希 / 签名（已声明） | 维持「下载侧 sha256 + 本地路径信任模型」；Windows 补剥离 MOTW（`Zone.Identifier`） |
| 安全 | DLL 劫持 / 工作目录 | helper 在用户可写目录启动 | helper 固定目录、全路径调用、不依赖 PATH |
| 安全 | 提权面 | Program Files 需要 UAC | 绿色版不提权；安装版更新走 NSIS（UAC 由用户确认） |
| 兼容性 | Win10 / 11、x64 / arm64 | 索引要出双平台资产 | 对齐 `kernel-release.yml` 现有矩阵；arm64 单独实测 |
| 兼容性 | 文件系统 | rename 同卷原子、跨卷不原子 | staging 固定与目标同卷（现有设计），复测 E7 |
| 兼容性 | 企业管控 | AppLocker / WDAC / 受控文件夹访问拦未知二进制 | 列为「不保证」场景，文档明说 |
| 兼容性 | 长路径 / 非系统盘 | 用户解压到移动盘或深目录 | 探测并降级为「提示手动更新」 |

## 9. 实验矩阵与排期

**环境矩阵**：Win11 x64（主力）+ Win11 arm64 + Win10 x64 + 一台装三方杀软 / EDR；两种落位（用户目录绿色版 / Program Files）。

- [ ] **P0（先做）**：§3 表 E1–E8；插件 `install_prepared` 真机三条路径
- [ ] **P1**：内核「退出后替换」原型（含回滚）；杀软共存；arm64
- [ ] **P2（按需）**：壳 helper 原型；NSIS 安装器；企业管控兼容性

**指标**：更新成功率 / 替换耗时 / 回滚成功率 / 需要用户干预的次数 / 日志可定位率。

## 10. 产出物与决策点

- [ ] 实测数据（§3 表 + 报告）
- [ ] 行为口径落文档：`docs/kernel-hot-update.md`（§11 改口）、`docs/shell-hot-update.md`（§1 / 边界）、`docs/plugin-spec.md` §6.4（平台列）
- [ ] 跨平台约束落地：§5.3 的四个收口 + §5.4 三条不变量（回归基线测试全绿）
- [ ] 必要时立 ADR（「Windows 热更新的边界：谁执行替换、谁负责回滚」）
- [ ] 落地时补 Windows 契约测试（`tests/contract/`，harness 支持平台分支）

**决策点（调研收尾必须给出结论）**：

1. 壳自更新：做 helper（绿色版全自动），还是只做「提示 + 手动下载 / 安装器」？
2. 内核热替换：替换动作收进壳的 `supervise` 窗口（推荐），还是另立独立 helper？
3. 插件层：只做「实测 + 重试策略调优」，还是同时引入 Job Object 做进程树收口？
