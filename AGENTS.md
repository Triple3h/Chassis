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

## Release Channels & Independent Updates

Three channels, each pinned to its own fixed tag; clients read plain `releases/download/<tag>/...` URLs (no GitHub API, no token). **CI never runs on `main` pushes** — `verify.yml` ignores `main`, and every publisher workflow is `workflow_dispatch` + its own tag prefix, so merging to `main` builds nothing. Releases are always explicit actions:

| Channel | Trigger | Artifacts (fixed tag) | How clients get it |
|---|---|---|---|
| App (shell), manual | tag `v*` → `release.yml` | whole package (`.app` / portable zip) | user installs it manually (new machines / auto-update off) |
| **App (shell), update** | `gh workflow run app-release.yml --ref main` (or tag `app/*`) | `app-registry.json` + `Chassis-<ver>-macos-<arch>.zip` → `app-latest` | Update page →「应用」, reached from the **tray's permanent「检查更新…」item** (label carries the version when one is available) or the **About tab** card — the kernel watch (90s after boot, every 6h) only **checks and prompts**, and the tray item just opens the update page (it never updates by itself); the shell downloads and swaps the `.app` via an out-of-process helper only after the user confirms (macOS only; `config.autoUpdateCheck`) |
| Kernel | `gh workflow run kernel-release.yml --ref main` (or tag `kernel/*`) | `kernel-registry.json` + `launcher-kernel-<ver>-<platform>-<arch>.zip` (kernel + `ui/`) → `kernel-latest` | 更新页 →「内核」→ 更新内核 (hot swap + graceful kernel restart) |
| Plugins | `gh workflow run plugins-release.yml --ref main [-f plugins="<id>"]` (or tag `plugins/*`) | `<id>-<ver>-<platform>-<arch>.zip` + `registry.json` → `plugins-latest` | 更新页 → per-plugin update (hot reload) |

- Versions are maintained in **one place: the root `version.json`** (`app` = shell/App, `kernel` = kernel). `pnpm version:set app 0.1.4` syncs `apps/shell/tauri.conf.json`, `apps/shell/Cargo.toml` and `apps/kernel/Cargo.toml`; `pnpm version:check` guards drift and runs in every release workflow. **Never hand-edit those `version` fields** — drift makes the auto-update channel fail silently (clients can't see a new version). Mechanism versions (`SHELL_HOT_VERSION` / `HOT_UPDATE_VERSION`) and plugin versions are *not* in the manifest.
- Kernel/plugin releases **never restart the App**: bump the version (kernel via `version.json`, plugins via their own `package.json`), merge to `main`, then run the workflow — it builds the default branch, so code must land on `main` first. An **App (shell) release restarts the whole app** (kernel included) — that is the point of the auto-update channel.
- **Publishing is instantly visible to every installed client** (source is a compile-time constant; no staged rollout). The only gates are `minHotVersion` (kernel package vs. client hot-update mechanism), `minShellHotVersion` (app package vs. client shell-update mechanism) and `minKernel` (plugin index vs. running kernel).
- An App upgrade resets the baseline: the shell re-deploys the bundled kernel into `<dataRoot>/kernel/` (ledger `kernel.json` records `sourceAppVersion`), so kernel hot-updates lead only *between* App releases. The same applies to a **shell auto-update** (its version always changes) — expect the bundled kernel to be re-deployed right after.
- App auto-update packages are signed in CI with the **same fixed certificate as local builds** (`MACOS_SIGN_P12` / `MACOS_SIGN_P12_PASSWORD` secrets; export via `node scripts/export-signing-cert.mjs`). Without those secrets the workflow falls back to ad-hoc and every update forces the user to re-grant TCC permissions (Accessibility / Screen Recording).
- Partial plugin releases **must merge the previous `registry.json`** (`gen-plugin-registry.mjs --merge-registry`, done automatically by `plugins-release.yml`). Without it the index lists only the plugins packed in that run and every other plugin silently stops updating — guarded by `tests/unit/plugin-registry-merge.test.ts`.
- Fixed-tag releases keep **only the assets the current index points to**: after `action-gh-release`, each publish workflow runs `scripts/prune-release-assets.mjs` (deletes `.zip` assets missing from the freshly generated index). Without it every version leaves orphan zips behind (zip names carry versions; `overwrite_files` only overwrites same names) — a release caps at 1000 assets, and hitting that cap breaks publishing.

## Coding Style & Naming Conventions

TypeScript (view layer, UI, tooling): two-space indentation, single quotes, no semicolons, `strict` with `verbatimModuleSyntax` (type-only imports need `import type`). Rust (kernel + plugin logic): `rustfmt` defaults, 4-space indent. No linter/formatter is configured for TS — match existing style and rely on `pnpm typecheck`. Use kebab-case for plugin ids (`app-launcher`, `text-diff`), PascalCase for Vue components (`ResultGrid.vue`), camelCase for modules; no-view/script command names equal the artifact filename (`dist/<name>`). A kernel diff must never contain capability words (app/file/network) — those belong in plugins.

## Testing Guidelines

Rust tests live beside their modules plus `apps/kernel/tests/`. TS tests use a dependency-free harness (`tests/helpers/assert.ts`: `test` / `assert` / `assertEqual` / `run`) and `tests/helpers/harness.ts` spawns the real kernel binary (HTTP/SSE + stdio fake shell). Name files `*.test.ts`, write Chinese test titles describing behavior, and place suites in `tests/unit`, `tests/contract`, or `tests/smoke` (plugin-internal cases live beside their `core` code). No coverage gate; before handing off run `cargo test --workspace && pnpm typecheck && pnpm test && pnpm build && pnpm spec-check`, then exercise the packaged `.app`, since production resource paths differ from dev.

## Commit & Pull Request Guidelines

Commits follow Conventional Commits with a Chinese subject plus explanatory body: `feat: 启动台结果改为图标网格（分区折叠 / 键盘导航 / 拖拽重排）`, `refactor: 清除第三方兼容层 + plugins/shared 上收为 @launcher/ui`, `chore: .codebuddy 不入库`.

Pull requests: state the behavior change and rationale, list commands run (`typecheck` / `test` / `build` / `spec-check`), and attach a screenshot for UI changes. Spec-first — update `docs/launcher-requirements.md` or `docs/plugin-spec.md` (or add an ADR) before implementing unspecified behavior, and refresh docs whenever slots, fields, or schema change.

## Security & Configuration

Runtime data lives in `~/Library/Application Support/Chassis` (macOS) / `%APPDATA%\Chassis` (Windows), overridable with `LAUNCHER_DATA_ROOT`; the pre-rename `Launcher/` directory is adopted once by the shell (macOS only — Windows had no prior release). Plugins may only write under their injected `dataPath`. Kernel protocol output stays on stdout, logs on stderr. Never persist secrets in plaintext.
