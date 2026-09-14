<script setup lang="ts">
import IconGlyph from './IconGlyph.vue'
import { formatKeys } from '../lib/keys'
import type { FooterButtonView } from '../stores/ui'

defineProps<{ buttons: FooterButtonView[]; defaultHints: Array<{ keys: string[]; label: string }> }>()
const emit = defineEmits<{ (e: 'action', button: FooterButtonView, itemId?: string): void }>()
</script>

<template>
  <div class="hairline flex items-center gap-3 px-4 h-[36px] text-[11px] text-[var(--fg-muted)]">
    <div v-for="button in buttons" :key="button.id" class="flex items-center gap-1.5">
      <template v-if="button.type === 'button'">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-[var(--hover)]"
          @click="emit('action', button)"
        >
          <IconGlyph v-if="button.icon" :name="button.icon" :size="12" />
          <span>{{ button.label }}</span>
        </button>
      </template>
      <template v-else>
        <button
          type="button"
          class="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-[var(--hover)]"
          @click="emit('action', button)"
        >
          <IconGlyph v-if="button.icon" :name="button.icon" :size="12" />
          <span>{{ button.label }}</span>
        </button>
        <span v-for="item in button.items ?? []" :key="item.id" class="hidden" />
      </template>
      <span v-for="key in formatKeys(button.keys)" :key="key" class="kbd">{{ key }}</span>
    </div>

    <div class="ml-auto flex items-center gap-3">
      <span v-for="hint in defaultHints" :key="hint.label" class="flex items-center gap-1">
        <span v-for="key in hint.keys" :key="key" class="kbd">{{ key }}</span>
        <span>{{ hint.label }}</span>
      </span>
    </div>
  </div>
</template>
