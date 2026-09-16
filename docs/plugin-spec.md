# 启动台插件接入规范 v1

> 状态：v1（已落地：8 个出厂插件按此实现）｜ 日期：2026-09-14，最后更新：2026-09-16 ｜ 配套：`docs/launcher-requirements.md`（底座需求）
> 读者：插件作者（含我们自己）、内核实现者、评审者
> 本文是**对外契约**。内核实现必须能逐条对应到 §14 的校验矩阵；本文没写的字段与行为，插件不得依赖。

## 规范等级

| 级别 | 记法 | 违反后果 |
|---|---|---|
| **必须** | MUST | 拒绝加载（`MANIFEST_INVALID`）或拒绝执行（`CONTRACT_VIOLATION`） |
| **应当** | SHOULD | 加载但对用户提示；插件商店/评审拒收 |
| **可选** | MAY | 无 |

## 三条不变量

| # | 不变量 | 说明 |
|---|---|---|
| **N1** | `no-view` / `script` 命令的产物文件名**必须**等于 `commands[].name` | 宿主只认 `<name>.mjs` / `<name>.js`（或 `workers/` 下同名） |
| **N2** | 插件**必须**把可变数据写在 `dataPath`，**不得**写进插件安装目录 | 安装目录只读；升级/重装会覆盖它 |
| **N3** | 插件**必须**在清单里声明它用到的所有 capability | 未声明的能力在运行时**不存在**（不是"存在但被拒"） |

---

## 1. 插件是什么

一个插件 = 一个目录，包含：

```
<pluginId>/
├── package.json        必须：清单（宿主只读顶层字段）
├── index.html          有 view 命令时必须有
├── assets/             view 的静态资源
├── <name>.mjs          no-view / script 命令的产物
└── icon.png            可选：插件级图标
```

插件的三种能力形态：**view**（带界面）、**no-view**（命令面板可见的后台任务）、**script**（只被其它命令调用的"后端函数"）。

插件由内核加载 → 校验 → 分配端口 → 构造受限 Context → 进入 `active`。生命周期见 §6。

---

## 2. 目录与产物规范

### 2.1 源工程（推荐结构）

```
my-plugin/
├── package.json          清单（构建后会被裁剪写入 dist/）
├── index.html            view 入口（固定名）
├── vite.config.ts        base: './'，不要 manualChunks
├── src/
│   ├── main.ts           挂载 view
│   ├── App.vue
│   ├── core/             纯函数（可单测，无宿主依赖）
│   └── no-view/          script / no-view 入口（每个文件一个命令）
└── test/
```

### 2.2 产物（`dist/`）—— 必须

| 文件 | 何时必须 | 说明 |
|---|---|---|
| `package.json` | 总是 | 只保留 §3 的字段（剥掉 `scripts` / `devDependencies` 等） |
| `index.html` | 有 view 命令 | 入口名固定，**不要**改 |
| `assets/*` | 有 view 命令 | 资源路径必须相对（构建基址 `./`） |
| `<name>.mjs` | 每个 no-view / script 命令 | 自包含；**不得**依赖 `assets/` 下的共享 chunk（N1） |
| `icon.png` | 可选 | 128×128 起 |

**多入口铁律**：有 **2 个及以上** no-view/script 命令时，**必须逐个入口单独构建**（每个 `.mjs` 自包含）。打包器多入口会把共用模块拆成 `assets/*.mjs`，入口里只剩相对 import，宿主只认入口文件，依赖一断命令即失效。
验收：`grep -h '^import' dist/*.mjs` 只应出现 `node:*` 与内置模块。

### 2.3 打包（zip）

- zip 根 = 插件目录内容；允许一层包裹目录（`my-plugin/package.json` 也接受）
- **不得**包含符号链接、绝对路径、`..`
- 单文件 ≤ 50MB，解压后 ≤ 200MB
- 文件名建议 `<pluginId>-<version>.zip`

---

## 3. 清单规范（`package.json`）

### 3.1 顶层字段

| 字段 | 级别 | 类型 | 约束 | 说明 |
|---|---|---|---|---|
| `name` | 必须 | string | `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$` | 插件 id，全局唯一；同时是数据目录名 |
| `title` | 必须 | string | 1–40 字符 | 展示名 |
| `version` | 必须 | string | semver | 插件版本 |
| `apiVersion` | 必须 | string | 当前只接受 `"1"` | 协议主版本；不匹配 → 拒绝加载并提示升级底座 |
| `capabilities` | 必须 | string[] | 见 §8；可为 `[]` | 空数组 = 纯前端插件 |
| `commands` | 必须 | CommandDecl[] | 1–32 条 | 见 §3.2 |
| `type` | 必须 | `"module"` | | 产物是 ESM |
| `description` | 应当 | string | ≤ 200 字符 | 设置页展示 |
| `author` | 应当 | string | | |
| `icon` | 可选 | string | 插件内相对路径 | 默认图标 |
| `keywords` | 可选 | string[] | ≤ 10 | 插件级别名：兜底给该插件**全部**入口命令（与命令级取并集后参与匹配，见 §3.2 末） |
| `categories` | 可选 | string[] | | 分类标签（展示用） |
| `essential` | 可选 | boolean | 默认 `false` | 底座基础能力：**不可禁用**（设置页不提供开关，内核 `setDisabled` 直接拒绝）。判定标准：禁用它会让启动台基本功能残废（搜应用 / 搜文件），或让用户失去自救入口（设置与插件管理被禁用后，界面上再没有地方能改回来） |
| `private` | 可选 | boolean | | 仅源工程用，产物中剥掉 |

### 3.2 `commands[]`（CommandDecl）

| 字段 | 级别 | 类型 | 说明 |
|---|---|---|---|
| `name` | 必须 | string `^[a-z0-9][a-z0-9-]{0,38}$` | 插件内唯一；脚本命令**必须**等于产物文件名（N1） |
| `title` | 必须 | string 1–40 | 搜索结果与命令面板的展示名 |
| `mode` | 必须 | `view` \| `no-view` \| `script` | 见 §4 |
| `subtitle` | 可选 | string ≤ 60 | 结果副标题 |
| `icon` | 可选 | string | lucide 图标名（如 `terminal`）/ 插件内相对路径 / `data:image/...` |
| `searchable` | 可选 | boolean，默认 `false` | 入口型搜索（§9.1）：命令本身出现在搜索结果，命中后把用户的搜索串交给插件 |
| `placeholder` | 可选 | string | `searchable: true` 时的输入提示 |
| `keywords` | 可选 | string[] ≤ 10 | 该命令的别名 |
| `contributes` | 可选 | boolean，默认 `false` | 贡献型搜索（§9.1）：搜索过程中由插件返回结果项 |
| `capabilities` | 可选 | string[] | 该命令的额外能力（并入插件级，取并集） |
| `hidden` | 可选 | boolean，默认 `false` | 不出现在搜索结果（仍可被 `invoke` 调用） |

> `essential` **只有出厂 bundle 的声明生效**：内核按 `builtin && essential` 判定，第三方插件在清单里写 `true` 也不会获得
> 「用户关不掉」的待遇（那是权限提升）。出厂插件的 id 与数据布局见 §2。

约束：
- `name` 在插件内唯一 → 全局 id = `${pluginId}:${name}`
- 至少 1 条命令；`mode: 'view'` 的命令共用同一个 `index.html`
- `searchable: true` 与 `contributes: true` 可同时为真

**别名的两层与匹配**（内核 `apps/kernel/src/overrides.ts` + `pinyin.ts`）：

- 实际参与搜索的别名 = **插件级 ∪ 命令级**（忽略大小写去重、插件级在前，每层 ≤ 10 条）；
- 别名与 `subtitle` 同权重 0.4（排序见 §9.1），且**同样走拼音索引**：短词会被长词包含命中
  （例子：别名 `totp` 会让用户搜 `otp` 也命中该命令，属预期行为）；
- **中文标题 + 英文入口的命令必须配别名**：`title: "双重验证码"` 搜 `totp` 匹配不上（§12 风险表的落地方式）；
- 用户可在「设置 → 插件」里就地改别名（插件级 / 命令级），存 `<dataRoot>/plugin-overrides.json` ——
  **不写插件产物**，重装 / 更新插件都不会丢；覆盖层里 `undefined` = 用清单原值、`[]` = 用户显式清空，
  改完注册表即时更新、**不需要重载插件**。

### 3.3 清单校验矩阵（内核实现依据）

| 校验 | 失败码 |
|---|---|
| JSON 可解析、字段类型正确 | `MANIFEST_INVALID` |
| `name` / 命令 `name` 符合正则、插件内唯一 | `MANIFEST_INVALID` |
| `apiVersion` 受支持 | `API_VERSION_UNSUPPORTED` |
| 每个 capability 在已知清单内（§8） | `CAPABILITY_UNKNOWN` |
| 每个 script/no-view 命令的产物存在 | `ENTRY_MISSING` |
| 有 view 命令时 `index.html` 存在 | `ENTRY_MISSING` |
| 全局 id 未与已加载插件冲突 | `PLUGIN_ID_CONFLICT` |

---

## 4. 命令形态

### 4.1 `view`

- 入口固定 `index.html`，多个 view 命令共用；用 `?cmd=` 区分，**必须**按 `cmd` 做内部分支或路由
- 会话：宿主打开命令时创建一个会话（`sid`），关闭页面即销毁；**不保证**会话跨次保留（要持久化用 `ctx.storage`）
- 尺寸：宿主窗口宽度固定；页面高度自适应并**自滚动**，不要嵌套滚动容器
- 关闭：`Esc` 由宿主处理（父窗口先收面板再隐藏）；插件可用 `ctx.commands.close` 主动关闭会话

### 4.2 `no-view`

- 出现在搜索结果；执行 = 拉起同名脚本产物（`worker_threads`）
- 用途：用户主动触发的后台任务。**不得**长期驻留（不得用定时器常驻；要用常驻能力请提需求）
- 参数：由 `ResultItem.action.args` 传入；在脚本里通过 `ctx().args` 读取

### 4.3 `script`

- **不**出现在搜索结果，只能被 `ctx.exec.run` 或宿主内部调用
- 参数与返回值：`done(x)` 的 `x` 即调用方 `ctx.exec.run` 的返回值（结构化克隆限制：不可传函数/Symbol）
- 超时：默认 10s，调用方可指定，上限 5min；超时 → `TIMEOUT`
- 并发：同插件脚本并发上限 4；超限排队
- 崩溃：脚本异常只影响本次调用（`fail()` / 未捕获异常 → `SCRIPT_ERROR`），连续 3 次失败会把插件标记为 `degraded`

---

## 5. 运行时环境

### 5.1 会话 URL 契约

```
http://127.0.0.1:<port>/index.html?sid=<uuid>&cmd=<command>&theme=dark|light&token=<token>
```

| 参数 | 说明 |
|---|---|
| `sid` | 会话 id，用于日志与审计关联 |
| `cmd` | 当前 view 命令名 |
| `theme` | 宿主主题（`dark` / `light`） |
| `token` | 每会话一次性 token，宿主 API 调用必须携带（SDK 已处理） |

**必须**：不要缓存/复用 `token`；不要把它写进日志或存储。

### 5.2 Origin 隔离

每个插件有**独立端口**（独立 origin）。因此：`localStorage` / `IndexedDB` / cookie 天然按插件隔离，**可以直接用**，但**持久化业务数据应当用 `ctx.storage`**（用户可见、可导出、跨端口稳定）。

### 5.3 主题

- 宿主通过 `?theme=` 传入（**每次开会话都重新带**，代表宿主当前的主题），并在文档根设 `data-theme="dark|light"`
- **应当**按四级探测，`@launcher/ui/theme` 的 `useTheme()` 已实现，直接用即可：
  插件内**手动选过**的主题 → `?theme=` → `data-theme` → `prefers-color-scheme`
- 只有**手动切换**（`toggle()` / `set()`）才把主题记进 `localStorage`。自动判定出来的值**一律不落盘** ——
  否则「第一次打开这个插件页时恰好是什么主题」会被永久钉死，宿主之后换了主题也跟不上
- 宿主给了主题、或用户手动选过时**不要**跟随系统主题变化，否则插件页会和宿主界面不一致
- 推荐直接引 `@launcher/ui` 的设计令牌（`theme.css`），不要自造色板

### 5.4 网络

- CSP：`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; connect-src 'self' https:; frame-src 'none'`
  （`'wasm-unsafe-eval'` 只放行随包 wasm 的编译；JS 的 `eval` / `new Function` 仍被禁止）
- **禁止**访问 `http://127.0.0.1:*` / `http://localhost:*`（防插件探测本机服务）；需要局域网/本地服务请提 capability 需求
- wasm **必须**随包（`?url` 打进产物），**不得**走 CDN

### 5.5 无钩子函数

v1 不提供 `onActivate` / `onDeactivate` 钩子。插件在加载时用 SDK 注册即生效，卸载由 SDK 统一回收（§6.2）。

---

## 6. 生命周期与资源回收

### 6.1 状态机

```
discovered → validating → loading → active
                         ↘ disabled（用户禁用 / 手动）
                         ↘ error（清单或产物错误）
active ⇄ disabled（用户启停）
active → crashed（页面崩溃 / 脚本连续失败）→ 可重试
```

### 6.2 注册即可逆（N4）

**必须**：插件通过 SDK 做的任何注册（命令、快捷键、footer、搜索贡献、事件订阅）都由 SDK 记录 disposer；插件停用/重载时按逆序回滚。

**应当**：如果插件在 JS 里直接用了 `setInterval` / `addEventListener` / `ResizeObserver`，**应当**在 `import { onCleanup } from '@launcher/api'` 里注册清理（SDK 提供 `onCleanup(fn)`）。

违规后果：插件重载后出现重复的 footer / 重复结果 / 内存增长 —— 评审会拒收。

### 6.3 热重载

开发模式下改动 `extensions/<id>/` 或 dev server 文件会触发重载：**历史上限、固定项、`ctx.storage` 数据必须保持不变**。插件不得在启动时做破坏性数据迁移（要迁移必须先判断版本号）。

---

## 7. 宿主 API（UI 侧）

### 7.1 用法

```ts
import { host, storage, hostUi, exec, shell, clipboard, notify } from '@launcher/api'

const inLauncher = host.isLauncher()        // 同步判断，用于降级分支
const info = await host.info()              // { version, platform, dataRoot, pluginId, command, sid }
await storage.set('accounts', list)
const content = await hostUi.getSearchContent()
```

- 所有方法返回 `Promise`，**永不抛出原生异常**；失败抛 `LauncherError { code, message }`
- 每个方法都可传 `{ timeoutMs }`；**必须**处理超时（宿主可能正在退出）
- SDK 内部对所有调用加超时（默认 1.2s，`exec` 用调用方给的值），**不得**依赖"永不返回"的语义
- 参数必须**可结构化克隆**：不要把 Vue 的 `reactive` / `ref` 代理直接交给宿主（`postMessage` 会抛 `DataCloneError`，消息发不出去）。
  SDK 已内置兜底（失败时 JSON 往返展平重发），插件侧展开一层更稳：`list.map((x) => ({ ...x }))`

### 7.2 API 全表

| 方法 | capability | 参数 | 返回 |
|---|---|---|---|
| `host.isLauncher()` | — | — | `boolean` |
| `host.info()` | — | — | `{ version, platform, dataRoot, pluginId, command, sid }` |
| `host.log(level, message, data?)` | — | — | `void`（进审计日志） |
| `commands.invoke({ command, args? })` | — | | `ActionResult` |
| `commands.close()` | — | — | `void` |
| `commands.registerAction(id, handler)` | — | | `Disposer` |
| `searchResult.set(items)` | — | `ResultItem[]` | `void` |
| `searchResult.append(items)` | — | `ResultItem[]` | `void` |
| `searchResult.clear()` | — | — | `void` |
| `storage.get(key)` | `storage` | | `unknown \| undefined` |
| `storage.set(key, value)` | `storage` | | `void` |
| `storage.remove(key)` | `storage` | | `void` |
| `storage.all()` | `storage` | | `Record<string, unknown>` |
| `storage.clear()` | `storage` | | `void` |
| `hostUi.getSearchContent()` | `hostUi` | | `string` |
| `hostUi.setSearchContent(v)` | `hostUi` | | `boolean` |
| `hostUi.clearSearchContent()` | `hostUi` | | `boolean` |
| `hostUi.setFooter(buttons)` | `hostUi` | 见 §10.3 | `boolean` |
| `hostUi.hide()` | `hostUi` | | `void` |
| `clipboard.readText()` | `clipboard.read` | | `string` |
| `clipboard.writeText(text)` | `clipboard.write` | | `void` |
| `shell.openUrl(url)` | `shell.open` | 仅 http/https/mailto | `void` |
| `shell.openPath(path)` | `shell.open` | | `void` |
| `shell.reveal(path)` | `shell.open` | | `void` |
| `exec.run({ command, args?, timeoutMs? })` | `exec.spawn` | 只能调本插件的 `script`/`no-view` 命令 | `unknown` |
| `notify.show({ title, body })` | `notify.show` | | `boolean` |
| `screenshot.start()` | `screenshot` | 只返回是否成功触发（图进系统剪贴板） | `boolean` |
| `quicklink.all()` / `add` / `edit` / `remove` | `quicklink` | | `Quicklink[]` / `void` |
| `onCleanup(fn)` | — | | `Disposer` |

### 7.3 错误码

| code | 含义 |
|---|---|
| `CAPABILITY_DENIED` | 未声明/未授权（正常情况下应为"方法不存在"，此码用于 `invoke` 等间接调用） |
| `NOT_FOUND` | 命令 / 键 / 会话不存在 |
| `TIMEOUT` | 超时 |
| `BAD_ARGS` | 参数不合法（含 schema 校验失败） |
| `BUSY` | 并发超限 |
| `INTERNAL` | 宿主内部错误 |

### 7.4 降级要求（必须）

插件**必须**在非宿主环境（`npm run dev` 的浏览器、或宿主版本过旧）下可用或明确提示：

- 用 `host.isLauncher()` 判断，而不是"等超时"
- 宿主能力缺失时：要么用本地实现兜底，要么在 UI 上给出可操作的提示（**不得**白屏、不得静默失败）
- 参考实现：`import { host } from '@launcher/api'` 后用 `host.isLauncher()` 判断（4 个 Vue 插件都这么做）

---

## 8. 能力（capabilities）

| 名称 | 提供什么 | 风险 | 安装时是否提示 |
|---|---|---|---|
| `hostUi` | 读写宿主搜索框、footer、隐藏窗口 | 低 | 否 |
| `storage` | 插件私有 KV（落 `<dataRoot>/plugins/<id>/storage.json`） | 低 | 否 |
| `clipboard.read` | 读系统剪贴板 | 中 | 是 |
| `clipboard.write` | 写系统剪贴板 | 低 | 否 |
| `shell.open` | 用系统程序打开 URL / 文件 / 应用 | 中 | 是 |
| `exec.spawn` | 拉起本插件的脚本（可读写文件） | **高** | 是 |
| `notify.show` | 系统通知 | 低 | 否 |
| `screenshot` | 触发区域截图（结果进剪贴板） | 中 | 是 |
| `quicklink` | 管理快捷链接 | 低 | 否 |

规则：

1. **必须**只声明实际用到的能力（多声明 = 评审拒收；`scripts/spec-check.mjs` 会静态反查调用与声明的差集）
2. 未声明的能力在运行时**不存在**（属性为 `undefined`，且不出现在 `Object.keys`）
3. 高风险能力（`exec.spawn` / `clipboard.read` / `shell.open` / `screenshot`）在安装时展示给用户，用户可拒绝 → 该服务不挂载，插件**必须**有降级路径
4. 新增能力只能由底座发布（新 capability 属于 minor 变更，§11）

---

## 9. 结果贡献与搜索（两种模式）

### 9.1 入口型 vs 贡献型

| | 入口型（`searchable: true`） | 贡献型（`contributes: true`） |
|---|---|---|
| 结果里出现什么 | **命令本身**（如"JSON 格式化"） | **插件返回的结果项**（如"打开 /Users/x/a.json"） |
| 用户输入怎么给插件 | 命中命令后，用 `hostUi.watchSearchContent` / `getSearchContent` 读 | 每次输入触发 `onQuery`（§9.2） |
| 适用 | 工具类插件（我们的 4 个插件都是这类） | 索引类插件（应用启动器、文件搜索、历史搜索） |
| placeholder | 显示在搜索框 | 忽略 |

**入口型插件的输入必须用 `hostUi.getSearchContent()` 取初始值**：v1 底座在 view 会话打开后不显示搜索框
（插件页占满窗口），因此 `hostUi.watchSearchContent` 在底座里**不会有回调**——它是为「搜索框与插件页并存」
的宿主形态有意义。要「边打字边联动」，请把输入框做在插件页自己的界面里。

### 9.2 贡献型协议

```ts
import { search } from '@launcher/api'
search.onQuery(({ query, token }) => {
  // 200ms 内返回；也可同步 append
  return items            // ResultItem[]
})
```

- 宿主按 80ms debounce 广播；插件**应当**在 **200ms** 内返回
- 超时：本次贡献丢弃并记审计（**不得**阻塞其它插件的结果）
- 结果项**必须**满足：`id` 稳定（同一对象每次查询返回同一 id，否则历史/固定会错位）

### 9.3 `ResultItem`

```ts
interface ResultItem {
  id: string                    // 插件内唯一且稳定；建议 `命令名:业务主键`
  title: string                 // ≤ 80 字符
  subtitle?: string             // ≤ 120 字符
  icon?: string                 // lucide 名 / 相对路径 / data URL
  score?: number                // 0..1 插件自评（可选）
  action: ActionDecl            // Enter 的默认动作
  actions?: ActionDecl[]        // 右键 / ⌘K 追加项
  detail?: string               // 二级面板纯文本（v1 只支持纯文本）
}
```

### 9.4 `ActionDecl`

```ts
type ActionDecl =
  | { type: 'command'; command: string; args?: unknown }                        // 本插件命令
  | { type: 'invoke'; pluginId: string; command: string; args?: unknown }       // 其它插件命令（需被调用方允许）
  | { type: 'open'; target: string; targetKind?: 'url' | 'path' | 'app' }
  | { type: 'copy'; text: string }
  | { type: 'host'; method: 'hostUi.setSearchContent' | 'hostUi.hide' }
```

**禁止**在 `ResultItem` 里出现能力特定的字段（如 `appPath`、`totpSecret`）。要传数据用 `action.args`，执行时再解释。

---

## 10. UI 规范

### 10.1 视觉

- **应当**引 `@launcher/ui`（工作区包 `packages/ui`：设计令牌 `theme.css` + `AppShell` / `UiIcon` / `UiDialog` + `virtual` / `clipboard` / `keys` / `theme` / `toast`），保证与启动台一致
- 深浅色**必须**都可用；不要在白色背景上写死深色文本
- 字号：正文 13px / 次要 12px；圆角与间距用令牌变量
- 过渡时长与缓动**应当**用 `--launcher-motion-*` / `--launcher-ease-*` 令牌（ADR-0004），不要写死数值；离场时长**应当**短于进场
- 滚动条**不要**自己写样式：引了 `theme.css` 就已经是「轨道隐形 + 6px 药丸滑块、轨道颜色只由前景色推导」的统一款式（宿主与全部插件页同一套）。
  不引 `theme.css` 的插件页会落到系统样式 —— 系统开着「始终显示滚动条」时是带边框轨道与两端箭头的经典样式，和本套扁平界面放在一起很扎眼

### 10.2 键盘

| 键 | 约定 |
|---|---|
| `Esc` | 先关插件内的弹层/面板；没有时由宿主隐藏窗口 |
| `⌘W` / `Ctrl+W` | 关闭当前会话（等价 `commands.close()`） |
| `⌘K` | 打开宿主动作面板 |
| 其它 | 插件自管，但**不得**占用全局热键 |

### 10.3 `setFooter`

```ts
hostUi.setFooter([
  { type: 'button', label: '复制', icon: 'copy', keys: ['Mod+Shift+C'], onClick: () => {} },
  { type: 'action-panel', label: '更多', keys: ['Mod+K'], title: '更多操作',
    items: [{ name: '导出', icon: 'download', onSelect: () => {} }] }
])
```
`icon` 用 lucide 图标名；`keys` **同时是触发键与展示提示**——但 v1 底座的 footer 只渲染按钮并接收点击，
`keys` 仅作展示；插件若依赖快捷键，请在插件页内自行处理键盘事件（`Esc` / `⌘W` 由宿主占用）。

### 10.4 图标

- 命令/结果图标：lucide 名优先；插件私有图标用相对路径或 data URL，尺寸 ≥ 40×40（渲染 20×20）
- **不得**引用远程图标 URL
- 启动台内置了一份常用 lucide 图标子集（`apps/launcher-ui/src/lib/icons.ts`，约 40 个）；名字写法不敏感（`git-compare` 与 `GitCompare` 等价）
- **不在子集内的名字会退化成「名称首字母」占位方块**（不报错）；需要新图标就往那份字典里加一条（数据取自 lucide，许可见 `docs/THIRD-PARTY.md`）

### 10.5 i18n

v1 只要求：所有面向用户的字符串集中在 `src/locales/zh-CN.ts`（便于后续加语言），**不得**硬编码散落在模板里。

---

## 11. 版本与兼容

| 规则 | 内容 |
|---|---|
| `apiVersion` | 字符串主版本。底座必须能读 `"1"`；未来 `"2"` 需底座同时支持 1 与 2，否则拒绝加载并提示 |
| 能力只增不减 | 同一 `apiVersion` 内不得删除/重命名 capability 与 API；新增为 minor |
| 弃用流程 | 标注 `@deprecated` → 至少保留一个 minor → 下一个主版本移除（写入 changelog） |
| 插件版本 | 插件自身 semantic versioning；底座在设置页展示"插件声明需要 apiVersion X，当前底座支持 Y" |

---

## 12. 开发与调试

本仓库的插件都是 pnpm workspace 成员，命令在**仓库根**执行（插件自己的脚本用 `--filter`）：

```bash
pnpm install
pnpm --filter <name> dev        # vite dev server（浏览器直接调 UI；宿主能力走降级分支）
pnpm --filter <name> build      # 产出 dist/（index.html + assets + <name>.mjs + 裁剪后的 package.json）
pnpm --filter <name> typecheck
pnpm build:plugins              # 构建全部出厂插件
pnpm spec-check [name]          # 规范自检（清单 / 产物 / 能力 / 数据目录 / N1 / N2 / N3）
pnpm pack:plugins               # 打 zip 到 plugins/release/
pnpm test                       # 全量测试（含各插件的 core·script 用例）
```

- **dev 注册**：`pnpm dev:kernel` 起内核（本机 control 端口 + 一次性 token），插件 dev server 把 `devUrl` 挂上去，插件页直接指向 vite ⇒ 免重启热更新
- **DevTools**：设置 → 插件 → 打开 DevTools（开发构建可用）
- **调试日志**：`host.log('info', '...')` 会进审计日志，设置页可实时查看
- **新建插件**：暂无脚手架包（`packages/plugin-cli` 是待办）—— **照抄现有插件**最快：Vue 工程看 `plugins/totp`（view + script + 对话框）与 `plugins/hosts`（提权写系统文件），配置模板见 `docs/plugin-dev-guide.md` §4 与 `.codebuddy/skills/chassis-plugin-dev/references/scaffold-templates.md`

---

## 13. 接入检查清单（提交前逐条确认）

**清单**
- [ ] `name` / 命令 `name` 符合正则；插件内唯一
- [ ] `apiVersion: "1"`；`type: "module"`
- [ ] `capabilities` 与实际调用完全一致（`spec-check` 无差集）
- [ ] 每个命令有 `title`；脚本命令的 `name` 等于产物文件名
- [ ] `searchable` / `contributes` 按 §9.1 选对，`placeholder` 已写

**产物**
- [ ] `dist/index.html` + `assets/` 存在，资源路径相对（`base: './'`）
- [ ] 每个 no-view/script 入口自包含：`grep -h '^import' dist/*.mjs` 只剩 `node:*`
- [ ] `dist/package.json` 只含 §3 字段（无 `scripts` / `devDependencies`）
- [ ] wasm 随包，无 CDN 引用

**运行**
- [ ] `host.isLauncher()` 为 false 时行为明确（本地兜底或可操作提示）
- [ ] 所有宿主调用都处理了失败与超时
- [ ] 可变数据只写 `dataPath`（N2）
- [ ] 定时器/监听器都在 `onCleanup` 里清理（§6.2）
- [ ] 深浅色都能看；`Esc` 行为符合 §10.2

**安全**
- [ ] 危险操作（写系统文件 / 提权）不接受调用方传入的目标路径
- [ ] 密钥/验证码不明文落盘（要持久化就提供口令加密）
- [ ] 不请求 `http://127.0.0.1:*`；不引用远程图标

---

## 14. 内核侧校验矩阵（规范 ↔ 实现 ↔ 错误码）

| 规范条目 | 校验时机 | 内核行为 | 错误码 |
|---|---|---|---|
| §3.3 清单校验 | 加载时 | 拒绝加载 + 设置页显示原因 | `MANIFEST_INVALID` / `API_VERSION_UNSUPPORTED` / `CAPABILITY_UNKNOWN` |
| N1 产物名一致 | 加载时 | 该命令标记 `error`，其余命令照常 | `ENTRY_MISSING` |
| §5.1 token | 每次调用 | 丢弃 + 审计 | 静默丢弃（记审计） |
| §7.4 降级要求 | 无法自动校验 | 评审 + `echo-plugin` 用例覆盖 | — |
| §8 能力声明 | 装配期 | 未授权服务不挂载 | 属性不存在 / `CAPABILITY_DENIED` |
| N2 数据目录 | 运行期 | `pluginPath` 只读；写安装目录失败 → 审计告警 | `CONTRACT_VIOLATION`（告警） |
| §9.2 200ms | 搜索时 | 超时丢弃本次贡献 + 审计 | — |
| §9.3 稳定 id | 运行期 | 不稳定 id 会导致固定/历史错位（审计记录同一 id 标题变化） | — |
| §10 违规（如劫持全局热键） | 运行期 | 拒绝注册 | `CAPABILITY_DENIED` |

---

## 附录 A：最小插件示例

```
hello/
├── package.json
├── index.html
├── src/main.ts
└── src/no-view/greet.ts        → dist/greet.mjs
```

```jsonc
// package.json
{
  "name": "hello",
  "title": "你好",
  "version": "0.1.0",
  "type": "module",
  "apiVersion": "1",
  "capabilities": ["storage"],
  "commands": [
    { "name": "hello", "title": "打个招呼", "mode": "view", "searchable": true, "placeholder": "输入名字" },
    { "name": "greet", "title": "问候（后台）", "mode": "no-view" },
    { "name": "greet-script", "title": "问候（脚本）", "mode": "script" }
  ]
}
```

```ts
// src/main.ts
import { host, hostUi, storage, onCleanup, LauncherError } from '@launcher/api'

if (host.isLauncher()) {
  const { command } = await host.info()
  const name = await storage.get<string>('lastName')
  await hostUi.setSearchContent(name ?? '')
  const off = hostUi.watchSearchContent((v) => { void storage.set('lastName', v) })
  hostUi.setFooter([{ type: 'button', label: '清空', icon: 'eraser', keys: ['Mod+L'],
    onClick: () => hostUi.clearSearchContent() }])
  onCleanup(off)
} else {
  document.body.textContent = '请在启动台中使用（浏览器里仅有降级预览）'
}
```

```ts
// src/no-view/greet.ts
import { ctx, log, progress, done, fail, onError } from '@launcher/api-node'

onError()
const { args, dataPath } = ctx()
log('greet 开始', { dataPath }, 'debug')
progress(0.5)
try {
  done({ hello: (args as { name?: string })?.name ?? 'world' })
} catch (e) {
  fail(e)
}
```

---

## 附录 B：术语

| 术语 | 含义 |
|---|---|
| capability | 插件申请使用的宿主能力，必须在清单声明 |
| 入口型搜索 | `searchable: true`，命令本身参与搜索 |
| 贡献型搜索 | `contributes: true`，插件在搜索过程中返回结果项 |
| dataPath | `<dataRoot>/plugins/<pluginId>/`，插件唯一可写目录 |
| disposer | 注册时返回的清理函数，停用/重载时按逆序调用 |
| 会话（session） | 一次 view 命令的打开实例，由 `sid` 标识 |
