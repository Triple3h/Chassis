<script setup lang="ts">
import { computed, ref } from 'vue'
import SofDialog from '@shared/ui/SofDialog.vue'
import SofIcon from '@shared/ui/SofIcon.vue'
import { passwordHint } from '../core/vault'
import type { Account, Settings } from '../core/types'

const props = defineProps<{
  settings: Settings
  accounts: Account[]
  hasVault: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'update', settings: Settings): void
  (e: 'enable-vault', password: string): void
  (e: 'disable-vault', password: string): void
  (e: 'export'): void
  (e: 'clear-all'): void
}>()

const local = ref<Settings>({ ...props.settings })
const password = ref('')
const password2 = ref('')
const feedback = ref('')

const mode = computed(() => (props.hasVault ? '开' : '关'))
const strength = computed(() => (password.value ? passwordHint(password.value) : '至少 8 位'))
const canSubmit = computed(() => password.value.length >= 8 && password.value === password2.value)

function patch(next: Partial<Settings>) {
  local.value = { ...local.value, ...next }
  emit('update', local.value)
}

function submitVault() {
  feedback.value = ''
  if (!canSubmit.value) return
  if (props.hasVault) {
    emit('disable-vault', password.value)
    feedback.value = '已关闭口令保护'
  } else {
    emit('enable-vault', password.value)
    feedback.value = '已开启口令保护，之后每次打开都要输入口令'
  }
  password.value = ''
  password2.value = ''
}
</script>

<template>
  <SofDialog title="设置" subtitle="所有数据都保存在本机的插件数据目录下" size="md" @close="emit('close')">
    <div class="space-y-5">
      <section class="space-y-2">
        <h3 class="text-[12px] font-semibold text-muted">显示</h3>
        <label class="flex items-center gap-2 text-[13px]">
          <input type="checkbox" :checked="local.hideCodes" @change="patch({ hideCodes: !local.hideCodes })" />
          隐私模式：只显示选中行的验证码
        </label>
        <label class="flex items-center gap-2 text-[13px]">
          <input type="checkbox" :checked="local.showRing" @change="patch({ showRing: !local.showRing })" />
          显示倒计时圆环
        </label>
        <label class="flex items-center gap-3 text-[13px]">
          复制后自动清空剪贴板
          <select
            class="sof-input !w-32"
            :value="local.clearClipboardAfter"
            @change="patch({ clearClipboardAfter: Number(($event.target as HTMLSelectElement).value) })"
          >
            <option :value="0">不清空</option>
            <option :value="15">15 秒后</option>
            <option :value="30">30 秒后</option>
            <option :value="60">60 秒后</option>
          </select>
        </label>
      </section>

      <section class="space-y-2 rounded-lg border border-line p-3">
        <h3 class="flex items-center gap-2 text-[12px] font-semibold text-muted">
          <SofIcon :name="hasVault ? 'lock' : 'unlock'" :size="13" />
          口令保护（{{ mode }}）
        </h3>
        <p class="text-[11.5px] text-muted">
          开启后账户表会用 PBKDF2(250k) + AES-GCM 加密后再落盘，明文密钥不会留在存储文件里。
        </p>
        <div class="grid grid-cols-2 gap-2">
          <input
            v-model="password"
            class="sof-input"
            type="password"
            :placeholder="hasVault ? '输入当前口令以关闭' : '设置口令'"
            autocomplete="new-password"
          />
          <input
            v-model="password2"
            class="sof-input"
            type="password"
            placeholder="再输一次"
            autocomplete="new-password"
          />
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[11.5px]" :class="password && strength ? 'text-warn' : 'text-faint'">{{ strength }}</span>
          <button class="sof-btn ml-auto" :disabled="!canSubmit" @click="submitVault">
            <SofIcon :name="hasVault ? 'unlock' : 'lock'" :size="13" />
            {{ hasVault ? '关闭口令保护' : '开启口令保护' }}
          </button>
        </div>
        <p v-if="feedback" class="text-[11.5px] text-success">{{ feedback }}</p>
      </section>

      <section class="space-y-2">
        <h3 class="text-[12px] font-semibold text-muted">数据</h3>
        <div class="flex flex-wrap items-center gap-2">
          <button class="sof-btn" @click="emit('export')">
            <SofIcon name="download" :size="13" />导出 {{ accounts.length }} 个账户
          </button>
          <button class="sof-btn danger" @click="emit('clear-all')">
            <SofIcon name="trash" :size="13" />清空全部账户
          </button>
        </div>
        <p class="text-[11.5px] text-faint">
          导出文件是明文 JSON，请自行妥善保管；如需跨设备迁移，推荐直接用 Google Authenticator 的迁移二维码。
        </p>
      </section>
    </div>

    <template #footer>
      <button class="sof-btn primary ml-auto" @click="emit('close')">
        <SofIcon name="check" :size="13" />完成
      </button>
    </template>
  </SofDialog>
</template>
