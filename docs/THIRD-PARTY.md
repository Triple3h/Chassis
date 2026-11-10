# 第三方组件与许可证

> 状态：随依赖与衍生实现变更维护 ｜ 最后更新：2026-11-10

本仓库包含以下第三方组件的衍生实现或数据，均保留了原始许可证与版权声明。
本仓库整体以 MIT 许可发布，见根目录 [LICENSE](../LICENSE)。

---

## Everything（MIT）—— 互操作协议的来源声明

- 项目：<https://www.voidtools.com/>（voidtools）
- 许可证：MIT License, Copyright © 2018 David Carpenter（`License.txt`；其内置 PCRE 部分为 BSD-3 —— 与本仓库无关，我们不分发 Everything 的任何产物）
- 用途：`plugins/file-search/src/everything.rs` 是**按 Everything 公开的 IPC 协议独立实现**的客户端（Windows 上复用用户已装的 Everything 做全盘文件名搜索）。**本仓库不分发、不打包 Everything 的任何二进制或代码副本**，只实现与之通信的互操作协议：
  - 窗口类名 `EVERYTHING_TASKBAR_NOTIFICATION`、消息 `WM_USER` + IPC 命令号、`WM_COPYDATA` 查询/回复语义；
  - `#pragma pack(1)` 的请求 / 结果结构布局（`EVERYTHING_IPC_QUERYW` / `EVERYTHING_IPC_LISTW`）。
  以上事实取自官方 SDK 分发包里的头文件（`include/Everything.h`、`ipc/everything_ipc.h`）。若将来需要**随包分发** Everything 或其 SDK DLL，须先按 MIT + BSD-3 的保留声明义务补全本节与发行包内的许可文本。

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

## 图标（自绘；命名沿用 lucide 习惯）

- 命名参考：<https://github.com/lucide-icons/lucide>（ISC / 部分 Feather 衍生图标 MIT）
- 用途：**仅沿用图标名称作为清单字段的兼容写法**（`terminal` / `git-compare` / `shield-check` 等），
  便于既有插件与第三方插件继续按名字引用。
- 2026-11-10 起，`packages/ui/lib/icons.ts` 与 `packages/ui/ui/UiIcon.vue` 的几何图形全部由本仓库
  按统一的 Liquid Glass 线稿规范**重新绘制**（24 viewBox、1.75 描边、圆头圆角、20px 光学尺寸）。
  **不再内联或派生 lucide 的 path 数据**，因此不再附带 ISC / Feather MIT 的许可义务；
  该节仅保留命名对照与来源说明，不构成代码或数据分发。
- 壳位图（`apps/shell/icons/`）同样为原创：`scripts/make-icon.mjs` 生成 squircle 玻璃盘 +
  输入框字形 + 放大镜托盘字形。

> 如果将来重新引入任何第三方图标数据，必须在本节补回对应许可证原文，并在
> `docs/plugin-spec.md §10.4` 记录来源与替换范围。

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
