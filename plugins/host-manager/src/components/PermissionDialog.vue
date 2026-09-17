<script setup lang="ts">
import { computed } from 'vue'
import UiDialog from '@launcher/ui/UiDialog.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { copyText } from '@launcher/ui/clipboard'
import { useToast } from '@launcher/ui/toast'

/**
 * 写入权限面板：解释「为什么每写一次弹一次授权」，并提供免授权开关。
 *
 * 免授权 = 把系统 hosts 的写权限一次性授给当前账户（macOS/Linux = POSIX ACL `chmod +a`），
 * 之后保存直接写、不再弹窗；随时可撤销。uTools / SwitchHosts 引导用户手动做的
 * 也是这件事（Windows 上是文件属性 → 安全 → 勾「写入」）。
 */
const props = defineProps<{
  platform: string
  path: string
  /** 当前进程能不能直接写（access W_OK） */
  writable: boolean
  /** 本插件加的那条 ACL 在不在 */
  granted: boolean
  username?: string
  /** 展示用的等价命令 */
  command?: string
  /** 正在等系统授权框 */
  busy: boolean
  error?: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'grant'): void
  (e: 'revoke'): void
}>()

const toast = useToast()

const platformNote = computed(() => {
  if (props.platform === 'darwin') return 'macOS 会弹出系统授权窗口（输密码或用指纹）'
  if (props.platform === 'linux') return 'Linux 会弹出 pkexec 授权窗口'
  return '仅 macOS / Linux 支持免授权写入（Windows 会在后续版本用 icacls 补上）'
})

const supported = computed(() => props.platform === 'darwin' || props.platform === 'linux')
/** 能直写、但 ACL 不是本插件加的（比如文件本来就可写）：没什么可撤销的 */
const externalWritable = computed(() => props.writable && !props.granted)

async function copyCommand() {
  if (!props.command) return
  if (await copyText(props.command)) toast.ok('命令已复制')
}
</script>

<template>
  <UiDialog title="写入权限" :subtitle="path" @close="emit('close')">
    <div class="flex flex-col gap-3">
      <!-- 当前状态 -->
      <div class="flex items-start gap-2 rounded-lg border border-line bg-panel2 p-3">
        <span class="mt-0.5" :class="writable ? 'text-accent' : 'text-warn'">
          <UiIcon :name="writable ? 'unlock' : 'lock'" :size="14" />
        </span>
        <div class="min-w-0 flex-1 text-[12.5px] leading-relaxed">
          <template v-if="writable && granted">
            <div class="font-semibold">免授权写入已开启</div>
            <div class="text-muted">保存时直接写入，不再弹出授权窗口。</div>
          </template>
          <template v-else-if="externalWritable">
            <div class="font-semibold">当前可直接写入</div>
            <div class="text-muted">文件本身就可写（系统设置或你自己改过权限），本插件没有加过免授权。</div>
          </template>
          <template v-else>
            <div class="font-semibold">每次保存都需要系统授权</div>
            <div class="text-muted">{{ platformNote }}；写入前会自动备份现有内容。</div>
          </template>
        </div>
      </div>

      <!-- 出错 -->
      <div v-if="error" class="rounded-lg border border-line bg-panel2 p-2.5 text-[11.5px] text-warn">
        {{ error }}
      </div>

      <!-- 未开启：说明 + 开启 -->
      <template v-if="!writable && supported">
        <div class="rounded-lg border border-line bg-panel2 p-3 text-[12px] leading-relaxed text-muted">
          开启「免授权写入」：把 <span class="launcher-mono">{{ path }}</span> 的写权限
          <span v-if="username">授给当前账户（<span class="launcher-mono">{{ username }}</span>）</span>
          一次，之后保存直接写入、不再弹窗 —— 与 uTools / SwitchHosts 引导你手动做的是同一件事。
          随时可以在这里撤销。
        </div>
        <div class="rounded-lg border border-line bg-panel2 p-3 text-[11.5px] leading-relaxed text-muted">
          <span class="text-warn">安全提示：</span>
          开启后，任何以你的账户运行的程序都能改 hosts（DNS 劫持的常见落脚点）。
          改完重要的环境后建议撤销，恢复系统默认。
        </div>
      </template>

      <!-- 已开启：撤销 -->
      <template v-if="granted">
        <div class="rounded-lg border border-line bg-panel2 p-3 text-[11.5px] leading-relaxed text-muted">
          撤销后会回到系统默认：每次保存都要经过系统授权窗口。
        </div>
      </template>

      <!-- 手工做的话就是这条 -->
      <div v-if="command && supported" class="flex flex-col gap-1.5">
        <div class="text-[11.5px] text-muted">手工做的话，等价命令是：</div>
        <div class="launcher-mono launcher-scroll max-h-20 rounded-lg border border-line bg-bg p-2.5 text-[11.5px] break-all">
          {{ command }}
        </div>
      </div>
    </div>

    <template #footer>
      <button v-if="command" class="launcher-btn" @click="copyCommand">
        <UiIcon name="copy" :size="12" /> 复制命令
      </button>
      <div class="flex-1" />
      <button class="launcher-btn" @click="emit('close')">关闭</button>
      <button v-if="granted" class="launcher-btn" :disabled="busy" @click="emit('revoke')">
        {{ busy ? '等待系统授权…' : '撤销免授权' }}
      </button>
      <button
        v-else-if="!writable && supported"
        class="launcher-btn primary"
        :disabled="busy"
        @click="emit('grant')"
      >
        {{ busy ? '等待系统授权…' : '开启免授权写入' }}
      </button>
    </template>
  </UiDialog>
</template>
