# 代码签名与系统权限

> 读者：使用者（装包 / 授权 / 排障）与维护者（动打包链路）。
> 相关：README「安装与构建」；`docs/architecture.md` §9「已知边界（安全）」。

## 1. 为什么要签名

- Apple Silicon 上**未签名的可执行文件会被内核直接杀掉**（`Killed: 9`）—— 这是系统的强制签名策略，不是可选项。
- 打包脚本（`pnpm app:local`）的签名顺序：**本机自签名证书**（`node scripts/make-signing-cert.mjs` 一次性创建，免费、仅本机有效）→ 找不到证书时回落 `codesign --sign -` 的 **ad-hoc** 签名。
- 为什么优先固定证书而不是 ad-hoc：macOS 的 TCC 授权（辅助功能 / 屏幕录制 / 自动化 / 通知）按**代码签名身份**记账。ad-hoc 的身份就是二进制哈希 —— **每次重新打包都变**，已经给过的授权会失配、重新弹框；固定证书的身份跨重新打包稳定，一次授权长期有效。
- 自用不需要 Apple Developer、公证或自动更新；本地构建的 `.app` 不带 quarantine 属性，双击即可运行。

### CI 上的签名（应用自更新通道，2026-09-19 起）

`app-latest` 通道（应用自更新，`app-release.yml`）由 CI 打包，签名走 GitHub Secrets：

- `MACOS_SIGN_P12`（本机固定证书导出为 p12 的 base64）与 `MACOS_SIGN_P12_PASSWORD`；
- 一次性导出：`node scripts/export-signing-cert.mjs`（文件落在系统临时目录，配置完请删除）；
- 没配 secrets 时工作流回落 ad-hoc 并在日志里打 warning：包能装，但**每次自更新后 TCC 授权都会重弹**
  （ad-hoc 的身份 = 二进制哈希，换包就等于换了个应用）。

核对方式：`pack-app.mjs` 会把实际签名身份打出来，CI 日志里应看到 `Authority=Chassis Local Signing`。

## 2. 会弹哪些系统权限（各自对应什么功能）

| 系统设置里的名字 | 谁在用 | 不给会怎样 |
|---|---|---|
| **辅助功能** | 壳 `primitives/selection.rs`：唤出时读前台选中的文本 | 唤出不带选区，其余照常（可随时在系统设置里补授权） |
| **屏幕录制** | 内核 `services/primitives.rs` 调 `screencapture`：`screenshot` 能力（TOTP 扫码的前置） | 截图只有壁纸、扫不出码 |
| **自动化 / Apple 事件**（弹窗文案：「想控制此 Mac 并访问你的数据」） | `host-manager` 的提权写入：`osascript -e 'do shell script … with administrator privileges'` 把托管区写进 hosts | **只有**「写入托管区」这一个动作失败；读、预览与其它插件都不受影响 |
| 通知 | `notify` 能力（操作完成提示） | 少提示，不影响功能 |
| 文件与文件夹（桌面 / 图片等） | TOTP 扫截图目录、文件搜索命中受保护目录 | 对应范围搜不到 |

前置说明：

- **打开应用 / 文件 / 网址走的是 `/usr/bin/open`（LaunchServices），不需要任何权限** —— 所以「自动化」那条只在真的动 hosts 时才弹，不是启动就弹。
- TCC 授权是**绑代码签名身份**的：用固定证书签名（默认路径）时重新打包不影响授权；回落 ad-hoc 时每次重新打包都会被系统当成「第一次」重弹一次。
- 弹窗里只有「拒绝 / 打开系统设置」（没有「允许」）时，说明之前拒绝过或签名已变 —— 去 系统设置 → 隐私与安全性 → 对应分类**删掉旧条目再重新授权**（旧条目对应旧身份，留着也不生效）。

## 3. 让 host-manager 不再弹「自动化」框

`host-manager` 顶栏点「需授权」→「开启免授权写入」，会把 `/etc/hosts` 的写权限**一次性**授给当前账户（POSIX ACL `chmod +a`，与 uTools / SwitchHosts 引导你手动做的是同一件事）。此后保存直接写入、不再弹「自动化」框；随时可在同一面板撤销，恢复系统默认。

## 4. 未公证与 quarantine

从网络下载的 `.app` 会带 quarantine 属性（未公证），首次打开需要：**右键 → 打开**，或 `xattr -dr com.apple.quarantine Chassis.app`。

## 5. Windows 侧对照

- **上面这些授权一个都不需要**：读选中文本走 UI Automation（系统 API，无需授权；只对实现了 TextPattern 的控件有效，其余静默跳过）；hosts 写入走 UAC 授权框（「是否允许此应用对你的设备进行更改？」，与 macOS 的提权框对应）；区域截图唤起系统截图（等同 `Win+Shift+S`）。
- **未签名包**：首次运行会有 SmartScreen 提示，点「更多信息 → 仍要运行」。
- **缺 WebView2** 时启动会提示安装（Win11 已自带）。
