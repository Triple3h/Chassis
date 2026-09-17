<script setup lang="ts">
/**
 * 极简图标集（自绘几何图形，无第三方依赖，避免为 20 个图标引入整个图标库）。
 * 统一 24x24 viewBox、currentColor 描边，尺寸通过 size 控制。
 */
const props = withDefaults(
  defineProps<{
    name: string
    size?: number | string
    /** 描边粗细 */
    weight?: number
  }>(),
  { size: 16, weight: 1.8 },
)

const ICONS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5 7.5 20h9l1-13.5M10.5 10v6.5M13.5 10v6.5"/>',
  download: '<path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5M4 20h16"/>',
  upload: '<path d="M12 15.5v-12M7.5 8 12 3.5 16.5 8M4 20h16"/>',
  qr: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/><rect x="8" y="8" width="8" height="8" rx="1.2"/>',
  clipboard:
    '<path d="M9 4.5h6v2.5H9z"/><path d="M9 5.5H6.5a1.5 1.5 0 0 0-1.5 1.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V7a1.5 1.5 0 0 0-1.5-1.5H15"/>',
  key: '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21M17.5 12v3M14.5 12v2.5"/>',
  shield: '<path d="M12 3.5 19 6v6c0 4.2-3 7-7 8.5-4-1.5-7-4.3-7-8.5V6z"/><path d="M9.2 12.2l2 2 3.6-3.9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  chevronDown: '<path d="M6 9.5 12 15.5 18 9.5"/>',
  chevronRight: '<path d="M9.5 6 15.5 12 9.5 18"/>',
  chevronLeft: '<path d="M14.5 6 8.5 12 14.5 18"/>',
  close: '<path d="M6 6 18 18M18 6 6 18"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5V10h-5.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 7.5-2"/>',
  sliders: '<path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2"/><circle cx="10" cy="16" r="2"/>',
  alert: '<path d="M12 3.8 21 19.5H3z"/><path d="M12 9.5v4.5M12 16.8v.2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  arrowLeft: '<path d="M20 12H4M10.5 5.5 4 12l6.5 6.5"/>',
  arrowRight: '<path d="M4 12h16M13.5 5.5 20 12l-6.5 6.5"/>',
  sortAsc: '<path d="M7 5v14M3.5 15 7 18.5 10.5 15M14 7h6M14 12h4.5M14 17h3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="M4 4l16 16"/><path d="M9.5 6.2A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.2 3.9M6.3 8.2A17 17 0 0 0 2.5 12S6 18 12 18c1 0 1.9-.2 2.7-.5"/>',
  pencil: '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M14.5 5.5 18.5 9.5"/>',
  file: '<path d="M6 3.5h7L18.5 9v11.5H6z"/><path d="M12.5 3.5V9h6"/>',
  folder: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z"/>',
  zap: '<path d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6z"/>',
  camera: '<path d="M4 8.5h3l1.5-2h7L17 8.5h3v10H4z"/><circle cx="12" cy="13.5" r="3.2"/>',
  wrap: '<path d="M4 6h16M4 18h6M4 12h12.5a3.5 3.5 0 0 1 0 7H13"/><path d="M15 16.5 13 19l2 2.5"/>',
  braces: '<path d="M9 3.5C6.5 3.5 7.5 10 5 12c2.5 2 1.5 8.5 4 8.5M15 3.5c2.5 0 1.5 6.5 4 8.5-2.5 2-1.5 8.5-4 8.5"/>',
  branch: '<circle cx="7" cy="6" r="2.5"/><circle cx="7" cy="18" r="2.5"/><circle cx="17" cy="9" r="2.5"/><path d="M7 8.5v7M17 11.5c0 3-3 4-7 4"/>',
  history: '<path d="M12 7.5V12l3 2"/><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 5.5V10H8"/>',
  external: '<path d="M14 4.5h5.5V10M19 5 11 13"/><path d="M18 14.5v4A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4"/>',
  save: '<path d="M5 4.5h11L19.5 8v11.5H5z"/><path d="M8.5 4.5v5h7v-5M8.5 19.5v-5h7v5"/>',
  wand: '<path d="M5 19 16 8M14.5 4.5l1 2 2-1-1 2 2 1-2 1 1 2-2-1-1 2-1-2-2 1 1-2-2-1 2-1z"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 18.5 10 13l3.5 3.5L16.5 14l3 3"/>',
  pin: '<path d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>',
  calculator:
    '<rect x="4.5" y="3" width="15" height="18" rx="2"/><path d="M8 7h8"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01M8.5 15h.01M12 15h.01M15.5 15v3.5M8.5 18.5h3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  columns: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 4.5v15"/>',
  video: '<rect x="2.5" y="6" width="14" height="12" rx="2"/><path d="m16.5 12 5-3v11l-5-3z"/>',
  play: '<path d="M7.5 4.5 19.5 12 7.5 19.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  bell: '<path d="M6 9.5a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10.5 20a2 2 0 0 0 3 0"/>',
  timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v4l2.5 1.5M9.5 3h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M8 3.5v3M16 3.5v3M3.5 10h17"/>',
}
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="props.weight"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="shrink-0"
    v-html="ICONS[props.name] ?? ICONS.info"
  />
</template>
