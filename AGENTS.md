# Repository Guidelines

Chassis is a plugin-based launcher: a Tauri 2 Rust **shell** (system primitives only), a Rust **kernel** (`apps/kernel`, bin `launcher-kernel`, see `docs/architecture.md` §1), and a Vue 3 **launcher UI**. It ships for macOS 11+ and as a Windows portable build.

**Three invariants — never merge a change that breaks one:**

1. **The kernel has zero capabilities.** Scanning apps, reading files, opening URLs, network — all belong to plugins. A kernel diff must never contain capability words.
2. **Built-in ≠ embedded.** Factory plugins use the same manifest/capability mechanism as third-party ones and can be disabled or uninstalled (only the `internal-*` management surface is exempt).
3. **Undeclared capabilities do not exist at runtime.** They are pruned at assembly time, so the plugin-side method is absent rather than rejected.

The app has **no Node dependency at runtime**: the kernel and every logical-layer plugin command are Rust executables.

## Where things live

| Path | Contents |
|---|---|
| `apps/shell/src/` | Tauri shell: `main.rs` / `lib.rs`, `ipc.rs` (JSON-RPC over stdio), `sidecar.rs`, `update.rs` (self-update), `kernel_swap.rs`, `primitives/*` (window / hotkey / tray / notify / clipboard / opener) |
| `apps/kernel/src/` | Kernel: `kernel.rs` (assembly), `api.rs`, `registry.rs`, `pipeline.rs`, `plugin/*`, `search.rs` + `pinyin.rs`, `http/*`, `hot/*`, `services/*`, `link.rs` |
| `apps/launcher-ui/src/` | Vue UI: `App.vue`, `components/*`, `lib/grid.ts`, `stores/*` |
| `packages/` | `plugin-manifest` (types + validation), `plugin-api` (view-side SDK), `plugin-sdk-rs` (logical-layer Rust SDK), `plugin-cli` (scaffolding), `ui` (`@launcher/ui` shared kit) |
| `plugins/*` | 17 built-in plugins; each `dist/` ships `index.html`, `assets/`, `package.json`, plus one executable per `no-view` / `script` command; Rust logic lives in each plugin's crate (`plugins/<id>/Cargo.toml`, sources in the same `src/`) |
| `tests/{unit,contract,smoke}` | Test suites plus fixtures: `tests/fixtures/echo-plugin` (SDK echo binary) and `tests/fixtures/update-builtin` (fake factory plugins for update tests) |
| `docs/` | Source of truth — see the index below |

**Docs are authoritative; spec-first.** Before implementing unspecified behavior, record the decision in the matching doc (requirements for behavior, plugin-spec for contract, architecture §8 for kernel deviations) and then write the code. Refresh docs whenever slots, fields, or schema change.

- `docs/launcher-requirements.md` — the only requirements source (P1–P7, §13 milestones).
- `docs/architecture.md` — process topology, module map, HTTP/bridge checks, data layout, Windows update boundaries (§11).
- `docs/plugin-spec.md` / `docs/plugin-dev-guide.md` — plugin contract / hands-on guide.
- `docs/permissions.md` — capability model.
- `docs/shell-hot-update.md` / `docs/kernel-hot-update.md` / `docs/plugin-spec.md` §6.4 — the three update mechanisms; `docs/release-channels.md` — tags, versions, CI and release hygiene.
- `docs/motion.md` — motion tokens and window show/hide choreography.

## Commands

**Verify before handing off:** `cargo test --workspace && pnpm typecheck && pnpm test && pnpm build && pnpm spec-check`, then launch the packaged `.app` — production resource paths differ from dev.

- `pnpm install` — install the workspace.
- `cargo test --workspace` — kernel + SDK + plugin-logic tests.
- `pnpm typecheck` — `tsc --noEmit` for every package (Vue packages via `vue-tsc`).
- `pnpm test` — every `*.test.ts`; scope with `pnpm test:unit` / `test:contract` / `test:smoke`. The harness spawns the real kernel binary and auto-runs `cargo build -p launcher-kernel`.
- `pnpm build` — release kernel + launcher UI + all 17 built-in plugins (view assets and `target/release/<bin>` copies).
- `pnpm spec-check` — manifest self-audit (`docs/plugin-spec.md` §13: G1 / N1–N3, artifacts, remote resources).
- `pnpm ship <kernel|app|plugin <id>>` — one-command release (bump → verify → commit → tag → SSH push); it also writes that channel's `CHANGELOG`, which the publisher turns into update-page notes (`--notes` overrides). Details: `docs/release-channels.md` §1 / §3.
- `pnpm index:key` — generate the ed25519 index-signing keypair (private key → `INDEX_SIGNING_KEY` secret, public key → internal-store).
- `pnpm npm:publish -- --channel <app|kernel|plugins> --dir <dir>` — publish that channel to npm (CI runs it after the GitHub Release; `--dry-run` / `--configure-trust` for local checks).
- `pnpm dev` / `pnpm dev:kernel` / `pnpm dev:ui` — kernel + UI in a browser without the shell; kernel data goes to `.dev-data/`.
- `npm run shell:dev` — run the real macOS app; `npm run app:local` — package it.
- `pnpm app:win` (Windows only) — Windows portable zip at `dist-app/Chassis-<version>-win-<arch>.zip`.
- Windows cross-check from macOS: `cargo check --workspace --exclude launcher-plugin-translate --exclude launcher-plugin-internal-store --target x86_64-pc-windows-msvc`（被排除的两个 crate 依赖 `ring`，其 C 代码在 macOS 主机上交叉不到 MSVC；真 Windows 上无此问题）。The shell also needs a resource compiler for `tauri-build`: point `RC` at a stub whose probe output starts with `OVERVIEW: LLVM Resource Converter` and exits 0. Real Windows builds run in `.github/workflows/build-windows.yml`.
- Windows binaries are **statically linked against the MSVC runtime** (`.cargo/config.toml` sets `+crt-static` for both msvc targets): the portable zip ships no VC++ redistributable, so a dynamic build fails on a clean machine with「找不到 VCRUNTIME140_1.dll」. `pack-win.mjs` scans the packed `.exe`s and fails the build if the flag stops taking effect — CI machines have the runtime installed, so they cannot catch it.

## Release Channels

Four independent tag channels; clients read plain `releases/download/<tag>/...` URLs (no GitHub API, no token). **CI never runs on `main` pushes** (`verify.yml` ignores `main`); dispatch releases build `main`, tag releases build the tag's commit — land the code first, then trigger explicitly.

| Channel | Trigger | Tag |
|---|---|---|
| App, manual | tag `v*` → `release.yml` | `v*` (installed by hand) |
| App, self-update | `gh workflow run app-release.yml --ref main` (or `app/*`) | `app-latest` |
| Kernel | `gh workflow run kernel-release.yml --ref main` (or `kernel/*`) | `kernel-latest` |
| Plugins | `gh workflow run plugins-release.yml --ref main [-f plugins="<id>"]` (or `plugins/*`) | `plugins-latest` |

- **Versions** live in the root `version.json` only; `pnpm version:set` / `version:check` keep it in sync. **Never hand-edit the generated fields** — drift makes clients silently miss updates. Plugin versions stay in each plugin's `package.json`; mechanism versions (`SHELL_HOT_VERSION`, `HOT_UPDATE_VERSION`) are separate.
- Kernel/plugin updates hot-swap without restarting the App; an App release restarts everything and re-deploys the bundled kernel. Publishing is instantly visible to all clients — the only gates are `minHotVersion` / `minShellHotVersion` / `minKernel`.
- **npm/npmmirror read path**: the three self-update channels also publish to npm (`@triple3h/chassis-*`). Clients read the signed index from `registry.npmmirror.com` first and fall back to the tag channels. Secrets: `NPM_TOKEN` (bootstrap; later replaced by trusted publishing/OIDC) and `INDEX_SIGNING_KEY`. The first npm release of a channel must be a full one (plugins: `plugins/all`). Details: [docs/release-channels.md](docs/release-channels.md) §7.
- Release hygiene — asset pruning, registry merge on partial plugin releases, App signing: [docs/release-channels.md](docs/release-channels.md).

## Coding Style

TypeScript (view layer, UI, tooling): two-space indentation, single quotes, no semicolons, `strict` with `verbatimModuleSyntax` (type-only imports need `import type`). Rust (kernel + plugin logic): `rustfmt` defaults, 4-space indent. No linter or formatter is configured for TS — match the surrounding code and rely on `pnpm typecheck`.

- kebab-case plugin ids (`app-launcher`, `text-diff`); PascalCase Vue components (`ResultGrid.vue`); camelCase modules.
- `no-view` / `script` command names equal the artifact filename (`dist/<name>`).
- A kernel diff must never contain capability words — those belong in plugins.

## Testing

Rust tests live beside their modules, plus `apps/kernel/tests/`. TS tests use a dependency-free harness (`tests/helpers/assert.ts`: `test` / `assert` / `assertEqual` / `run`); `tests/helpers/harness.ts` spawns the real kernel (HTTP/SSE + stdio fake shell). Name files `*.test.ts`, write Chinese test titles describing behavior, and place suites in `tests/unit`, `tests/contract` or `tests/smoke` (plugin-internal cases live beside their `core` code). No coverage gate — the gate is the Verify command above.

## Commits & Pull Requests

Commits follow Conventional Commits with a Chinese subject plus an explanatory body: `feat: 启动台结果改为图标网格（分区折叠 / 键盘导航 / 拖拽重排）`, `fix(shell): Windows 应用热更新改轮询重试（目录被占用不再一次判死）`, `chore: 版本升到 0.1.11（app）`.

PRs state the behavior change and rationale, list the commands run (`typecheck` / `test` / `build` / `spec-check`), and attach a screenshot for UI changes.

## Security & Configuration

Runtime data lives in `~/Library/Application Support/Chassis` (macOS) / `%APPDATA%\Chassis` (Windows), overridable with `LAUNCHER_DATA_ROOT`. The pre-rename `Launcher/` directory is adopted once by the shell (macOS only — Windows had no prior release). Plugins may only write under their injected `dataPath`. Kernel protocol output stays on stdout; all logs go to stderr. Never persist secrets in plaintext.
