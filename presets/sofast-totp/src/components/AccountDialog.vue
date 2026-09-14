<script setup lang="ts">
import { computed, ref } from 'vue'
import SofDialog from '@shared/ui/SofDialog.vue'
import SofIcon from '@shared/ui/SofIcon.vue'
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
  <SofDialog
    :title="isEdit ? '编辑账户' : '添加账户'"
    subtitle="密钥只保存在本机插件的存储里，不会联网"
    size="md"
  >
    <div class="space-y-3">
      <div class="flex gap-2">
        <button
          v-for="t in [{ v: 'totp', l: 'TOTP（按时间）' }, { v: 'hotp', l: 'HOTP（计数器）' }]"
          :key="t.v"
          class="sof-btn"
          :class="{ primary: draft.type === t.v }"
          @click="draft.type = t.v as 'totp' | 'hotp'"
        >
          {{ t.l }}
        </button>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">服务 / 发行方</span>
          <input v-model="draft.issuer" class="sof-input" placeholder="GitHub" spellcheck="false" />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">账号</span>
          <input v-model="draft.name" class="sof-input" placeholder="ada@example.com" spellcheck="false" />
        </label>
      </div>

      <label class="block">
        <span class="mb-1 flex items-center gap-2 text-[11.5px] text-muted">
          密钥（Base32）
          <button class="sof-btn ghost !px-1.5 !py-0" @click="showSecret = !showSecret">
            <SofIcon :name="showSecret ? 'eyeOff' : 'eye'" :size="12" />
          </button>
          <span v-if="draft.secret && showSecret" class="sof-code text-faint">{{ formatSecret(draft.secret) }}</span>
        </span>
        <input
          :value="draft.secret"
          class="sof-input sof-code"
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
          <select v-model="draft.algorithm" class="sof-input">
            <option v-for="a in ALGORITHMS" :key="a" :value="a">{{ a }}</option>
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">位数</span>
          <select v-model.number="draft.digits" class="sof-input">
            <option :value="6">6 位</option>
            <option :value="8">8 位</option>
          </select>
        </label>
        <label v-if="draft.type === 'totp'" class="block">
          <span class="mb-1 block text-[11.5px] text-muted">周期（秒）</span>
          <input v-model.number="draft.period" type="number" min="1" class="sof-input" />
        </label>
        <label v-else class="block">
          <span class="mb-1 block text-[11.5px] text-muted">计数器</span>
          <input v-model.number="draft.counter" type="number" min="0" class="sof-input" />
        </label>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">分组（可选）</span>
          <input v-model="draft.group" class="sof-input" placeholder="工作" spellcheck="false" />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">备注（可选）</span>
          <input v-model="draft.note" class="sof-input" placeholder="备用邮箱绑定" spellcheck="false" />
        </label>
      </div>
    </div>

    <template #footer>
      <button v-if="isEdit" class="sof-btn danger" @click="emit('delete', draft.id)">
        <SofIcon name="trash" :size="13" />删除
      </button>
      <div class="ml-auto flex items-center gap-2">
        <button class="sof-btn" @click="emit('close')">取消</button>
        <button class="sof-btn primary" :disabled="!canSave" @click="save">
          <SofIcon name="check" :size="13" />保存
        </button>
      </div>
    </template>
  </SofDialog>
</template>
