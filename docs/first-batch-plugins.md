# 首批插件接入结论（totp / hosts / text-diff / json-tools）

> 依托规范：`docs/plugin-spec.md` ｜ 现行维护方式：`plugins/README.md`
> 这 4 个插件是插件接入规范 v1 的**首批实现**。本文只保留接入与收敛结论，过程记录不再维护。

## 1. 形态（规范 v1 的三种命令都覆盖到了）

| 插件 | 命令 | 用到的能力 | 数据落点 |
|---|---|---|---|
| `totp` | `totp`(view, searchable) + `read-image`(script) | `storage` / `hostUi` / `screenshot` / `exec.spawn` | `<dataRoot>/plugins/totp/storage.json`（含 vault 密文） |
| `hosts` | `hosts`(view, searchable) + `hosts-read` / `hosts-write`(script) | `storage` / `hostUi` / `exec.spawn` | 同上；备份与待生效文件在 `<dataPath>/backups` |
| `text-diff` | `diff`(view, searchable) | `hostUi` | 无 |
| `json-tools` | `json`(view, searchable) | `hostUi` | 无 |

4 个都是入口型搜索（`searchable: true`，命中命令后把输入交给插件页）；贡献型搜索（`contributes` + `onQuery`）首批未用。

## 2. 收敛结论

- **宿主调用直连 SDK**：view 侧 `@launcher/api`、script 侧 `@launcher/api-node`；先用 `host.isLauncher()`（同步）分流，调用点兜失败。中间适配层已删除，不再引入。
- **能力即声明**：`capabilities` 按实际调用最小声明（见上表），用户可逐项拒绝，拒绝则对应服务不挂载。
- **数据与代码分离（N2）**：只写 `ctx().dataPath`；`pluginPath` 只读。`spec-check` 会拦下对安装目录的写操作。
- **产物即插件目录**：`dist/` = `index.html` + `assets/` + `package.json`（+ script 命令的 `<name>.mjs`，与 `commands[].name` 逐字一致且自包含）。
- **工程与出厂**：4 个插件住在 `plugins/`，与内置插件同目录、同出厂流程（根 `scripts/build-all.mjs` 按各包 `build:view` / `build:scripts` 驱动，`pack-plugins.mjs` 打 zip），工具链保留各自的 Vite + Vue + Tailwind。
- **id 与数据迁移**：id 为 `totp` / `hosts` / `text-diff` / `json-tools`；历史 id 的数据目录由内核首次加载时接手（`apps/kernel/src/plugin.ts` 的 `LEGACY_PLUGIN_IDS`）。

## 3. 怎么验（都收进了统一入口）

| 入口 | 覆盖 |
|---|---|
| `pnpm build:plugins` | vue-tsc + Vite 构建全部出厂插件（含本组 4 个） |
| `pnpm test` | 4 个插件的 core / script 用例 + 内核契约与单元测试 |
| `pnpm spec-check` | 清单完整性 / N1 产物名 / N2 数据目录 / N3 能力声明 / 远程资源 |
| `pnpm smoke:first-batch` | 真内核 + 真插件 HTTP 冒烟：会话、桥、脚本、能力越权被拒、数据落点 |

## 4. 明确缺口

- **hosts 旧备份目录**：历史版本把备份放在安装目录的 `data/backups`；只有「手工把旧插件目录拷进底座」才会两者共存 —— 旧备份仍留在磁盘、不再列出。迁移涉及可提权写路径，留待单独处理。
- **UI 人工验收**：自动化覆盖到「会话能开、生产资源可达、桥与脚本正确、能力越权被拒、数据落点正确」；粘贴→格式化→树视图、footer 按键、截图→粘贴导入仍需人工点一遍。
