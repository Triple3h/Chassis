# 启动台插件接入规范 v2

> 状态：v2（2026-09-17 起：逻辑层产物 = 可执行文件、宿主 spawn 子进程 + NDJSON；视图层规范与 v1 相同）｜ 日期：2026-09-14，最后更新：2026-09-17 ｜ 配套：`docs/launcher-requirements.md`（底座需求）
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
| **N1** | `no-view` / `script` 命令的产物文件名**必须**等于 `commands[].name` | 宿主只认可执行产物 `<name>`（Windows `<name>.exe`；或 `workers/` 下同名）。`.mjs` / `.js` 产物自 v2 起**不再支持**（§11） |
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
├── <name>              no-view / script 命令的产物（可执行文件；Windows 为 <name>.exe）
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
├── Cargo.toml            逻辑层 crate（有 no-view / script 命令时；crate 根 = 插件目录）
├── src/
│   ├── main.ts           挂载 view
│   ├── App.vue
│   ├── core/             纯函数（可单测，无宿主依赖）
│   └── bin/<name>.rs     逻辑层命令入口（[[bin]] name = 命令名，每个命令一个可执行产物，见 §4.4）
└── test/
```

### 2.2 产物（`dist/`）—— 必须

| 文件 | 何时必须 | 说明 |
|---|---|---|
| `package.json` | 总是 | 只保留 §3 的字段（剥掉 `scripts` / `devDependencies` 等） |
| `index.html` | 有 view 命令 | 入口名固定，**不要**改 |
| `assets/*` | 有 view 命令 | 资源路径必须相对（构建基址 `./`） |
| `<name>` | 每个 no-view / script 命令 | **可执行文件**（Windows 加 `.exe`；macOS / Linux 权限 0755）。静态链接、自包含，**不得**依赖 `assets/` 或同目录其它文件（N1） |
| `icon.png` | 可选 | 128×128 起 |

**产物查找顺序**：`<name>(.exe)` → `workers/<name>(.exe)`。找不到 → 该命令报 `ENTRY_MISSING`（错误码与 v1 相同）。
**多入口铁律**：有 **2 个及以上** no-view/script 命令时，**每个命令必须有独立产物**（各自静态链接，不受打包器 chunk 拆分影响）。构建方式见 `docs/plugin-dev-guide.md` §7。
验收：`file dist/<name>` 应为本机可执行格式（macOS Mach-O / Windows PE）；宿主以 0755 权限 spawn。

### 2.3 打包（zip）

- zip 根 = 插件目录内容；允许一层包裹目录（`my-plugin/package.json` 也接受）
- **不得**包含符号链接、绝对路径、`..`
- 单文件 ≤ 50MB，解压后 ≤ 200MB
- 文件名**必须**是 `<pluginId>-<version>.zip`（远程更新通道另加平台后缀：`<pluginId>-<version>-<platform>-<arch>.zip`，见附录 C）

---

## 3. 清单规范（`package.json`）

### 3.1 顶层字段

| 字段 | 级别 | 类型 | 约束 | 说明 |
|---|---|---|---|---|
| `name` | 必须 | string | `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$` | 插件 id，全局唯一；同时是数据目录名 |
| `title` | 必须 | string | 1–40 字符 | 展示名 |
| `version` | 必须 | string | semver | 插件版本 |
| `apiVersion` | 必须 | string | 新插件写 `"2"`（兼容规则见 §11） | 协议主版本；`"2"` = 逻辑层产物为可执行文件；不匹配 → 拒绝加载并提示升级底座 |
| `capabilities` | 必须 | string[] | 见 §8；可为 `[]` | 空数组 = 纯前端插件 |
| `commands` | 必须 | CommandDecl[] | 1–32 条 | 见 §3.2 |
| `type` | 必须 | `"module"` | | 产物是 ESM |
| `description` | 应当 | string | ≤ 200 字符 | 设置页展示 |
| `author` | 应当 | string | | |
| `icon` | 可选 | string | 插件内相对路径 | 默认图标 |
| `keywords` | 可选 | string[] | ≤ 10 | 插件级别名：兜底给该插件**全部**入口命令（与命令级取并集后参与匹配，见 §3.2 末） |
| `categories` | 可选 | string[] | | 分类标签（展示用） |
| `essential` | 可选 | boolean | 默认 `false` | 底座基础能力：**不可禁用**（设置页不提供开关，内核 `setDisabled` 直接拒绝）。判定标准：禁用它会让启动台基本功能残废（搜应用 / 搜文件），或让用户失去自救入口（设置与插件管理被禁用后，界面上再没有地方能改回来） |
| `history` | 可选 | boolean | 默认 `true` | 是否计入「最近使用」（§7.5）：声明 `false` 的插件，其条目**不写历史**，启动时还会把已有条目摘掉。底座自身入口（设置 / 插件管理 / 应用启动 / 文件搜索）用它 —— 一用就占满最近使用，而这些入口随时搜得到。只影响最近使用，搜索结果与固定项不受影响 |
| `settings` | 可选 | SettingDecl[] | ≤ 16 条 | 插件设置声明（§3.4）：设置页渲染成通用表单；用户改过的值单独存，**不写清单** |
| `session` | 可选 | object | 见 §3.6 | 进行中会话（录屏 / 导出这类有时效的事）：内核据此在**托盘菜单最前面**挂一块控制区（状态行 + 暂停 / 结束）。**省略 = 这个插件没有「进行中」的概念** |
| `platforms` | 可选 | string[] | `macos` / `windows` / `linux` 的非空数组 | 支持的操作系统白名单（§3.5）；**省略 = 不限制** |
| `arch` | 可选 | string[] | `x64` / `arm64` 的非空数组 | 支持的 CPU 架构白名单（§3.5）；**省略 = 不限制** |
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
| `hidden` | 可选 | boolean，默认 `false` | 不出现在搜索结果**与首页「已安装插件」清单**（仍可被 `invoke` 调用） |

> `hidden` 是**双向**的：既退搜索结果、也退首页那一格 —— 管理面插件（`internal-settings` 的 `settings` / `manage`、
> `internal-store` 的 `updates`）用它把入口收进固定位置（⌘, / 搜索栏齿轮 / 托盘「检查更新…」「设置…」「插件管理…」），
> 页面本身仍可 `invoke` 打开。想整插件退干净，要把它的**全部** `view` 命令都标上
> （否则同插件的下一条 `view` 命令会顺位顶上首页格）。

> `essential` **只有出厂 bundle 的声明生效**：内核按 `builtin && essential` 判定，第三方插件在清单里写 `true` 也不会获得
> 「用户关不掉」的待遇（那是权限提升）。出厂插件的 id 与数据布局见 §2。

约束：
- `name` 在插件内唯一 → 全局 id = `${pluginId}:${name}`
- 至少 1 条命令；`mode: 'view'` 的命令共用同一个 `index.html`
- `searchable: true` 与 `contributes: true` 可同时为真

**别名的两层与匹配**（内核 `apps/kernel/src/overrides.rs` + `pinyin.rs`）：

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

### 3.4 `settings[]`（插件设置声明）

```ts
interface SettingDecl {
  key: string          // ^[a-z][a-z0-9-]{0,31}$，插件内唯一
  type: 'select' | 'switch' | 'text'
  title: string        // 1–40 字符
  description?: string // ≤ 120 字符，显示在标题下
  default?: string | boolean   // select / text 用字符串，switch 用布尔；select 的 default 必须在 options 里
  options?: Array<{ value: string; label: string }>  // type=select 必须提供（2–32 项，value 唯一）
}
```

声明只描述「有哪些设置、长什么样」；**用户改过的值不写清单**（插件产物是构建产物，重装 / 更新即丢）——
内核统一存 `<dataRoot>/plugin-settings.json`（与别名的覆盖层同款）。**生效值 = 用户值 ?? `default`**。

- **插件侧怎么读**：script / no-view 用 `ctx.settings`（v2：Rust SDK；v1：`@launcher/api-node` 的 `ctx().settings`）：

  ```rust
  // v2（Rust SDK）；v1 写法：const { settings } = ctx()
  let engine = ctx.settings_str("engine").unwrap_or("google");
  ```

  值在**插件进程启动时快照一次** —— 用户在设置页改完，内核会重载该插件，新值随新进程生效；
  常驻插件进程**不得**假设设置会在自己的生命周期内变化。
- **设置页怎么改**：设置 → 插件 → 详情的**「设置」页签**（这一页**由声明激活**：没声明 `settings`
  的插件不出现）—— select 用自绘下拉 / switch / text，改完立即保存；未改过的项显示 `default`，
  改过的项提供「恢复默认」（删掉用户值、回落清单值）。
- **卸载即清**：卸载插件时其设置一并删除（重装不背旧值）；清单里删掉的键、类型对不上的残留值会被过滤。
- 声明 `settings` **不需要**任何 capability（不是权限）；没声明的插件在设置页不出现「插件设置」区块。

### 3.5 平台声明与过滤（`platforms` / `arch`）

插件可以声明自己支持的**操作系统**与 **CPU 架构**；内核在**扫描期（加载之前）**比对当前运行环境，
不匹配的插件**整包跳过** —— 不注册命令、不进设置页、不占最近使用、不启插件页服务。

```jsonc
{
  "name": "clipboard-history",
  "platforms": ["windows"],   // 只在 Windows 上装载
  "arch": ["x64", "arm64"]    // 架构不限制（省略即可）
}
```

**标识口径**：

| 维度 | 取值 | 与什么一致 |
|---|---|---|
| `platforms` | `macos` / `windows` / `linux` | Rust `std::env::consts::OS`（照 `#[cfg(target_os = "windows")]` 的心智写） |
| `arch` | `x64` / `arm64` | `std::env::consts::ARCH` 归一（`x86_64` → `x64`、`aarch64` → `arm64`） |

> ⚠️ `platforms` **不等于** `host.info().platform` —— 后者是 Node 口径（`darwin` / `win32` / `linux`），
> 为兼容既有契约保留；两者不要混用。

**规则**：

1. **省略 = 不限制**（现有插件一行都不用改；能力只增不减，§11）。
2. 两个维度**独立判定**，都匹配才装载；空数组**非法**（语义歧义：是"全平台"还是"全不支持"？一律 `MANIFEST_INVALID`）。
3. 未知取值 / 非数组 / 非字符串元素 → `MANIFEST_INVALID`（§3.3）。

**平台能力差异与降级（插件作者须知）**：系统级能力两端并不对等 —— 典型如 macOS 有 Spotlight
（`mdfind`）与 Quick Look，Windows 没有等价物。约定：

1. 差异**收在插件内部的平台分支**里，对宿主 / UI 的契约（命令、结果项字段、事件）两端完全一致；
2. 每条能力都要有**降级路径**：拿不到就给空结果或更弱的实现，不报错、不中断其它来源；
3. 需要在某个平台**完全不出现** ⇒ 用本节的 `platforms` 声明，不要靠"运行时失败"来隐藏；
4. 出厂插件现状（可作写法参照）：
   - `file-search`：macOS = Spotlight（`mdfind`）；Windows = **复用用户已装的 Everything**（按官方 IPC 协议实现，
     探不到则回退自建索引，后者带目录变化增量）；
   - `app-launcher`：macOS = `.app` bundle 扫描；Windows = 开始菜单 / 桌面快捷方式 + 注册表 `App Paths`；
   - `host-manager`：macOS = `osascript` + POSIX ACL；Windows = UAC + `icacls`（免授权写入的等价物）；
   - `screen-recorder`：`platforms: ["macos", "windows"]`，两端后端二选一（编译期决定，见 `src/macos.rs` /
     `src/windows.rs`）：录制 macOS = 系统 `screencapture -v`、Windows = `ffmpeg -f gdigrab`（运行时探测，
     未装则 `DEPENDENCY_MISSING` + 引导，截图不依赖它）；停止 macOS = 给录制进程发 SIGINT、
     Windows = 停止文件通知一个持有 ffmpeg stdin 的录制子进程（`rec-start --worker`）；
     差异（点击高亮 / 窗口录制 / 委托系统截图工具）由 `rec-permission` 回的 `features` 矩阵交给 UI 呈现，
     **命令与字段两端完全一致**；
   - `screen-recorder` 的暂停同理：macOS = `SIGSTOP` 冻住 `screencapture`（画面停在最后一帧，
     暂停段会留在产物里）、Windows = 挂起 ffmpeg 的线程（暂停段不进视频）；两端**计时口径一致**
     （托盘与面板显示的都是 `activeMs` = 有效录制时长），差异在界面上如实说明。

### 3.6 `session`（进行中会话 → 托盘控制区）

有些插件会**跑一段有时效的事**（录屏、导出、转码……）。这类事最该出现在用户点开托盘的第一眼：
「录了多久 / 暂停 / 结束」，而不是先翻过一排应用入口。插件在清单里点名三条**自己已声明的 `script` 命令**，
内核就把这块控制区挂在托盘菜单**最前面**（菜单里位置见 requirements §3.1）：

```jsonc
{
  "session": {
    "status": "rec-status",   // 必须：回报状态（内核按拍子问它）
    "pause": "rec-pause",     // 可选：暂停 / 继续（点一下切一次）
    "stop": "rec-stop"        // 可选：结束
  }
}
```

**`status` 命令的返回**（字段名固定，缺一个就当没有）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `active` | boolean | 这段会话还在跑吗。**不是 `true` ⇒ 内核把整块会话区撤掉**（托盘绝不显示已经结束的会话） |
| `activeMs` | number | **有效时长**（毫秒，扣掉暂停）；显示的就是它 |
| `paused` | boolean | 是否暂停：暂停时内核不再给它加本地走字（秒表停住） |
| `state` | string | 可选的状态词（如「录制中」/「暂停中」），缺省用内核的通用词「进行中」/「已暂停」 |

**内核的行为**：

1. 声明了 `session` 的插件跑完**任意命令** ⇒ 立刻问一次状态（用户在面板里点的开始要马上出现在托盘里）；
   之后 **1s 一拍本地走字**，每 2 拍才真的拉起一次 `status` —— 显示每秒跳，但不用「每秒 spawn 一个进程」换秒表；
2. 点「暂停 / 结束」⇒ 内核按清单里的名字拉起对应命令；该动作在飞时这两个项**禁点**（连点 = 堆一串进程）；
3. 文案是**通用**的：状态行 = `插件 title · 状态词 时长`，动作 = 暂停 / 继续 / 结束。
   内核不认识「录屏」这两个字 —— 语义全在插件那侧（`state` 词也由插件给）。

**规则**：

1. `status` 必须存在且是 `script` 命令；`pause` / `stop` **至少要有一个**（只有状态行的会话点不动任何东西）
   ⇒ 否则 `MANIFEST_INVALID`（§3.3）；
2. 会话区**不需要任何新能力**：内核能做的只有「拉起插件自己声明的命令」与「写托盘菜单」；
3. 会话**结束由插件负责说清**（`active: false`）—— 到点自动收尾、被系统收走，都走这条；
   插件不说，托盘就会一直显示「进行中」；
4. 降级：命令拉不起来 / 状态查询失败 ⇒ 会话区消失（只记日志，不打断用户，也不影响托盘的其它项）。

**执行时机与不匹配时的处理**（两处，语义不同）：

| 时机 | 判定 | 行为 |
|---|---|---|
| **扫描期**（`PluginManager::scan()`，加载前过滤） | 声明**合法**且明确不含当前环境 | **跳过**；内核日志 `info`：「跳过插件 X：platforms 声明 [windows]，当前是 macos」。出厂基础插件（`essential`）被过滤是异常 ⇒ 提到 `warn` |
| 扫描期 | 声明**非法**（`platforms: "windows"` / `[]` / `["win"]`） | **不跳过** —— 留给 `load()` 的 `validate_manifest()` 报 `MANIFEST_INVALID`，插件以 `error` 状态出现在设置页。**宁可让用户看见"清单写错了"，也不让插件无声消失** |
| **安装期**（`installDir` / `installZip`） | 清单校验通过后仍不匹配 | 直接失败：`PLATFORM_MISMATCH`（安装是显式动作，必须给回执，不能"装了却什么都没有"） |

运行时**不做**二次判定：`scan()` 是唯一闸门（目录变化重载、手动 enable/reload 都先过它），
所以不匹配插件在任何路径下都不会被拉起。

---

## 4. 命令形态

### 4.1 `view`

- 入口固定 `index.html`，多个 view 命令共用；用 `?cmd=` 区分，**必须**按 `cmd` 做内部分支或路由
- 会话：宿主打开命令时创建一个会话（`sid`），关闭页面即销毁；**不保证**会话跨次保留（要持久化用 `ctx.storage`）
- 尺寸：宿主窗口宽度固定；页面高度自适应并**自滚动**，不要嵌套滚动容器
- 关闭：footer「返回」/ `Esc` / `⌘W` 由宿主统一收口（**回到搜索态**，不是隐藏窗口）；插件也可用 `ctx.commands.close` 主动关闭会话。
  插件页是独立文档，宿主的键盘监听收不到焦点在 iframe 里的按键 —— `@launcher/api` 已兜底：**没有被插件消费**的 `Esc`
  自动交还宿主（等价 `commands.close()`）。插件消费 Esc（关掉自己画的弹层、清空搜索框）时**必须** `preventDefault()`
  （`stopPropagation()` 同样有效，`UiDialog` / `UiSelect` 就是这么做的）

### 4.2 `no-view`

- 出现在搜索结果；执行 = 宿主 spawn 同名可执行产物（子进程 + NDJSON，协议见 §4.4）
- 用途：用户主动触发的后台任务。**不得**长期驻留（不得自行常驻；常驻请用 `contributes: true` 的搜索命令，宿主按需启停）
- 参数：由 `ResultItem.action.args` 传入；在插件里通过 `ctx.args` 读取

### 4.3 `script`

- **不**出现在搜索结果，只能被 `ctx.exec.run` 或宿主内部调用
- 参数与返回值：`done(x)` 的 `x` 即调用方 `ctx.exec.run` 的返回值（**必须可 JSON 序列化**：不可传函数 / Symbol / 循环引用）
- 超时：默认 10s，调用方可指定，上限 5min；超时 → `TIMEOUT`（宿主 SIGTERM → 2s 宽限 → SIGKILL）
- 并发：同插件命令并发上限 4；超限排队
- 崩溃：非零退出只影响本次调用（`fail()` / panic / 非零退出码 → `SCRIPT_ERROR`），连续 3 次失败会把插件标记为 `degraded`

### 4.4 逻辑层运行时（`no-view` / `script`，v2）

> v2 起逻辑层插件是**独立可执行文件**：宿主以子进程方式运行（`spawn` + NDJSON），机器上不需要任何 JS 运行时。官方 SDK：`packages/plugin-sdk-rs`（crate `launcher-plugin-sdk`）。

**产物与查找顺序**

```
<pluginRoot>/dist/<name>          # macOS / Linux（0755）
<pluginRoot>/dist/<name>.exe      # Windows
<pluginRoot>/dist/workers/<name>  # 备选位置
```

查找顺序：`<name>(.exe)` → `workers/<name>(.exe)`；找不到 → 该命令报 `ENTRY_MISSING`。

**启动与上下文注入**

宿主 spawn：

```
launcher-plugin-<name> --mode run|search [--launcher-context <base64url JSON>]
```

`--launcher-context` 解码后的字段（与 v1 `workerData` 一一对应）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `pluginId` | string | 插件 id |
| `command` | string | 命令名（= 产物文件名） |
| `pluginPath` | string | 插件根目录绝对路径（只读，N2） |
| `dataPath` | string | 插件唯一可写目录 `<dataRoot>/plugins/<id>/` |
| `dataRoot` | string | 数据根 |
| `mode` | `"run"` \| `"search"` | 一次性执行 / 贡献型常驻 |
| `args` | any | `mode=run` 的入参 |
| `settings` | object | 生效设置快照（用户值 ?? 清单默认；启动时冻结，改设置会重载插件） |
| `host` | string | 恒为 `"launcher"`（供插件自检） |
| `apiVersion` | number | `2` |

另注入环境变量 `LAUNCHER_PLUGIN_ID` / `LAUNCHER_DATA_PATH`（便于插件在极早期自报身份）。

**消息协议（NDJSON，双向）**

插件 → 宿主（stdout，每行一个 JSON）：

| type | 字段 | 语义 | v1 对应 |
|---|---|---|---|
| `result` | `data` | 递交结果（可多次） | `postMessage({type:'result'})` |
| `done` | — | 本次执行结束（`run` 的唯一结束信号） | `done()` |
| `log` | `level`, `message` | 日志：`debug` / `info` / `warn` / `error` | `log()` |
| `progress` | `data` | 进度（宿主记 debug 日志） | `progress()` |
| `rpc` | `id`, `method`, `params` | 调用宿主（`storage` 等） | RPC 消息 |

宿主 → 插件（stdin）：

| type | 字段 | 语义 |
|---|---|---|
| `query` | `token`, `query` | `mode=search`：新查询（可打断上一次） |
| `rpc-result` | `id`, `ok`, `data?`, `error?` | RPC 应答 |
| `shutdown` | — | 宿主要求退出（插件应尽快 exit） |

**约定**：stdout 只能出现协议行（`log` 走协议，不要直接 print）；野 stdout 由宿主逐行尝试解析、失败转入日志（宽容处理，与 v1 `pipeOutput` 语义一致）；stderr 一律转发为 `warn` 日志。

**SDK API（Rust，与 v1 逐条对应）**

```rust
fn main() {
    launcher_plugin_sdk::run(|ctx| {
        match ctx.mode {
            Mode::Run => {
                let args = ctx.args::<MyArgs>()?;
                ctx.log("开始", json!({ "foo": 1 }), Level::Info);
                ctx.progress(0.4, json!({ "step": "halfway" }));
                ctx.done(json!({ "ok": true }))?;                        // = v1 done(x)
            }
            Mode::Search => ctx.on_query(|query| search(&ctx, query)),    // = v1 onQuery
        }
        Ok(())
    });
}
```

| v2（`launcher-plugin-sdk`） | v1（`@launcher/api-node`） | 说明 |
|---|---|---|
| `ctx.args` / `ctx.settings` / `ctx.data_path` / `ctx.plugin_id` / `ctx.mode` … | `ctx()` | 字段一一对应 |
| `ctx.done(x)` | `done(x)` | 写 `result` + `done` |
| `ctx.fail(err)` | `fail(err)` | 写 `{result, data:{__error}}` + `done`（宿主沿用 `isFailurePayload` 判定） |
| `ctx.log(msg, data, level)` / `ctx.progress(p, data)` | `log` / `progress` | |
| `ctx.on_query(cb)` | `onQuery(cb)` | 贡献型常驻循环（§9.2） |
| `ctx.storage.*` | `storage.*` | 走 `rpc` 往返，语义不变 |
| panic hook → `fail`（SDK 内建） | `onError()`（需显式调用） | |

**网络与代理**

逻辑层插件直接出网（子进程，无 CORS / CSP 限制，也不经过宿主），**代理要自己配** —— 系统代理与环境变量都不是 HTTP 客户端会自动读的。SDK 提供探测（`launcher_plugin_sdk::proxy::detect() -> Option<String>`，形如 `http://127.0.0.1:7897`）：

- 推荐用法：**先直连、连接类失败再降级到代理**（HTTP 状态码说明直连已经通了，不算失败）—— 直连快时不惊动代理，被墙时又能自动救回来；直连阶段给较短的连接超时（如 5s；**有兜底才敢这么压**，没探测到代理时保持原样），同一次执行里直连一旦失败，后续请求直接走代理
- 探测优先级：`HTTPS_PROXY` / `https_proxy` → `ALL_PROXY` / `all_proxy` → `HTTP_PROXY` / `http_proxy` → 系统设置（macOS `scutil --proxy`，HTTPS 代理优先、其次 HTTP；Windows 注册表 `Internet Settings`，`ProxyEnable` 为 1 时取 `ProxyServer`，支持 `http=…;https=…` 分列写法）
- **只认 HTTP 代理**：SOCKS（需客户端专门支持）与 PAC（要执行脚本）视作「没探测到」⇒ 直连（与历史行为一致）
- 平台限定逻辑（`scutil` / `reg query`）隔离在该模块内；其余平台只有环境变量一条路
- 参考实现：`internal-store` 的 `update` 命令（GitHub 更新源被墙时靠它连上）

**生命周期、超时与降级**

| 场景 | 行为 |
|---|---|
| `run` | spawn → 等 `done` → 回收（SIGTERM，2s 后 SIGKILL）；超时 `TIMEOUT`（默认 10s，上限 5min） |
| `search` | 常驻；每查询写一行 `query`；空闲 5 分钟回收；同插件并发上限 4、超限排队；插件激活后预热 |
| 崩溃 | 非零退出 → 失败计数 +1；连续 3 次 → 该命令 `degraded`（搜索结果静默置空，UI 不报错） |
| 孤儿 | 宿主退出时关闭所有子进程 stdin 并 kill；插件应处理 stdin EOF 自行退出（SDK 内建） |
| 输出过大 | 单行 > 1MB 截断并记 `warn`（防 OOM） |
| 权限 | 子进程权限 = 当前用户权限（与 v1 相同；不提供额外沙箱） |

---

## 5. 运行时环境

### 5.1 会话 URL 契约

```
http://127.0.0.1:<port>/index.html?sid=<uuid>&cmd=<command>&theme=dark|light&accent=%23rrggbb&token=<token>
```

| 参数 | 说明 |
|---|---|
| `sid` | 会话 id，用于日志与审计关联 |
| `cmd` | 当前 view 命令名 |
| `theme` | 宿主主题（`dark` / `light`） |
| `accent` | 宿主主题色（`#rgb` / `#rrggbb`，已 URL 编码）；非法时**应当**当没给，用内置值 |
| `token` | 每会话一次性 token，宿主 API 调用必须携带（SDK 已处理） |

**必须**：不要缓存/复用 `token`；不要把它写进日志或存储。

### 5.2 Origin 隔离

每个插件有**独立端口**（独立 origin）。因此：`localStorage` / `IndexedDB` / cookie 天然按插件隔离，**可以直接用**，但**持久化业务数据应当用 `ctx.storage`**（用户可见、可导出、跨端口稳定）。

### 5.3 主题

- 宿主通过 `?theme=` / `?accent=` 传入（**每次开会话都重新带**，代表宿主当前的外观），插件页在文档根设 `data-theme="dark|light"`
- **应当**按三级探测，`@launcher/ui/theme` 的 `useTheme()` 已实现，直接用即可：
  `?theme=` → `data-theme` → `prefers-color-scheme`
- **不应**在插件页内提供主题切换，也不应把主题写进 `localStorage`：**主题由宿主唯一裁决**。
  页内一旦能钉住主题，宿主换了它也不跟，而「哪个插件忘了跟」在界面上根本看不出来
- 只有来源是系统偏好时才跟随系统外观变化；宿主给了主题时不跟，否则插件页会和宿主界面不一致
- **主题切换对已打开的插件页不生效**：主题随会话 URL 一次性下发，宿主没有向已开 iframe 推送的通道。
  切换后**新开的**会话是新主题，**已开的那张页要重开才变**
- 主题色 `?accent=` 同理（跟随与否都只影响此后新开的会话）。它会被写进 CSS 变量，
  **必须**校验成 `#rgb` / `#rrggbb` 再用，非法值一律当没给

#### 5.3.1 颜色：全局语义色与插件专有色

`theme.css` 是插件页颜色的唯一入口：**引了它就有整套语义色，深浅两态自动切换，不需要自己写深色模式。**

| 类别 | 归谁 | 要求 |
|---|---|---|
| 全局语义色 `--launcher-*`（bg / panel / fg / muted / line / hover / accent / danger / success / warn / 滚动条 / 阴影） | 底座维护 | 插件只读；要整体覆盖时**明暗两值必须成对给出**，不允许只改浅色那半边 |
| 插件专有色（语法高亮、块色号这类只有本插件懂的语义） | 插件维护 | **一个语义一行、明暗成对** |
| 与主题无关的装饰色（半透明叠加、遮罩渐变等 alpha 派生色） | 插件维护 | 单值即可，**应当**注明「深浅通用」的理由 |

成对写法 —— `theme.css` 提供 `--launcher-if-light` / `--launcher-if-dark`（深色主题下两者互换），
插件写一行即可，**不要写 `:root` + `[data-theme="dark"]` 两个块**：分开写迟早漏改深色那半边。

```css
:root {
  --my-key: var(--launcher-if-light, #1d4ed8) var(--launcher-if-dark, #82b1ff);
}
```

**不应**在样式规则里直接写 hex / rgba 字面量：那个值在另一个主题下不会变，
而漏改在界面上只看得见「这个颜色怪」。

**深浅主题的兼容性判定**（与 UI 是不是自己画的无关）：①引了 `theme.css`
②页面上所有颜色都来自 `var()`（无裸字面量）③自新增变量已按上表归类。
三条全满足即自动跟随，**不需要为深色模式写任何代码**。

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

### 6.4 更新（远程更新通道，v1）

出厂插件可被 `extensions/<id>/` 下的新版本覆盖（内核 `scan()`）：

| 出厂 bundle 有该 id | 出厂声明 `essential` | `extensions/` 有同 id | 结果 |
|---|---|---|---|
| 是 | `true` | 有 | **忽略 extensions 版本**（底座基础能力不可被外部内容顶替），记 warn |
| 是 | `false` / 省略 | 有 | 用 extensions 目录；`builtin` 仍为 **true**（不可卸载、可禁用） |
| 是 | — | 无 | 用 bundle |
| 否 | — | — | 用 extensions（第三方插件） |

- `essential` 只认**出厂 bundle 的清单**（身份表）：被覆盖的版本即便在清单里写 `essential: true` 也拿不到「不可禁用 + 免审计」。
- 覆盖目录的清单读不出 / 非法 / 平台不匹配 ⇒ 回落到出厂版本（一次坏下载不能让插件变成「没有」）。
- 安装（含覆盖）是**原子替换**：`staging → 停用（Reload 语义）→ 旧版本整目录备份到 `.backup/<id>/<版本> → rename 落地 → 重新装载`；装载失败自动回滚并报 `UPDATE_FAILED`。
- 更新只替换**安装目录**；插件设置 / 别名覆盖 / 历史 / 固定项都按 id 寻址，天然保留（N1 / N2 的直接推论）。
- 出厂插件不可卸载，等价动作是管理动作 `revertToBuiltin`（删除覆盖 + 回到 App 自带的那份）。

**内核更新（`applyKernelUpdate`，2026-09-18 起）**：内核自身的更新与插件同构 —— 下载在插件、应用由内核裁决：

| 环节 | 规格 |
|---|---|
| 来源 | 固定 tag **`kernel-latest`** 的 Release：`kernel-registry.json` + `launcher-kernel-<版本>-<平台>-<架构>.zip`（与 App 的 `v*`、插件的 `plugins-latest` 三方独立） |
| 包结构 | zip 根 = `launcher-kernel(.exe)` + `ui/`（**UI 与内核同包**：只换内核会出现「新内核 + 旧 UI」） |
| 下载/校验/解压 | `internal-store` 的逻辑层命令（`check-kernel` / `download-kernel`）；解压时恢复可执行位、防路径穿越、校验结构 |
| 应用 | view 调 `ctx.settings.pluginAction('applyKernelUpdate', { path, uiPath?, version?, restart? })`（仅 `internal-` 前缀可用）：内核 `--hot-probe` 自检 → 备份 → 原子替换（内核与 UI 一起，失败一起回滚）→ 优雅重启（壳拉起新二进制；连续两次启动未就绪自动回滚） |
| 版本门槛 | 索引带 `minHotVersion`：客户端热更新机制低于它 ⇒ 界面提示但不给「更新」按钮 |
| 打包版 | 内核从 `.app` 复制成**数据目录里的外置副本**后启动（壳负责，App 版本变化时重投），替换不触碰代码签名 |

**应用（壳）自更新（`applyShellUpdate`，2026-09-19 起）**：壳（应用本体）的更新与内核同构，但替换对象是整个 `.app`：

| 环节 | 规格 |
|---|---|
| 来源 | 固定 tag **`app-latest`** 的 Release：`app-registry.json` + `Chassis-<版本>-macos-<架构>.zip`（与 App 的 `v*` / `plugins-latest` / `kernel-latest` 四方独立） |
| 包结构 | zip 根 = `Chassis.app/Contents/…`（整包；解压侧校验壳二进制与 `Info.plist`） |
| 下载/校验/解压 | `internal-store` 的逻辑层命令（`check-app` / `download-app`）：sha256 + 防路径穿越 + 恢复可执行位 |
| 应用 | view 调 `ctx.settings.pluginAction('applyShellUpdate', { appPath })`（仅 `internal-` 前缀可用）：壳跑 `--hot-probe` 自检 → 写台账 → 交独立 helper 替换 `.app` → **整个应用重启**（内核随之重启；连续两次启动未就绪自动回滚） |
| 检查与提示 | 内核守护只跑「检查」一段（启动 90s 后 / 每 6h，`config.autoUpdateCheck` 控制）：新版本进托盘菜单与「关于」页提示；下载 / 替换 / 重启由用户确认后触发（`pluginAction('applyAppUpdate')`）。界面用 `pluginAction('shellInfo')` 拿壳版本与 `canSelfUpdate` |
| 平台 | **macOS 与 Windows 都支持**：macOS = 候选 `X.app`、Windows = 绿色版目录（`Chassis.exe` + `resources/`），替换都由独立 helper 在进程完全退出后执行（`swap.sh` / `swap.ps1`）；形态与校验口径见 `docs/shell-hot-update.md` §1 |
| 版本门槛 | 索引带 `minShellHotVersion`：壳自更新机制低于它 ⇒ 界面提示但不给「更新」按钮 |

**资产保留策略（三条固定 tag 通道共同）**：发布收尾**只保留索引指向的最新资产** —— CI 在
`action-gh-release` 之后跑 `scripts/prune-release-assets.mjs`，删掉同一个 Release 里索引不再指向的 `.zip`
（zip 文件名带版本号、覆盖上传只认同名 ⇒ 旧包会变成孤儿；单 Release 上限 1000 个资产，攒满后发布会中断）。
客户端下载 URL 全部来自索引，索引里没有的 zip 没有合法消费方，删除不影响已安装客户端。

---

## 7. 宿主 API（UI 侧）

### 7.1 用法

```ts
import { host, storage, hostUi, exec, shell, clipboard, notify } from '@launcher/api'

const inLauncher = host.isLauncher()        // 同步判断，用于降级分支
const info = await host.info()              // { version, hotVersion, platform, dataRoot, pluginId, command, sid }
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
| `host.info()` | — | — | `{ version, hotVersion, platform, dataRoot, pluginId, command, sid }`（`hotVersion` = 内核热更新机制版本，0.1.0 起；更新器用它判断内核更新包装不装得上） |
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
| `clipboard.watch` | 订阅系统剪贴板**变化事件**（不带内容，见 §8.1） | 中 | 是 |
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

### 8.1 `clipboard.watch` 的驱动方式（事件 → 命令）

剪贴板历史这类插件要的是「用户复制了东西」这个**事件**，而插件进程是按需 spawn 的（搜索源还会被空闲回收），
自己常驻监听并不可靠 —— 所以监听放在**常驻的壳**里，插件只在事件到达时被拉起一次：

```text
系统剪贴板变化 ──▶ 壳（AddClipboardFormatListener / WM_CLIPBOARDUPDATE）
                    │ 通知 clipboard/changed { changeCount, kinds }（不带内容）
                    ▼
                 内核：找出声明了 clipboard.watch 且处于 active 的插件
                    │ exec.run(pluginId, 'record', { changeCount, kinds })
                    ▼
                 插件的 record 命令（script）：自己读剪贴板 → 入库 → done → 进程回收
```

契约要点：

- **命令名固定 `record`**，必须是 `mode: "script"`（不出现在搜索结果里，只能被宿主调用）。缺这条命令 ⇒ 内核记 warn 并跳过该插件。
- 通知**不带内容**：内容由 `record` 命令自己按平台读（Windows 直读 `CF_UNICODETEXT` / `CF_DIB(V5)` / `CF_HDROP`）。
  这样做的原因：图片经「壳 → 内核 → 插件」三跳 IPC 传 base64 是纯浪费，而读取本身是这个插件的能力。
- `changeCount` 是系统剪贴板序号（`GetClipboardSequenceNumber`），**插件侧按它去重**：同一序号只处理一次。
- `kinds` 取值 `text`（`CF_UNICODETEXT`）/ `image`（`CF_DIB` / `CF_DIBV5`）/ `file`（`CF_HDROP`）/ `unknown`（本次没抢到剪贴板所有权）。
  它只是**提示**：插件仍应自己读一遍，读不到就静默跳过（不报错）。
- 调用是一次性的（`run` 语义：spawn → done → 回收，默认 10s 超时），**不受**搜索源 5 分钟空闲回收影响；
  连续失败 3 次按 §6.1 判 `degraded`。
- 插件自己写回剪贴板（「粘贴历史条目」）**也会触发**一次变化 —— 由插件侧去重（内容 hash 合并 / 记录自己刚写过的序号），
  底座不替插件判断。
- **降级路径必写**：平台不支持（非 Windows）时壳返回 `{ ok:false, reason:'unsupported' }`，内核不订阅；
  插件必须能在「从未收到事件」的情况下仍然可用（至少保留手动同步入口）。
- 声明该能力的插件默认**不写最近使用**（建议同时声明 `history: false`）：它不是用户主动触发的入口。

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
- **v2 载体**：贡献型命令是常驻子进程（`mode=search`），宿主下发 `{type:'query',token,query}`、插件回 `{type:'result',token,data}`（逻辑层 SDK 映射见 §4.4；视图层 `search.onQuery` 不受影响）

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
| `Esc` | 先关插件内的弹层/面板（自己画的弹层要 `preventDefault()`；`UiDialog` / `UiSelect` 已内建）；都没人消费时回到搜索态 —— SDK 自动交还宿主，等价 `commands.close()` |
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
- 启动台内置了一份常用 lucide 图标子集（`packages/ui/lib/icons.ts`，宿主网格与设置页插件列表共用这一份）；名字写法不敏感（`git-compare` 与 `GitCompare` 等价）
- **不在子集内的名字会退化成「名称首字母」占位方块**（不报错）；需要新图标就往那份字典里加一条（数据取自 lucide，许可见 `docs/THIRD-PARTY.md`）

### 10.5 i18n

v1 只要求：所有面向用户的字符串集中在 `src/locales/zh-CN.ts`（便于后续加语言），**不得**硬编码散落在模板里。

---

## 11. 版本与兼容

| 规则 | 内容 |
|---|---|
| `apiVersion` | 字符串主版本。底座接受 `"1"` 与 `"2"`：`"2"` = 逻辑层产物为**可执行文件**（当前规范）；`"1"` = 逻辑层产物为 `.mjs` —— **v2 底座不再支持 v1 的逻辑层产物**（机器上没有任何 JS 执行路径）：这类命令加载时明确报「需升级为可执行产物」。`"1"` 的 **view 命令不受影响**（视图层协议未变，见 §4.1 / §7） |
| 能力只增不减 | 同一 `apiVersion` 内不得删除/重命名 capability 与 API；新增为 minor |
| 弃用流程 | 标注 `@deprecated` → 至少保留一个 minor → 下一个主版本移除（写入 changelog） |
| 插件版本 | 插件自身 semantic versioning；底座在设置页展示"插件声明需要 apiVersion X，当前底座支持 Y" |

---

## 12. 开发与调试

本仓库的插件都是 pnpm workspace 成员，命令在**仓库根**执行（插件自己的脚本用 `--filter`）：

```bash
pnpm install
pnpm --filter <name> dev        # vite dev server（浏览器直接调 UI；宿主能力走降级分支）
pnpm --filter <name> build      # 产出 dist/（index.html + assets + 可执行产物 <name> + 裁剪后的 package.json）
pnpm --filter <name> typecheck
pnpm build:plugins              # 构建全部出厂插件（含各自 cargo build --release）
pnpm spec-check [name]          # 规范自检（清单 / 产物 / 能力 / 数据目录 / N1 / N2 / N3）
pnpm pack:plugins               # 打 zip 到 plugins/release/
pnpm test                       # 全量测试（含各插件的 core·view 用例）；逻辑层 Rust 测试在插件目录 cargo test
```

- **dev 注册**：`pnpm dev:kernel` 起内核（本机 control 端口 + 一次性 token），插件 dev server 把 `devUrl` 挂上去，插件页直接指向 vite ⇒ 免重启热更新
- **DevTools**：设置 → 插件 → 打开 DevTools（开发构建可用）
- **调试日志**：`host.log('info', '...')` 会进审计日志，设置页可实时查看
- **新建插件**：`pnpm create:plugin <id> [--mode view|script|full]` 一条命令生成工程骨架（`packages/plugin-cli`）——清单经 `@launcher/plugin-manifest` 真校验器把关，含逻辑层时自动登记根 `Cargo.toml` members。想手改就照抄现有插件：Vue 工程看 `plugins/totp`（view + script + 对话框）与 `plugins/host-manager`（提权写系统文件、只改自己的托管区），配置模板见 `docs/plugin-dev-guide.md` §4 与 `.codebuddy/skills/chassis-plugin-dev/references/scaffold-templates.md`

---

## 13. 接入检查清单（提交前逐条确认）

**清单**
- [ ] `name` / 命令 `name` 符合正则；插件内唯一
- [ ] `apiVersion: "2"`（新插件）；`type: "module"`
- [ ] `capabilities` 与实际调用完全一致（`spec-check` 无差集）
- [ ] 每个命令有 `title`；逻辑层命令的 `name` 等于产物文件名
- [ ] `searchable` / `contributes` 按 §9.1 选对，`placeholder` 已写
- [ ] 只在单一平台可用 ⇒ 声明 `platforms` / `arch`（§3.5）；声明了 `clipboard.watch` ⇒ 有 `record` 命令与「收不到事件也能用」的降级路径（§8.1）
- [ ] 声明了 `session` ⇒ 三条命令都是 `script` 且真实存在；`status` 在会话结束时如实回报 `active: false`（§3.6）

**产物**
- [ ] `dist/index.html` + `assets/` 存在，资源路径相对（`base: './'`）
- [ ] 每个 no-view/script 命令有独立**可执行产物** `dist/<name>`（Windows `.exe`）；`file` 确认可执行格式
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
| §3.6 `session` 引用（命令存在 / 是 `script` / 至少一个动作） | 加载时 | 拒绝加载 + 设置页显示原因 | `MANIFEST_INVALID` |
| §3.6 会话区状态（`active` / `activeMs` / `paused`） | 运行期 | 每 2 拍拉起一次 `status`；非 `active` ⇒ 撤掉会话区；命令失败 ⇒ 撤掉并记日志 | — |
| N1 产物名一致（可执行产物存在） | 加载时 | 该命令标记 `error`，其余命令照常 | `ENTRY_MISSING` |
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
├── Cargo.toml                  → 逻辑层 crate（crate 根 = 插件目录）
├── src/main.ts                 → 视图层（Web）
└── src/main.rs                 → 逻辑层可执行产物 dist/greet（见 §4.4）
```

```jsonc
// package.json
{
  "name": "hello",
  "title": "你好",
  "version": "0.1.0",
  "type": "module",
  "apiVersion": "2",
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

```rust
// src/main.rs（逻辑层入口：[[bin]] name = greet；crate 根 = 插件目录）
use launcher_plugin_sdk::{json, Level};

fn main() {
    launcher_plugin_sdk::run(|ctx| {
        ctx.log("greet 开始", json!({ "dataPath": ctx.data_path() }), Level::Debug);
        ctx.progress(0.5, json!(null));
        let args = ctx.args::<serde_json::Value>()?;
        ctx.done(json!({ "hello": args.get("name").and_then(|v| v.as_str()).unwrap_or("world") }))?;
        Ok(())
    });
}
```

---

## 附录 B：术语

| 术语 | 含义 |
|---|---|
| capability | 插件申请使用的宿主能力，必须在清单声明 |
| 视图层插件 | `view` 命令：Vue 页面，跑在宿主 WebView 的 iframe 里 —— 始终是 Web 技术，不受 v1 / v2 影响 |
| 逻辑层插件 | `no-view` / `script` 命令：v2 起为独立可执行文件（宿主 spawn + NDJSON，§4.4） |
| 入口型搜索 | `searchable: true`，命令本身参与搜索 |
| 贡献型搜索 | `contributes: true`，插件在搜索过程中返回结果项 |
| dataPath | `<dataRoot>/plugins/<pluginId>/`，插件唯一可写目录 |
| disposer | 注册时返回的清理函数，停用/重载时按逆序调用 |
| 会话（session） | 一次 view 命令的打开实例，由 `sid` 标识 |
| 出厂身份表 | 内核从出厂 bundle 清单读出的 `id → essential`，判定「谁是底座基础能力」的唯一真源 |

---

## 附录 C：更新源（`registry.json`）

远程更新通道的索引格式（schema 1）。**由 `internal-store` 消费**，内核不认识它（内核零能力：只接受一个本地 zip 路径）。

```jsonc
{
  "schema": 1,                       // 未知 schema ⇒ 客户端拒绝（不猜测）
  "generatedAt": "2026-09-18T12:00:00Z",
  "plugins": {
    "totp": {
      "title": "双重验证器",
      "version": "0.5.0",            // semver，来自产物清单
      "apiVersion": "2",
      "minKernel": null,             // 可选：低于此内核版本不给出「更新」按钮
      "notes": "修复倒计时漂移",      // 可选：展示在更新页
      // 一个平台一份产物（逻辑层是原生产物，不可能跨平台共用）
      "assets": [
        {
          "platforms": ["macos"],    // 省略 / 空数组 = 不限制（与 §3.5 同义）
          "arch": ["arm64"],
          "url": "https://github.com/<owner>/<repo>/releases/download/plugins-latest/totp-0.5.0-macos-arm64.zip",
          "sha256": "…64 位十六进制…",
          "bytes": 808995
        }
      ]
    }
  }
}
```

契约要点：

- **schema 稳定**：字段只增不改；`schema` 不认识 ⇒ 拒绝整份索引（不挑字段读）。
- `sig` 字段为**预留**（后续版本的签名，`null` 表示未启用）。v1 的信任模型是「固定仓库 + HTTPS + sha256」。
- 客户端**只接受插件 id 作为入参**，下载地址一律从本索引取 —— URL 不可被外部注入。
- 索引与产物发布在**固定 tag**（`plugins-latest`）的 Release 上；各平台各发一份 zip，sha256 必须逐字节一致于构建产物。
- **主源 + 国内镜像**：客户端对索引里的每个 URL 同时推导镜像地址（`github.com/triple3h/Chassis` → `gitee.com/triple3h/Chassis`，大小写不敏感 —— CI 用 `GITHUB_REPOSITORY` 拼索引）并**先试镜像**；镜像拿不到（连不上 / HTTP 错 / sha256 不符）或校验不过再回落主源，两级都失败才报错。索引本身同样镜像优先。镜像由 CI 的 `scripts/sync-release-to-gitee.mjs` 同步（同名 tag / 同名文件名），两个地址都是编译期常量 —— 仍然「不接受自定义源」。
- **索引永远整份发布**：单独发某个插件（workflow 的 `plugins` 输入）时，`gen-plugin-registry.mjs --merge-registry <上一版 registry.json>` 负责合并 —— 没打包的插件整条沿用上一版（版本 / 说明 / 门槛 / 资产都不动），打包的插件按平台替换资产、未重建平台的资产只在版本一致时保留（版本变了就丢弃 + 告警，避免客户端装到旧版本）。少了这一步，索引里只剩本次打包的插件，其余插件对客户端等于「不存在」（`collect_plugins` 查不到即跳过，静默不再提示更新）。守卫见 `tests/unit/plugin-registry-merge.test.ts`。
- essential 出厂插件（app-launcher / file-search / internal-settings）**不在索引里**：它们随 App 包发布。
