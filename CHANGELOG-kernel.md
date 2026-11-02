# Changelog

本文件由 `pnpm ship` 维护，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.10] - 2026-11-02

### Changed

- 内核更新源新增 npm/npmmirror（签名索引），国内更新优先走 npm；移除 Gitee 镜像

## [0.1.9] - 2026-11-02

### Added

- 新增桥方法 `ctx.window.startDrag`：插件页可在自己的标题栏 `mousedown` 时请求拖动窗口；宿主发起后立即回执，不受 macOS 拖动阻塞影响。
