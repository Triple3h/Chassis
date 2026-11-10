/**
 * 图标：不引第三方图标库（体积 + 离线）。**全部几何为本仓库自绘**
 * （Liquid Glass 线稿规范：24 viewBox、1.75 描边、圆头圆角、20px 光学尺寸、
 * 视觉重心统一在 12,12），名字沿用 lucide 的命名习惯只为兼容既有清单。
 *
 * 值有两种形态：新条目直接写 svg 子元素（`<path>` / `<circle>` / `<rect>` …），
 * 早期条目只有单条 path 的 `d`，渲染时自动补 `<path>` 外壳。
 * 插件可以传图标名（`terminal` / `GitCompare` / `git-compare` 都认），命中则用内置图标渲染。
 *
 * **这份表是唯一源**：宿主结果网格（`apps/launcher-ui/src/components/IconGlyph.vue`）、
 * 设置页插件列表（`plugins/internal-settings`）与插件页的 `UiIcon.vue` 都从这里取 ——
 * 同一个图标在任何界面都必须是同一个图形、同一套笔触。
 */
export const ICONS: Record<string, string> = {
  /* ── 搜索与外壳 ─────────────────────────────────────────────── */
  search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m15.8 15.8 4.5 4.5"/>',
  'app-window': '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18"/><path d="M7 6.5h.01M9.6 6.5h.01"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9.5 3 2.8-3 2.8"/><path d="M13 15.3h4"/>',
  command:
    '<path d="M9 6a3 3 0 1 0-3 3h3V6Zm0 12a3 3 0 1 1-3-3h3v3Zm6-12a3 3 0 1 1 3 3h-3V6Zm0 12a3 3 0 1 0 3-3h-3v3ZM9 9h6v6H9Z"/>',
  settings:
    '<circle cx="12" cy="12" r="7.6"/><circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v1.9M12 19.5v1.9M21.4 12h-1.9M4.5 12H2.6M18.6 5.4l-1.3 1.3M6.7 17.3l-1.3 1.3M18.6 18.6l-1.3-1.3M6.7 6.7 5.4 5.4"/>',

  /* ── 文件与内容 ─────────────────────────────────────────────── */
  file: '<path d="M13.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V9.5Z"/><path d="M13.5 3.5V7a2.5 2.5 0 0 0 2.5 2.5h3.5"/>',
  'file-text':
    '<path d="M13.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V9.5Z"/><path d="M13.5 3.5V7a2.5 2.5 0 0 0 2.5 2.5h3.5"/><path d="M8.5 13h7M8.5 16.5h4.5"/>',
  folder:
    '<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3l2 2.5h7A2.5 2.5 0 0 1 20.5 10v7A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17Z"/>',
  'file-search':
    '<path d="M13.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h4.5"/><path d="M13.5 3.5 20 10v2"/><path d="M13.5 3.5V8a2 2 0 0 0 2 2H20"/><circle cx="15" cy="15.5" r="2.8"/><path d="m17 17.5 2.2 2.2"/>',
  clipboard:
    '<rect x="5" y="4.5" width="14" height="16.5" rx="2.5"/><rect x="9" y="2.5" width="6" height="4" rx="1.5"/><path d="M9 11h6M9 15h4"/>',
  save: '<path d="M5 3.5h11L20.5 8v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 20V5A1.5 1.5 0 0 1 5 3.5Z"/><path d="M8 3.5v5h7v-5"/><path d="M8 20.5v-6h8v6"/>',
  braces:
    '<path d="M9 3.5c-1.8 0-2.5 1-2.5 2.8v2.4c0 1.4-.6 2.3-2 2.8 1.4.5 2 1.4 2 2.8v2.4c0 1.8.7 2.8 2.5 2.8"/><path d="M15 3.5c1.8 0 2.5 1 2.5 2.8v2.4c0 1.4.6 2.3 2 2.8-1.4.5-2 1.4-2 2.8v2.4c0 1.8-.7 2.8-2.5 2.8"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m5 18 5-5 3.5 3.5L16.5 14l3 3"/>',
  video:
    '<rect x="3" y="6" width="12.5" height="12" rx="2.5"/><path d="m15.5 10.5 4.3-2.4a.8.8 0 0 1 1.2.7v6.4a.8.8 0 0 1-1.2.7l-4.3-2.4"/>',
  languages:
    '<path d="M4 5.5h9M8.5 3v2.5M10.5 5.5c-.5 3.6-2.8 6.3-6.5 8"/><path d="M6 9.5c1.2 2.3 3.2 4 6 4.8"/><path d="m12.5 20 3.8-9 3.8 9"/><path d="M13.9 17h4.8"/>',
  calculator:
    '<rect x="4.5" y="3" width="15" height="18" rx="3"/><rect x="7.5" y="6" width="9" height="3.5" rx="1"/><path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 16.5h.01M12 16.5h.01M15.5 16.5v2.5M8.5 19h3"/>',
  'list-todo':
    '<rect x="3.5" y="4.5" width="5.5" height="5.5" rx="1.5"/><path d="m3.8 16.5 1.6 1.6 2.6-2.8"/><path d="M13 6.5h7.5M13 12h7.5M13 17.5h7.5"/>',
  list: '<path d="M8.5 6h12M8.5 12h12M8.5 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  'qr-code':
    '<rect x="3.5" y="3.5" width="6" height="6" rx="1.5"/><rect x="14.5" y="3.5" width="6" height="6" rx="1.5"/><rect x="3.5" y="14.5" width="6" height="6" rx="1.5"/><path d="M14.5 14.5h2.5v2.5h-2.5zM19 14.5h2M17 20.5h4V18M9.5 9.5h.01M14.5 9.5h.01M9.5 17h.01M20.5 9.5h.01M12 12h.01M12 20.5h.01M20.5 20.5h.01"/>',

  /* ── 数据与开发 ─────────────────────────────────────────────── */
  server:
    '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><path d="M7 7.25h.01M7 16.75h.01"/><path d="M15.5 7.25h2M15.5 16.75h2"/>',
  'git-compare':
    '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v3.5A3.5 3.5 0 0 0 9.5 15.5h5"/><path d="m12.5 13.3 2.5 2.2-2.5 2.2"/><path d="M18 15.5V12a3.5 3.5 0 0 0-3.5-3.5h-5"/><path d="m11.5 10.7-2.5-2.2 2.5-2.2"/>',
  'sliders-horizontal':
    '<path d="M4 7h5M13 7h7"/><circle cx="11" cy="7" r="2"/><path d="M4 12h9M17 12h3"/><circle cx="15" cy="12" r="2"/><path d="M4 17h2M10 17h10"/><circle cx="8" cy="17" r="2"/>',
  'columns-2': '<rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M12 4v16"/>',
  branch:
    '<circle cx="7" cy="6" r="2.5"/><circle cx="7" cy="18" r="2.5"/><circle cx="17" cy="9" r="2.5"/><path d="M7 8.5v7"/><path d="M17 11.5c0 3-3 4-7 4"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="2.5"/><path d="M10 2.5v3M14 2.5v3M10 18.5v3M14 18.5v3M2.5 10h3M2.5 14h3M18.5 10h3M18.5 14h3"/>',

  /* ── 状态与安全 ─────────────────────────────────────────────── */
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 8h.01"/>',
  alert: '<path d="M12 3.8 21 19.5H3Z"/><path d="M12 9.5v4.5"/><path d="M12 17h.01"/>',
  'shield-check':
    '<path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.1-7 8.9-4.1-1.8-7-4.7-7-8.9V6Z"/><path d="m8.8 11.8 2.3 2.3 4.2-4.4"/>',
  shield: '<path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.1-7 8.9-4.1-1.8-7-4.7-7-8.9V6Z"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.5v2.5"/>',
  unlock:
    '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 7.6-1.7"/><path d="M12 14.5v2.5"/>',
  key: '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21"/><path d="M17.5 12v3M14.5 12v2.5"/>',
  eye: '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off':
    '<path d="m4 4 16 16"/><path d="M9.6 6.3A9.5 9.5 0 0 1 12 6c6 0 9.5 6 9.5 6a17.6 17.6 0 0 1-3.3 4M6.4 8.2A17.4 17.4 0 0 0 2.5 12S6 18 12 18c1 0 1.9-.2 2.8-.5"/>',

  /* ── 操作与导航 ─────────────────────────────────────────────── */
  plus: '<path d="M12 4.5v15M4.5 12h15"/>',
  minus: '<path d="M4.5 12h15"/>',
  x: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M6 16H5a2.5 2.5 0 0 1-2.5-2.5v-8A2.5 2.5 0 0 1 5 3h8A2.5 2.5 0 0 1 15.5 5.5V6"/>',
  trash:
    '<path d="M4 6.5h16"/><path d="M9.5 6.5V5A1.5 1.5 0 0 1 11 3.5h2A1.5 1.5 0 0 1 14.5 5v1.5"/><path d="M6.5 6.5 7.3 19a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12.5"/><path d="M10 10.5v6M14 10.5v6"/>',
  pin: '<path d="M9.5 3.5h5v1a2 2 0 0 1-1 1.74V10l3 2.2A2.2 2.2 0 0 1 15.2 16H8.8a2.2 2.2 0 0 1-1.3-3.8l3-2.2V6.24a2 2 0 0 1-1-1.74Z"/><path d="M12 16v4.5"/>',
  'pin-off':
    '<path d="M4 4l16 16"/><path d="M9.5 3.5h5v1a2 2 0 0 1-1 1.74v2.6"/><path d="M14 11.3l2.5 1.8A2.2 2.2 0 0 1 15.2 16H8.8a2.2 2.2 0 0 1-1.3-3.8l2.2-1.6"/><path d="M12 16v4.5"/>',
  link: '<path d="M9.8 14.2 14.2 9.8"/><path d="M11 7.6 12.8 5.8a3.8 3.8 0 0 1 5.4 5.4l-1.8 1.8"/><path d="M13 16.4l-1.8 1.8a3.8 3.8 0 0 1-5.4-5.4l1.8-1.8"/>',
  external:
    '<path d="M14 4.5h5.5V10"/><path d="M19 5 11.5 12.5"/><path d="M18 14.5v4A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4"/>',
  refresh: '<path d="M19.6 9A8 8 0 1 0 20 12"/><path d="M20 4.5V9h-4.5"/>',
  maximize:
    '<path d="M9 3.5H5.5A2 2 0 0 0 3.5 5.5V9M15 3.5h3.5a2 2 0 0 1 2 2V9M20.5 15v3.5a2 2 0 0 1-2 2H15M9 20.5H5.5a2 2 0 0 1-2-2V15"/>',
  power: '<path d="M12 3v8.5"/><path d="M17.5 6.7a7.5 7.5 0 1 1-11 0"/>',
  history: '<path d="M4.5 5v4.5H9"/><path d="M4.8 9.5A7.7 7.7 0 1 1 4.5 14"/><path d="M12 8v4l2.8 1.7"/>',
  globe:
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.2 2.4 3.4 5.3 3.4 8.5S14.2 18.1 12 20.5C9.8 18.1 8.6 15.2 8.6 12S9.8 5.9 12 3.5Z"/>',
  'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
  'chevron-left': '<path d="m14.5 6-6 6 6 6"/>',
  'chevron-down': '<path d="m6 9.5 6 6 6-6"/>',
  'chevron-up': '<path d="m6 14.5 6-6 6 6"/>',
  'arrow-left': '<path d="M20 12H4.5"/><path d="m10.5 5.5-6.5 6.5 6.5 6.5"/>',
  'arrow-right': '<path d="M4 12h15.5"/><path d="m13.5 5.5 6.5 6.5-6.5 6.5"/>',
  'sort-asc': '<path d="M7 4.5v15"/><path d="m3.8 15.8 3.2 3.2 3.2-3.2"/><path d="M14 7h6M14 12h4.5M14 17h3"/>',
  download: '<path d="M12 3.5v11.5"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 20.5h16"/>',
  upload: '<path d="M12 15.5V4"/><path d="M7.5 8.5 12 4l4.5 4.5"/><path d="M4 20.5h16"/>',
  pencil: '<path d="M4.5 19.5h4L20 8l-4-4L4.5 15.5Z"/><path d="m14 6 4 4"/>',
  wand: '<path d="M5 19 16 8"/><path d="m14.5 4.5 1 2.1 2.1-1-1 2.1 2.1 1-2.1 1 1 2.1-2.1-1-1 2.1-1-2.1-2.1 1 1-2.1-2.1-1 2.1-1Z"/>',
  wrap: '<path d="M4 6h16M4 18h6"/><path d="M4 12h12.5a3.5 3.5 0 0 1 0 7H13"/><path d="m15 16.5-2 2.5 2 2.5"/>',
  camera:
    '<rect x="3.5" y="7.5" width="17" height="12" rx="3"/><path d="M8.5 7.5 10 5h4l1.5 2.5"/><circle cx="12" cy="13.5" r="3.2"/>',
  zap: '<path d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6Z"/>',
  play: '<path d="M8 4.8 19 12 8 19.2Z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>',
  bell: '<path d="M6 9.5a6 6 0 0 1 12 0c0 5 1.8 6 1.8 6H4.2s1.8-1 1.8-6Z"/><path d="M10.5 20a2 2 0 0 0 3 0"/>',
  timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 1.7"/><path d="M9.5 2.8h5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  puzzle:
    '<path d="M10 4.5h4V6a2 2 0 1 0 4 0V4.5h1.5A1.5 1.5 0 0 1 21 6v4h-1.5a2 2 0 1 0 0 4H21v4.5a1.5 1.5 0 0 1-1.5 1.5H15v-1.5a2 2 0 1 0-4 0V20H6.5A1.5 1.5 0 0 1 5 18.5V14h1.5a2 2 0 1 0 0-4H5V6a1.5 1.5 0 0 1 1.5-1.5H10Z"/>',
  loader:
    '<path d="M12 3v3M12 18v3M21 12h-3M6 12H3M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M18.4 18.4l-2.1-2.1M7.7 7.7 5.6 5.6"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7 5.3 5.3"/>',
}

/** 命名兼容：旧名 / 简写都指向同一份几何 */
const ALIASES: Record<string, string> = {
  sliders: 'sliders-horizontal',
  columns: 'columns-2',
  close: 'x',
  qr: 'qr-code',
  maximize2: 'maximize',
}

/** PascalCase / camelCase 归一化成 kebab-case：`GitCompare` → `git-compare`（lucide 官方名是前者） */
function toKebab(name: string): string {
  return name
    .replace(/^lucide:/i, '')
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

/** 查表并转成可直接 v-html / innerHTML 的 svg 子元素；未命中返回 null（调用方画首字母占位） */
export function iconMarkup(name: string | undefined): string | null {
  if (!name) return null
  const key = toKebab(name)
  const raw = ICONS[key] ?? ICONS[ALIASES[key] ?? '']
  if (!raw) return null
  return raw.startsWith('<') ? raw : `<path d="${raw}" />`
}

/**
 * 完整 `<svg>` 外壳（原生 DOM 页面用；Vue 侧用 `iconMarkup` 配 `v-html` 自行渲染）。
 * 描边参数与 `IconGlyph.vue` / `UiIcon.vue` 保持一致：24 viewBox、currentColor、1.75 圆头。
 */
export function iconSvg(name: string | undefined, size: number, weight = 1.75): string | null {
  const markup = iconMarkup(name)
  if (!markup) return null
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${weight}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`
}
