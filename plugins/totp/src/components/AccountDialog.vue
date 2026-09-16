<script setup lang="ts">
import { computed, ref } from 'vue'
import UiDialog from '@launcher/ui/UiDialog.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import UiSelect from '@launcher/ui/UiSelect.vue'
import { formatSecret, validateSecret } from '../core/base32'
import { ALGORITHMS, normalizeAccount, type Account } from '../core/types'

const props = defineProps<{ account?: Account | null }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'save', account: Account): void; (e: 'delete', id: string): void }>()

const isEdit = computed(() => !!props.account)
const draft = ref<Account>(
  normalizeAccount(
    props.account ?? {
      secret: '',
      issuer: '',
      name: '',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      type: 'totp',
    },
  ),
)
const showSecret = ref(false)
const touched = ref(false)

const ALGORITHM_OPTIONS = ALGORITHMS.map((item) => ({ value: item, label: item }))
const DIGIT_OPTIONS = [
  { value: 6, label: '6 位' },
  { value: 8, label: '8 位' },
]

const secretError = computed(() => (draft.value.secret ? validateSecret(draft.value.secret) : '密钥不能为空'))
const canSave = computed(() => !secretError.value)

/** 密钥输入时实时清洗：去空格、转大写 */
function onSecretInput(e: Event) {
  const el = e.target as HTMLInputElement
  draft.value.secret = el.value.replace(/[\s-=]/g, '').toUpperCase()
}

function save() {
  touched.value = true
  if (!canSave.value) return
  emit('save', normalizeAccount({ ...draft.value, id: props.account?.id }))
}
</script>

<template>
  <UiDialog
    :title="isEdit ? '编辑账户' : '添加账户'"
    subtitle="密钥只保存在本机插件的存储里，不会联网"
    size="md"
  >
    <div class="space-y-3">
      <div class="flex gap-2">
        <button
          v-for="t in [{ v: 'totp', l: 'TOTP（按时间）' }, { v: 'hotp', l: 'HOTP（计数器）' }]"
          :key="t.v"
          class="launcher-btn"
          :class="{ primary: draft.type === t.v }"
          @click="draft.type = t.v as 'totp' | 'hotp'"
        >
          {{ t.l }}
        </button>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">服务 / 发行方</span>
          <input v-model="draft.issuer" class="launcher-input" placeholder="GitHub" spellcheck="false" />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">账号</span>
          <input v-model="draft.name" class="launcher-input" placeholder="ada@example.com" spellcheck="false" />
        </label>
      </div>

      <label class="block">
        <span class="mb-1 flex items-center gap-2 text-[11.5px] text-muted">
          密钥（Base32）
          <button class="launcher-btn ghost !px-1.5 !py-0" @click="showSecret = !showSecret">
            <UiIcon :name="showSecret ? 'eyeOff' : 'eye'" :size="12" />
          </button>
          <span v-if="draft.secret && showSecret" class="launcher-code text-faint">{{ formatSecret(draft.secret) }}</span>
        </span>
        <input
          :value="draft.secret"
          class="launcher-input launcher-code"
          :type="showSecret ? 'text' : 'password'"
          placeholder="JBSWY3DPEHPK3PXP"
          spellcheck="false"
          autocomplete="off"
          @input="onSecretInput"
        />
        <span v-if="touched && secretError" class="mt-1 block text-[11.5px] text-danger">{{ secretError }}</span>
      </label>

      <div class="grid grid-cols-3 gap-3">
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">算法</span>
          <UiSelect
            :model-value="draft.algorithm"
            :options="ALGORITHM_OPTIONS"
            @update:model-value="(value) => (draft.algorithm = value as Account['algorithm'])"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">位数</span>
          <UiSelect
            :model-value="draft.digits"
            :options="DIGIT_OPTIONS"
            @update:model-value="(value) => (draft.digits = Number(value))"
          />
        </label>
        <label v-if="draft.type === 'totp'" class="block">
          <span class="mb-1 block text-[11.5px] text-muted">周期（秒）</span>
          <input v-model.number="draft.period" type="number" min="1" class="launcher-input" />
        </label>
        <label v-else class="block">
          <span class="mb-1 block text-[11.5px] text-muted">计数器</span>
          <input v-model.number="draft.counter" type="number" min="0" class="launcher-input" />
        </label>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">分组（可选）</span>
          <input v-model="draft.group" class="launcher-input" placeholder="工作" spellcheck="false" />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">备注（可选）</span>
          <input v-model="draft.note" class="launcher-input" placeholder="备用邮箱绑定" spellcheck="false" />
        </label>
      </div>
    </div>

    <template #footer>
      <button v-if="isEdit" class="launcher-btn danger" @click="emit('delete', draft.id)">
        <UiIcon name="trash" :size="13" />删除
      </button>
      <div class="ml-auto flex items-center gap-2">
        <button class="launcher-btn" @click="emit('close')">取消</button>
        <button class="launcher-btn primary" :disabled="!canSave" @click="save">
          <UiIcon name="check" :size="13" />保存
        </button>
      </div>
    </template>
  </UiDialog>
</template>
