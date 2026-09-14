# 预置插件（presets/）

出厂**预装**的四个插件：双重验证器、Hosts 管家、文本比对、JSON 工具箱。
它们与 `plugins/` 下的**内置插件**在运行时一视同仁（同一份「出厂 bundle」、可禁用、可卸载），
区别只在**来源与工具链** —— 这一层分目录是为了让「跟着底座一起长出来的插件」与
「从别的生态移植过来、但一起出厂」的插件各管各的。

| | `plugins/`（内置插件） | `presets/`（预置插件，本目录） |
|---|---|---|
| 来源 | 与底座同一个仓库、同一套发布节奏 | 移植自如快 Sofast 生态（`docs/first-batch-plugins.md`） |
| 工具链 | `scripts/build-plugin.mjs`（esbuild，无框架） | 各自的 Vite + Vue 3 + Tailwind v4 工程 |
| 清单 | 手写 `package.json` 精简字段 | `manifest-plugin.mjs` 构建期裁剪写入 `dist/package.json` |
| 依赖 | 只依赖工作区包（`@launcher/api*`） | 另有第三方依赖（`vue` / `zxing-wasm` / `@sofastapp/api`） |
| 宿主 | 只认底座（`@launcher/api`） | **双宿主**：底座 `@launcher/api` + 如快 `@sofastapp/api`，运行期自动判定 |
| 自检 | 契约测试 `tests/contract/` | `node presets/scripts/spec-check.mjs`（清单 / N1 / N2 / N3 / 产物 / 远程资源） |

## 目录

```
presets/
├── shared/                 四个插件共用（构建期打进各自产物）
│   ├── lib/platform.ts     宿主出口：探测双宿主 + 对外导出（唯一入口）
│   ├── lib/host-adapter.ts 两套 SDK → 一个 HostBridge（纯函数，可单测）
│   ├── lib/host-calls.ts   超时 / 哨兵值 / localStorage 兜底（宿主无关）
│   ├── lib/host-node.ts    脚本侧：直接说 Node Worker 协议，双宿主天生兼容
│   ├── lib/{clipboard,keys,theme,toast,virtual}.ts
│   ├── ui/{AppShell,SofIcon,SofDialog}.vue
│   └── styles/theme.css    设计令牌（Tailwind v4 `@theme` 桥接）
├── scripts/
│   ├── build-all.mjs       构建全部预置插件（--pack 打 zip、--only= 只构建一个）
│   ├── spec-check.mjs      规范自检（plugin-spec §13 的可执行化）
│   ├── vite-shared.mjs     构建期别名：@shared + 两个宿主 SDK + vue
│   └── manifest-plugin.mjs 把清单裁剪后写进 dist/package.json
├── tests/                  适配层单测（宿主映射等价性、超时与兜底语义）
├── docs/                   sofast-plugin-dev-guide.md（移植自原插件仓库的开发手册）
└── sofast-{totp,hosts,text-diff,json-tools}/
```

每个插件是**独立可发布**的 Vite 工程：自己的 `package.json`（含宿主需要的 `commands` 清单）、
`vite.config.ts`、`tsconfig.json`。`shared/` 只在构建期被引用并打进产物，发布时不需要带着它。

## 常用命令（都在仓库根执行）

```bash
pnpm install                        # 预置插件是 pnpm workspace 成员，依赖统一装

pnpm build                          # = kernel + ui + 内置插件 + 预置插件
pnpm build:presets                  # 只构建预置插件

pnpm presets:check                  # 规范自检（0 项不合规才算过）
pnpm presets:pack                   # 构建并打 zip 到 presets/release/（如快安装用）

pnpm typecheck                      # 14 个包（vue 工程自动改用各自的 vue-tsc）
pnpm test                           # 含 presets/tests 与四个插件自己的用例

node scripts/smoke-first-batch.mjs  # 预置插件在真底座上跑一遍（20 项断言）
node scripts/smoke-real.mjs         # 出厂 bundle（内置 + 预置共 8 个）冒烟
```

单个插件（进目录）：

```bash
pnpm --filter sofast-totp run build      # 构建
pnpm --filter sofast-totp run typecheck  # 只做类型检查
pnpm --filter sofast-totp run test       # 跑它的用例
pnpm --filter sofast-totp run dev        # 浏览器里调试（宿主 API 自动降级为 localStorage）
```

## 运行时形态与数据落点

- 产物 `dist/` 就是插件目录：`index.html` + `assets/` + `package.json`（+ script 命令的 `<name>.mjs`）。
  打包进 `.app` 时由 `scripts/lib/resources.mjs` 与内置插件一起拷进 `Resources/builtin-plugins/`，
  源码分目录、运行时同目录（内核的 `--builtin-plugins` 支持逗号分隔的多目录，开发态用得上）。
- **可变数据只写 `ctx().dataPath`**（N2）：底座下是 `<dataRoot>/plugins/<id>/`，如快下是 `<插件目录>/data`。
  `pluginPath` 是只读安装目录，写它会被 `spec-check` 拦下。
- 旧宿主（如快）留在插件目录里的 `data/storage.json` 由底座在首次加载时迁移到 `dataRoot`（只复制不删除）。

## 边界

- 这里的「预置」指的是**出厂预装**，不是「用户预设」；用户仍可在设置里禁用/卸载它们（只有 `internal-*` 不可卸载）。
- 预置插件不享受底座内部特权：`ctx.settings` 只注入 `internal-*` 插件，预置插件调用会得到 `FORBIDDEN`。
- 规范真源在仓库根的 `docs/plugin-spec.md`；本目录的开发细则见 `CODEBUDDY.md` 与 `docs/sofast-plugin-dev-guide.md`。
