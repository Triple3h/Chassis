# 第三方代码与许可证

本仓库包含（或移植了）以下第三方代码。所有引入都保留了原始许可证与版权声明。

---

## ZTools（MIT）

- 仓库：<https://github.com/ZToolsCenter/ZTools>
- 许可证：MIT License, Copyright (c) 2025 lzx8589561
- 用途：**移植**（非直接依赖）macOS 应用扫描与本地化名称解析逻辑。

### 移植清单（文件级）

| 本仓库文件 | 来源（ZTools） | 改造内容 |
|---|---|---|
| `plugins/app-launcher/src/core/scanner.ts` | `src/main/core/commandScanner/macScanner.ts`（约 432 行中的扫描主体） | 去掉 Electron 依赖：`app.getPreferredSystemLanguages()` → `defaults read -g AppleLanguages`；图标改为输出 `.icns` 路径（由 `sips` 转 PNG）；`pLimit` 改为内置保序版 |
| `plugins/app-launcher/src/core/scanner.ts` 中的 `collectAppBundles` | 同上 | 原样移植（含符号链接解析、PWA/Office 子目录下钻一层、`.app` 命中即停止下钻） |
| `plugins/app-launcher/src/core/scanner.ts` 中的 `bcp47ToLprojNames` / `bcp47ToLoctableKeys` / `parseStringsContent` / `readStringsFile` | 同上 | 原样移植（含 binary plist / XML plist / UTF-16 文本三种 `.strings` 格式） |
| `apps/kernel/src/util/limit.ts` | `src/main/core/commandScanner/utils.ts`（`pLimit`） | 增加保序版 `pMapOrdered` |
| `apps/kernel/src/util/fsx.ts` 的 `assertSafePathPart` | `src/main/utils/pluginStorage.ts`（`assertSafePluginArtifactPart`） | 原样移植（路径片段安全校验） |
| `apps/kernel/src/http/server.ts` 的 URL 拆分与穿越防护 | `src/main/utils/pluginUrl.ts`（`getUrlScheme` / `splitPluginUrl` 的思路） | 按本仓库的静态服务需求重写为 `resolveWithinRoot` |

**未移植**：ZTools 的插件管理、窗口管理、存储、同步、AI、支付、市场等模块（架构不同：Electron `WebContentsView` → Tauri WebView + iframe + 每插件独立端口）。

### 设计对照：启动台结果网格（UI，未复制代码）

`apps/launcher-ui` 的**结果网格**（分区标题 + 每行 N 个「图标 + 名称」格子、「展开 (N) / 收起」、方向键按格子移动、`Esc` 分步退出、已固定分区拖拽重排）是照 ZTools 渲染层的聚合视图**行为语义**重写的本仓库实现（Vue 3 + Pinia + Tailwind，代码见 `apps/launcher-ui/src/lib/grid.ts`、`components/ResultGrid.vue`）：对照 `src/renderer/src/components/search/AggregateView.vue`、`components/common/CollapsibleList.vue`、`CommandList.vue`、`composables/useNavigation.ts`。**代码为原创，不含 ZTools 源码。**

### 依赖选型参考（非代码移植）

以下 npm 包的选择参考了 ZTools 的实践（ZTools `package.json`）：

| 包 | 本仓库用途 |
|---|---|
| `pinyin-pro` | 拼音全拼 / 首字母索引（`apps/kernel/src/pinyin.ts`） |
| `chokidar` | 监听 `extensions/` 目录变化触发热重载（`apps/kernel/src/plugin.ts`） |
| `adm-zip` | 插件 zip 安装（`apps/kernel/src/plugin.ts`） |

> **未采用 `simple-plist`**：它在运行时 `require('bplist-creator' / 'bplist-parser')`，
> 无法静态打包进 `<name>.mjs`，会破坏 plugin-spec N1「脚本产物自包含」。
> 改为自研的 `plugins/app-launcher/src/core/plist.ts`（binary + XML plist 只读解析，约 200 行）。
> 该文件为原创实现，不含第三方代码；`scripts/build-plugin.mjs` 会校验产物自包含性（只允许 `node:*`）。

---

## MIT License 原文（ZTools）

```
MIT License

Copyright (c) 2025 lzx8589561

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 参考但未引入（仅作设计对照）

| 项目 | 许可证 | 参考点 |
|---|---|---|
| [rubickCenter/rubick](https://github.com/rubickCenter/rubick) | MIT | uTools 形态的插件桥与插件市场设计 |
| [MystikoLab/rustcast](https://github.com/MystikoLab/rustcast) | MIT | Rust 侧原生 Launcher 的排序与计算器设计 |
| [newdee/magpie](https://github.com/newdee/magpie) | MIT | Tauri 2 启动类应用的窗口/热键组织方式 |

> 引用方式：只做设计对照，未复制代码；若后续复制，须补入本节并附许可证原文。

---

## 本仓库许可证

MIT（待补 `LICENSE` 文件；发布前必须落地）。
