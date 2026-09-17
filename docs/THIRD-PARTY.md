# 第三方组件与许可证

> 状态：随依赖与衍生实现变更维护 ｜ 最后更新：2026-09-17

本仓库包含以下第三方组件的衍生实现或数据，均保留了原始许可证与版权声明。
本仓库整体以 MIT 许可发布，见根目录 [LICENSE](../LICENSE)。

---

## ZTools（MIT）

- 仓库：<https://github.com/ZToolsCenter/ZTools>
- 许可证：MIT License, Copyright (c) 2025 lzx8589561
- 用途：macOS 应用扫描与本地化名称解析逻辑是本仓库的**衍生实现**（非直接依赖）。

### 衍生清单（文件级）

| 本仓库文件 | 来源（ZTools） | 改造内容 |
|---|---|---|
| `plugins/app-launcher/src/lib.rs` | `src/main/core/commandScanner/macScanner.ts`（约 432 行中的扫描主体） | 去掉 Electron 依赖：语言列表走 `defaults read -g AppleLanguages`；图标用 `.icns` 路径（由 `sips` 转 PNG）；并发用内置保序实现 |
| 同上（`collect_app_bundles`） | 同上 | 含符号链接解析、PWA/Office 子目录下钻一层、`.app` 命中即停止下钻 |
| 同上（`bcp47_to_lproj_names` / `bcp47_to_loctable_keys` / `parse_strings_content` / `read_strings_file`） | 同上 | 含 binary plist / XML plist / UTF-16 文本三种 `.strings` 格式 |
| `apps/kernel/src/util/fsx.rs` 的 `resolve_within_root` | `src/main/utils/pluginUrl.ts`（`getUrlScheme` / `splitPluginUrl` 的思路） | 按本仓库的静态资源服务需求重写为路径越界防护 |

除上表所列之外，本仓库代码均为原创实现（UI 的图标网格、键盘导航、显隐动效等不与任何第三方共享源码）。

### MIT License 原文（ZTools）

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

## Lucide（ISC；其中 Feather 衍生图标为 MIT）

- 仓库：<https://github.com/lucide-icons/lucide>
- 许可证：ISC License, Copyright (c) 2026 Lucide Icons and Contributors；其中从 Feather 衍生的一部分图标为 MIT License, Copyright (c) 2013-present Cole Bemis（`search` / `terminal` / `check` / `trash` / `plus` / `server` 等在本仓库使用范围内）
- 用途：**图标数据来源**（非依赖）。`packages/ui/lib/icons.ts` 内置的 svg 子元素取自 lucide 官方图标，渲染仍由本仓库完成（宿主网格 `apps/launcher-ui/src/components/IconGlyph.vue`、设置页插件列表 `plugins/internal-settings` 都从这里取）。

> **为什么内联而不装包**：图标是可枚举的静态数据，内联进 `lib/icons.ts` 后总体积只有几 KB，
> 同时保持离线可用、零运行时依赖；`docs/plugin-spec.md §10.4` 据此只允许三种图标形态（lucide 名 / 相对路径 / data URL）。

### ISC License 原文（Lucide）

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### MIT License 原文（Feather 衍生图标）

```
MIT License

Copyright (c) 2013-present Cole Bemis

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
| [rubickCenter/rubick](https://github.com/rubickCenter/rubick) | MIT | 插件桥与插件市场的形态设计 |
| [MystikoLab/rustcast](https://github.com/MystikoLab/rustcast) | MIT | Rust 侧原生 Launcher 的排序与计算器设计 |
| [newdee/magpie](https://github.com/newdee/magpie) | MIT | Tauri 2 启动类应用的窗口/热键组织方式 |

> 引用方式：只做设计对照，未复制代码；若后续复制，须补入本节并附许可证原文。

---

## 本仓库许可证

MIT，见根目录 [LICENSE](../LICENSE)。
