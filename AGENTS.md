# Repository Guidelines

Launcher is a ZTools-style launcher: Tauri 2 Rust shell (system primitives only) + Node 22 TypeScript kernel sidecar + Vue 3 launcher UI. Three invariants govern every change: the kernel has **zero capabilities** (scanning apps, reading files, launching — all plugins), built-in plugins use the same mechanism as third-party ones, and undeclared capabilities do not exist at runtime.

## Project Structure & Module Organization

| Path | Contents |
|---|---|
| `apps/shell/src/` | Rust/Tauri shell: `lib.rs`, `ipc.rs`, `sidecar.rs`, `primitives/*` |
| `apps/kernel/src/` | Kernel: `kernel.ts`, `api.ts`, `plugin.ts`, `search.ts`, `services/*` |
| `apps/launcher-ui/src/` | Vue UI: `App.vue`, `components/*`, `lib/grid.ts`, `stores/*` |
| `packages/` | `plugin-manifest` (types + validation + contract), `plugin-api` / `plugin-api-node` (SDKs), `ui` (`@launcher/ui` shared kit) |
| `plugins/*` | 8 built-in plugins; each `dist/` ships `index.html`, `assets/`, `package.json` |
| `tests/{unit,contract,smoke}` | Test suites plus `tests/fixtures/echo-plugin` |

## Build, Test, and Development Commands

- `pnpm install` — install the workspace.
- `pnpm typecheck` — `tsc --noEmit` for all packages (Vue packages use `vue-tsc`).
- `pnpm test` — every `*.test.ts`; scope via `pnpm test:unit` / `test:contract` / `pnpm smoke`.
- `pnpm build` — kernel + launcher UI + 8 plugins.
- `pnpm spec-check` — plugin manifest self-audit (N1–N3, artifacts, remote resources).
- `pnpm dev:kernel` / `pnpm dev:ui` — run kernel and UI without the shell.
- `npm run shell:dev` / `npm run app:local` — run or package the real macOS app.

## Coding Style & Naming Conventions

Two-space indentation, single quotes, no semicolons; TypeScript `strict` with `verbatimModuleSyntax` (type-only imports need `import type`). No linter/formatter is configured — match existing style and rely on `pnpm typecheck`. Use kebab-case for plugin ids (`app-launcher`, `text-diff`), PascalCase for Vue components (`ResultGrid.vue`), camelCase for modules; no-view/script entry filenames must equal `commands[].name`. A kernel diff must never contain capability words (app/file/network) — those belong in plugins.

## Testing Guidelines

Tests use a dependency-free harness (`tests/helpers/assert.ts`: `test` / `assert` / `assertEqual` / `run`). Name files `*.test.ts`, write Chinese test titles describing behavior, and place suites in `tests/unit`, `tests/contract`, or `tests/smoke` (plugin-internal cases live beside their `core` code). No coverage gate; before handing off run `pnpm typecheck && pnpm test && pnpm build`, then exercise the packaged `.app`, since production resource paths differ from dev.

## Commit & Pull Request Guidelines

Commits follow Conventional Commits with a Chinese subject plus explanatory body: `feat: 启动台结果改为图标网格（对照 ZTools 的布局与操作逻辑）`, `refactor: 清除第三方兼容层 + plugins/shared 上收为 @launcher/ui`, `chore: .codebuddy 不入库`.

Pull requests: state the behavior change and rationale, list commands run (`typecheck` / `test` / `build` / `spec-check`), and attach a screenshot for UI changes. Spec-first — update `docs/launcher-requirements.md` or `docs/plugin-spec.md` (or add an ADR) before implementing unspecified behavior, and refresh docs whenever slots, fields, or schema change.

## Security & Configuration

Runtime data lives in `~/Library/Application Support/Chassis` (override with `LAUNCHER_DATA_ROOT`; the pre-rename `Launcher/` directory is adopted once by the shell); plugins may only write under their injected `dataPath`. Kernel protocol output stays on stdout, logs on stderr. Never persist secrets in plaintext.
