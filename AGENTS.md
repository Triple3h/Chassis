# Repository Guidelines

Chassis is a plugin-based macOS launcher: Tauri 2 Rust shell (system primitives only) + **Rust kernel** (`apps/kernel`, bin `launcher-kernel`, ADR-0005) + Vue 3 launcher UI. Three invariants govern every change: the kernel has **zero capabilities** (scanning apps, reading files, launching — all plugins), built-in plugins use the same mechanism as third-party ones, and undeclared capabilities do not exist at runtime. The app runs with no Node dependency: the kernel and all logical-layer plugin commands are Rust executables.

## Project Structure & Module Organization

| Path | Contents |
|---|---|
| `apps/shell/src/` | Rust/Tauri shell: `lib.rs`, `ipc.rs`, `sidecar.rs`, `primitives/*` |
| `apps/kernel/src/` | Kernel (bin `launcher-kernel`): `kernel.rs`, `api.rs`, `plugin/*`, `search*.rs`, `services/*`, `link.rs` |
| `apps/launcher-ui/src/` | Vue UI: `App.vue`, `components/*`, `lib/grid.ts`, `stores/*` |
| `packages/` | `plugin-manifest` (types + validation + contract), `plugin-api` (view-side SDK), `plugin-sdk-rs` (logical-layer Rust SDK), `ui` (`@launcher/ui` shared kit) |
| `plugins/*` | 13 built-in plugins; each `dist/` ships `index.html`, `assets/`, `package.json`, plus one executable per `no-view`/`script` command; Rust logic lives in each plugin's crate (`plugins/<id>/Cargo.toml`, sources in the same `src/`) |
| `tests/{unit,contract,smoke}` | Test suites plus `tests/fixtures/echo-plugin` (Rust fixture: SDK `echo` example binary) |

## Build, Test, and Development Commands

- `pnpm install` — install the workspace.
- `cargo test --workspace` — Rust kernel + SDK + plugin-logic tests.
- `pnpm typecheck` — `tsc --noEmit` for all packages (Vue packages use `vue-tsc`).
- `pnpm test` — every `*.test.ts`; scope via `pnpm test:unit` / `test:contract` / `pnpm smoke`. The harness spawns the real kernel binary (`cargo build -p launcher-kernel` runs automatically).
- `pnpm build` — kernel (`cargo build --release -p launcher-kernel`) + launcher UI + 8 plugins (view assets + `target/release/<bin>` copies).
- `pnpm spec-check` — plugin manifest self-audit (N1–N3, artifacts, remote resources).
- `pnpm dev:kernel` / `pnpm dev:ui` — run kernel and UI without the shell.
- `pnpm smoke:real` / `pnpm smoke:first-batch` — real kernel + real plugins, HTTP only.
- `npm run shell:dev` / `npm run app:local` — run or package the real macOS app.
- `pnpm app:win` (Windows only) — package the Windows portable zip (`dist-app/Chassis-<version>-win-<arch>.zip`).
- Windows cross-check from macOS: `cargo check --workspace --exclude launcher-plugin-translate --exclude launcher-plugin-internal-store --target x86_64-pc-windows-msvc`（被排除的两个依赖 `ring`，其 C 代码在 macOS 主机上交叉不到 msvc；真 Windows 上无此问题）。
  The shell (`apps/shell`) additionally needs a resource compiler for `tauri-build` — point `RC` at a stub script (its probe output must start with `OVERVIEW: LLVM Resource Converter`, then exit 0). Real Windows builds run in `.github/workflows/build-windows.yml`.

## Coding Style & Naming Conventions

TypeScript (view layer, UI, tooling): two-space indentation, single quotes, no semicolons, `strict` with `verbatimModuleSyntax` (type-only imports need `import type`). Rust (kernel + plugin logic): `rustfmt` defaults, 4-space indent. No linter/formatter is configured for TS — match existing style and rely on `pnpm typecheck`. Use kebab-case for plugin ids (`app-launcher`, `text-diff`), PascalCase for Vue components (`ResultGrid.vue`), camelCase for modules; no-view/script command names equal the artifact filename (`dist/<name>`). A kernel diff must never contain capability words (app/file/network) — those belong in plugins.

## Testing Guidelines

Rust tests live beside their modules plus `apps/kernel/tests/`. TS tests use a dependency-free harness (`tests/helpers/assert.ts`: `test` / `assert` / `assertEqual` / `run`) and `tests/helpers/harness.ts` spawns the real kernel binary (HTTP/SSE + stdio fake shell). Name files `*.test.ts`, write Chinese test titles describing behavior, and place suites in `tests/unit`, `tests/contract`, or `tests/smoke` (plugin-internal cases live beside their `core` code). No coverage gate; before handing off run `cargo test --workspace && pnpm typecheck && pnpm test && pnpm build && pnpm spec-check`, then exercise the packaged `.app`, since production resource paths differ from dev.

## Commit & Pull Request Guidelines

Commits follow Conventional Commits with a Chinese subject plus explanatory body: `feat: 启动台结果改为图标网格（分区折叠 / 键盘导航 / 拖拽重排）`, `refactor: 清除第三方兼容层 + plugins/shared 上收为 @launcher/ui`, `chore: .codebuddy 不入库`.

Pull requests: state the behavior change and rationale, list commands run (`typecheck` / `test` / `build` / `spec-check`), and attach a screenshot for UI changes. Spec-first — update `docs/launcher-requirements.md` or `docs/plugin-spec.md` (or add an ADR) before implementing unspecified behavior, and refresh docs whenever slots, fields, or schema change.

## Security & Configuration

Runtime data lives in `~/Library/Application Support/Chassis` (macOS) / `%APPDATA%\Chassis` (Windows), overridable with `LAUNCHER_DATA_ROOT`; the pre-rename `Launcher/` directory is adopted once by the shell (macOS only — Windows had no prior release). Plugins may only write under their injected `dataPath`. Kernel protocol output stays on stdout, logs on stderr. Never persist secrets in plaintext.
