# 首批插件接入计划（4 个现有插件）

> 日期：2026-09-14 ｜ 依托规范：`docs/plugin-spec.md` ｜ 依托底座：`docs/launcher-requirements.md`
> 目标：这 4 个插件是插件接入规范 v1 的**首批实现**，同时在如快 Sofast 里**不回归**。

## 0. 一句话策略

**不分叉插件，只升级适配层。** 4 个插件的业务代码（`src/core/`、`src/App.vue` 的逻辑）**零改动**；改动集中在三处：`shared/lib/platform.ts`（UI 侧宿主适配）、新增 `shared/lib/host-node.ts`（脚本侧宿主适配）、`package.json` 清单（补 `apiVersion` + `capabilities`）。hosts 插件额外要做一次数据目录迁移。

---

## 1. 现状实测（今天刚核过）

| 插件 | 命令 | UI 侧实际用到的宿主能力 | 脚本侧 | 可变数据落哪 |
|---|---|---|---|---|
| `totp` | `totp`(view, searchable) + `read-image`(script) | `storage`、`exec.run`(=runScript)、`screenshot`、`hostUi`(搜索框 + setFooter) | `ctx/done/log/onError`，读 `pluginPath` | 宿主 LocalStorage → `<插件目录>/data/storage.json`；vault 密文同处 |
| `hosts` | `hosts`(view, searchable) + `hosts-read` / `hosts-write`(script) | `storage`、`hostUi` | `ctx/done/log/onError`，读 `pluginPath` | 快照走宿主 LocalStorage；**hosts 备份写 `<插件目录>/data/backups`** ❌ |
| `text-diff` | `diff`(view, searchable) | `hostUi` | — | 无 |
| `json-tools` | `json`(view, searchable) | `hostUi` | — | 无 |

四个插件**都是入口型搜索**（`searchable: true`，命中命令后把输入流给插件页），没有一个是贡献型 —— 说明 v1 的两种搜索模式都得先在底座里实现，但首批只用得上入口型。

---

## 2. 差距清单（对照规范）

| # | 差距 | 涉及插件 | 规范条目 | 严重度 |
|---|---|---|---|---|
| G1 | 清单缺 `apiVersion` / `capabilities` | 全部 4 个 | §3.1 / N3 | 必须（否则新底座拒绝加载） |
| G2 | UI 侧写死 `@sofastapp/api` | 全部 4 个 | §7.4 降级要求 | 必须（否则只认如快） |
| G3 | 脚本侧写死 `@sofastapp/api/node` | totp / hosts | §7 / N1 | 必须 |
| G4 | **备份与待生效文件写在安装目录** | hosts | **N2** | 必须（升级插件会覆盖用户备份） |
| G5 | 存储位置由如快决定（插件目录内） | totp / hosts | §5.2 / N2 | 应当（新底座走 appData，需一次性迁移） |
| G6 | 无 `spec-check` 自检，N1/N2/N3 靠人肉 | 全部 | §13 | 应当 |
| G7 | 无 `contributes` 能力（都是入口型） | 全部 | §9 | 可选（首批不需要） |
| G8 | i18n 字符串散落 | 全部 | §10.5 | 可选（v1 不阻塞） |

---

## 3. 适配层设计（本计划的全部关键）

### 3.1 UI 侧：`shared/lib/platform.ts` 升级为双宿主适配

现有实现已是"动态 import + 超时 + 哨兵值"的形态，只需在 `loadApi()` 里加一条分支：

```ts
// 伪代码：宿主探测顺序 launcher → sofast → none
async function loadHost(): Promise<HostAdapter | null> {
  const launcher = await import('@launcher/api').catch(() => null)
  if (launcher?.host?.isLauncher?.()) return wrapLauncher(launcher)   // 新底座
  const sofast = await import('@sofastapp/api').catch(() => null)
  if (sofast?.inSofastIframe?.()) return wrapSofast(sofast)           // 如快
  return null                                                          // 浏览器 dev
}
```

对外导出的函数签名**保持不变**（`storage` / `runScript` / `triggerScreenshot` / `setFooter` / `getSearchContent` / `watchSearchContent` / `clearSearchContent` / `setSearchContent` / `inHost`）。4 个插件的 `App.vue`、`core/*.ts` 一行不用改。

要点：
- 两个 SDK **都必须动态 import**（静态导入会让浏览器 dev / 另一宿主直接炸）
- `@launcher/api` 作为 `optionalDependencies` 或 `devDependencies` 引入；构建时若未安装，`import()` 会被打包器保留为可选依赖（需在 vite 配置里 `external` 或在 try/catch 中动态拼接路径）
- 探测结论缓存（现有 `inHostCache` 机制沿用），避免每次调用都探测

### 3.2 脚本侧：新增 `shared/lib/host-node.ts`

**关键发现**：如快与底座在 Node Worker 侧的协议**完全相同**（`workerData = { command, args, pluginPath }`；`parentPort.postMessage({type:'log'|'progress'|'result'|'done'})`）。所以不必依赖任何 SDK —— 直接实现这 30 行协议，脚本就**天生双宿主兼容**，并可去掉 `@sofastapp/api/node` 依赖。

```ts
// shared/lib/host-node.ts（脚本侧唯一入口）
export function ctx() {
  const wd = workerData as { command: string; args?: unknown; pluginPath?: string; dataPath?: string; dataRoot?: string }
  const pluginPath = wd.pluginPath?.trim() || process.cwd()
  return {
    command: wd.command,
    args: wd.args,
    pluginPath,                                   // 只读安装目录（新底座下禁止写入）
    dataPath: wd.dataPath ?? path.join(pluginPath, 'data'),  // ← 这一行同时兼容两个宿主
    dataRoot: wd.dataRoot ?? path.dirname(pluginPath),
  }
}
export const log = (message, data?, level: 'info'|'debug'|'warn'|'error' = 'info') =>
  parentPort?.postMessage({ type: 'log', level, message, data })
export const progress = (p, data?) => parentPort?.postMessage({ type: 'progress', p, data })
export const done = (result) => { parentPort?.postMessage({ type: 'result', data: result }); parentPort?.postMessage({ type: 'done' }) }
export const fail = (error) => { parentPort?.postMessage({ type: 'result', data: { __error: String(error) } }); parentPort?.postMessage({ type: 'done' }) }
export const onError = () => { process.on('uncaughtException', (e) => fail(e)); process.on('unhandledRejection', (e) => fail(e)) }
```

- `dataPath` 的兜底（`pluginPath/data`）就是**如快下的旧行为**，所以 hosts 的备份在如快里位置不变、在新底座里自动落到 appData —— **N2 一次修好，两边都对**。
- 三个脚本文件（`totp/src/no-view/read-image.ts`、`hosts/src/no-view/hosts-read.ts`、`hosts-write.ts`）只改 import 行 + 把 `pluginPath` 换成 `dataPath`。

### 3.3 为什么不分叉

| 方案 | 代价 | 结论 |
|---|---|---|
| 分叉成 `launcher-*` 与 `sofast-*` 两套 | 4 个插件 × 2 份维护；修 bug 要改两遍；测试翻倍 | ❌ |
| 适配层单份代码，双宿主运行 | 一个文件 + 清单字段；已有 90+63 条单测全部继续有效 | ✅ |

---

## 4. 分阶段执行

### 阶段 0 —— 现在就能做（不依赖底座，零破坏）

| # | 任务 | 产出 | 验收 |
|---|---|---|---|
| 0.1 | `shared/lib/platform.ts` 加双宿主分支，导出签名不变 | 改造后的适配层 | 4 个插件在如快里**行为完全不变**（回归测试通过） |
| 0.2 | 新增 `shared/lib/host-node.ts`；3 个脚本改 import；`pluginPath` → `dataPath` | 脚本侧适配层 | `npm test` 全绿；如快里 hosts 读写/备份照常 |
| 0.3 | 4 份清单补 `apiVersion: "1"` + `capabilities`（见 §5 表） | `package.json` | 如快仍能加载（未知字段应被忽略；若宿主严格校验，则在构建期产出两份清单，源清单为超集） |
| 0.4 | 新增 `scripts/spec-check.mjs`（见 §6） | 自检工具 | 4 个插件全部通过；故意漏声明一个 capability 能被抓出来 |
| 0.5 | 更新注释与文档（`vault.ts` / `store.ts` 里"存储落在插件目录"的说明） | | 文档与实现一致 |

**阶段 0 不碰任何 `src/core/` 与 `src/App.vue` 的业务逻辑。**

### 阶段 1 —— 底座 M1 就绪后（view 型插件跑通）

| # | 插件 | 验收（在新底座上） |
|---|---|---|
| 1.1 | `json-tools` | 搜"JSON"命中 → Enter 打开 → 粘贴 → 格式化/压缩/树视图正常；`hostUi` 的搜索框读写与 footer 正常；无 capability 缺失告警 |
| 1.2 | `text-diff` | 同上；Worker 内差分正常；生产构建资源路径正确（静态服务器验证） |
| 1.3 | 内核侧 | 未声明的 capability 调用 → 方法不存在 + 审计有记录；禁用/启用插件无残留 |

顺序理由：这两个插件只用 `hostUi`，是**最小可用的协议验证器**，桥通了再往上加能力。

### 阶段 2 —— 底座 M2 就绪后（能力型插件跑通）

| # | 插件 | 验收（在新底座上） |
|---|---|---|
| 2.1 | `totp` | `storage` 读写 + 口令加密解锁；`screenshot` 触发；`exec.run('read-image')` 返回结果；扫码导入全链路 |
| 2.2 | `hosts` | `hosts-read` / `hosts-write` 跑通；提权时由**底座 pre-execute 中间件**弹确认；备份落在 `<dataRoot>/plugins/hosts/backups`；**旧备份目录一次性迁移** |
| 2.3 | 数据迁移 | 首次在新底座加载时：旧 `<插件目录>/data/storage.json` → `<dataRoot>/plugins/<id>/storage.json`；迁移失败不阻塞（只告警） |

---

## 5. capability 声明（按实测调用给出，实施时用 `spec-check` 复核）

| 插件 | `capabilities` | 依据 |
|---|---|---|
| `json-tools` | `["hostUi"]` | 只用搜索框 / footer |
| `text-diff` | `["hostUi"]` | 同上 |
| `totp` | `["storage", "hostUi", "screenshot", "exec.spawn"]` | `storage`（账户/设置/口令密文）、`hostUi`、`triggerScreenshot`、`runScript('read-image')`；剪贴板走 DOM `paste` 事件，**不需要** `clipboard.read` |
| `hosts` | `["storage", "hostUi", "exec.spawn"]` | 快照持久化、搜索框 / footer、`hosts-read` / `hosts-write` |

> 原则：**只声明实际用到的**。多声明会被评审拒收，也会让安装时的权限提示失去可信度。

---

## 6. `scripts/spec-check.mjs`（新增自检工具）

对每个插件目录运行，输出差异清单并以非零码退出：

| 检查 | 实现 | 对应 |
|---|---|---|
| 清单字段完整性 | 读 `package.json`，校验 §3.1 / §3.2 的必须字段与正则 | G1 |
| **capability 双向核对** | 扫 `src/**` 里 `platform.ts` / `host-node.ts` 的导出函数调用 → 反查所需 capability，与清单声明取差集（漏声明 / 多声明都报） | N3 |
| **N1 产物名一致** | 读 `dist/*.mjs` 文件名，与 `commands[].name` 比对；`grep -h '^import' dist/*.mjs` 只允许 `node:*` | N1 |
| **N2 数据目录** | 扫 `src/**` 里 `pluginPath` 的写操作（`writeFile` / `mkdir` / `rename` / `copyFile`）→ 报违规 | N2 |
| N3 未声明能力 | 同上 | N3 |
| 产物齐备 | `dist/index.html`、`assets/`、`dist/package.json` 只含 §3 字段 | §2.2 |
| 远程资源 | 扫产物里 `http(s)://` 外链（图标 / wasm / CDN） | §5.4 |

> 这个工具是**规范可执行化**的关键：没有它，§13 的检查清单一定会随着时间腐化。

---

## 7. 验收总表（首批完成的定义）

| 项 | 通过标准 |
|---|---|
| 如快侧零回归 | 4 个插件在如快里功能与行为与今天完全一致（含 hosts 备份位置不变） |
| 新底座侧可用 | 阶段 1 / 阶段 2 的逐条验收全部通过 |
| 规范自检 | 4 个插件 `spec-check` 全绿 |
| 单测 | 现有 90（TOTP）+ 27（diff）+ 25（json）+ 63（hosts）条测试全绿，新增适配层单测 ≥ 10 条 |
| 规范反馈闭环 | 实施中发现规范表达不了的诉求 → 先改 `docs/plugin-spec.md` 再改代码（规范是唯一契约） |

---

## 8. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 如快宿主对未知清单字段严格校验 | 加了 `apiVersion` / `capabilities` 后如快拒绝加载 | 阶段 0.3 先在真机上验一个插件；不行则在构建期产出"如快版"与"底座版"两份清单（源清单为超集，`manifest-plugin.mjs` 按 `SOFAST_TARGET` 裁剪） |
| `@launcher/api` 尚未发布 | 阶段 0 的 UI 适配层无法联调 | 用 `tests/fixtures/mock-launcher-api` 假 SDK 做单测；真联调放阶段 1 |
| 适配层引入行为差异（超时/返回值语义） | 如快侧出现边缘 bug | 适配层保持现有超时值与哨兵值逻辑不动，只换底层调用；为两个宿主各写一份等价性单测 |
| hosts 备份迁移出错 | 用户丢备份 | 迁移采用"复制不删除"+ 校验文件数；失败只告警不阻塞；保留旧目录直到用户手动清理 |
| 底座 M1/M2 延期 | 阶段 1/2 无限期挂起 | 阶段 0 独立交付且立即产生价值（规范 + 适配层 + 自检工具），不阻塞 |

---

## 9. 实施记录（2026-09-14）

**结论：阶段 0 全部完成；阶段 1 / 阶段 2 的自动化部分在真底座上跑通**（`node scripts/smoke-first-batch.mjs`，20 项断言全绿）。

### 9.1 阶段 0（插件仓库 `SofastPlugins`）

| # | 交付 | 位置 |
|---|---|---|
| 0.1 | 双宿主适配层，导出签名不变 | `shared/lib/platform.ts`（宿主探测）+ `host-adapter.ts`（两套 SDK → 一个 HostBridge）+ `host-calls.ts`（超时 / 哨兵值 / localStorage 兜底） |
| 0.2 | 脚本侧适配 + N2 | 新增 `shared/lib/host-node.ts`；`read-image` / `hosts-read` / `hosts-write` 改用它；hosts 的备份与待生效文件从 `<插件目录>/data` 挪到 `ctx().dataPath`（如快下位置不变，新底座落 `dataRoot`） |
| 0.3 | 4 份清单补 `apiVersion: "1"` + `capabilities` | `scripts/manifest-plugin.mjs` 的裁剪字段同步（否则 `dist/package.json` 缺字段，底座拒绝加载） |
| 0.4 | `scripts/spec-check.mjs` | 清单字段 / N1 产物名与自包含 / N2 数据目录 / N3 能力双向核对 / 产物齐备 / 远程资源；反向验证过「漏声明」「多声明」「写 pluginPath」都能抓出来 |
| 0.5 | 注释与文档 | `store.ts` / `vault.ts` / 两个对话框文案 / `CODEBUDDY.md`（新增脚本 + 双宿主章节 + 两条硬约束） |
| 额外 | 适配层单测 ≥ 10 条 | `shared/test/{host-adapter,host-calls}.test.ts`（24 项）+ `scripts/run-shared-tests.mjs` |

### 9.2 底座侧（本仓库）—— 让首批插件真能用所必需

| 改动 | 原因 |
|---|---|
| `scripts/smoke-first-batch.mjs` | 首批插件的端到端冒烟：真内核 + 真插件，HTTP 驱动（不起壳、不用浏览器） |
| `PluginManager` 接上 `PluginStorage.migrateLegacy`（`plugin.ts` / `kernel.ts`） | §4 阶段 2.3 承诺过的迁移**从未接线**：旧 `<插件目录>/data/storage.json` 一直没人搬 |
| `PluginView` 丢弃 SDK 多发的平铺副本（`lib/bridge-calls.ts`） | SDK 为兼容旧宿主每次调用双发信封，平铺那条必然 `NOT_FOUND` ⇒ 每次调用多一条失败审计 |
| `tests/helpers/harness.ts` 新增 `seed` | 迁移必须发生在**装配期**，测试要能在启动内核前种下旧数据 |
| `tests/contract/storage-migration.test.ts`、`tests/unit/bridge-calls.test.ts` | 上面两处改动的回归 |
| `docs/plugin-spec.md` 三处补注 | 规范没表达清楚的三件事（见 9.3） |

### 9.3 与计划的偏差（规范反馈闭环）

1. **「Node 协议完全相同」是错的**（计划 §3.2）—— `progress` 字段名（`progress` vs `p`）、`fail` 信封
   （`{type:'error'}` vs `{type:'result',data:{__error}}`）、`done(undefined)` 行为都不同（实测 `@sofastapp/api@0.0.3`）。
   `host-node.ts` 改为同时发两套；plugin-spec §11 已补对照表。
2. **宿主探测不能只判 `isLauncher()`**（计划 §3.1 的伪代码）—— 如快的 `inSofastIframe()` 在底座里同样为真，
   反之亦然。适配层改为「两个只读探针并发，谁先应答就是谁，300ms 都没应答就按无宿主处理」。
3. **入口型输入只能 `getSearchContent()`** —— v1 底座在 view 会话打开时不显示搜索框（`desiredHeight` 560、
   搜索框被插件页取代），`watchSearchContent` 不会有回调。plugin-spec §9.1 已注明「要边打字边联动就把输入框做在插件页里」。
4. **`@launcher/api` 未发布** —— 构建期由 `scripts/launcher-sdk.mjs` 定位（`$LAUNCHER_API` → 插件 `node_modules`
   → 本机并列的底座仓库），找不到则别名到 `shared/lib/launcher-api-stub.ts` 并打印提示；没有把绝对路径写进插件工程。

### 9.4 仓库整合（同日后续）

4 个插件与它们共用的适配层**已从独立仓库（`~/Documents/Coding/SofastPlugins`）搬进本仓库**，作为**预置插件**放在 `presets/`，与 `plugins/` 下的内置插件分开管理：

| 项 | 做法 |
|---|---|
| 目录 | `presets/{shared,scripts,tests,docs,sofast-*}`；原仓库的 CODEBUDDY.md / 开发手册 / 规则 / 技能一并搬入 |
| 依赖 | 四个插件成为 **pnpm workspace 成员**（`presets/sofast-*`），`@launcher/api` 直接引用工作区包 `packages/plugin-api` —— 「SDK 未发布 / 找不到就退 stub」那套机制（`launcher-sdk.mjs` + `launcher-api-stub.ts` + 手写声明）全部退役 |
| 构建 | `pnpm build` 一并构建；`presets/scripts/build-all.mjs` 保留 `--pack`（打 zip 给如快安装） |
| 校验 | `pnpm typecheck`（vue 工程自动改用各自的 `vue-tsc`）、`pnpm test`（含 `presets/tests` 与四个插件用例）、`pnpm presets:check` |
| 出厂形态 | 内核 `--builtin-plugins` 支持逗号分隔的多目录；`scripts/lib/resources.mjs` 把 `plugins/` 与 `presets/` 一起拷进 `Resources/builtin-plugins/`；壳的开发态回退也带上 `presets/` |

**2026-09-16 后续（同日第一批）**：这层 `presets/` 已取消 —— 四个插件连同 `shared/` 一并搬进 `plugins/`，与内置插件同目录、
同出厂流程（构建按各包 `package.json` 的 `build:view` / `build:scripts` 由根 `scripts/build-all.mjs` 驱动；
`spec-check` / `pack:plugins` 收进根 `scripts/`），工具链仍是各自的 Vite + Vue。见 `plugins/README.md`。

**2026-09-16 后续（同日第二批）**：**如快退役** —— 双宿主适配层（`platform` / `host-adapter` / `host-calls` / `host-node`）
连同两个单测删除，插件改为直连 `@launcher/api` / `@launcher/api-node`；插件 id 去掉 `sofast-` 前缀
（`sofast-totp` → `totp` 等），旧数据目录由内核一次性接手（`apps/kernel/src/plugin.ts` 的 `LEGACY_PLUGIN_IDS`）。
本节其余内容（含如快侧的兼容说明）自此只作历史记录。

### 9.5 尚未做（明确缺口）

- **宿主备份目录迁移**：hosts 的旧备份在 `<插件目录>/data/backups`，新位置是 `<dataPath>/backups`。只有「把如快插件
  目录整体拷进底座」时两者才会共存 —— 旧备份仍留在磁盘上、只是不再列出。计划里的「复制不删除 + 校验文件数」涉及
  可提权的写路径，单独做更稳。
- **如快侧真机回归**：本机没有如快宿主，只能靠单测 + `spec-check`；清单新增的 `apiVersion` / `capabilities`
  依赖如快对未知字段宽松（其 `loadManifest` 只校验 `commands`）。
- **UI 人工验收**：自动化覆盖到「会话能开、生产资源可达、桥与脚本正确、能力越权被拒、数据落点正确」；
  粘贴→格式化→树视图、footer 按键、截图→粘贴导入这些需要人工点一遍。
