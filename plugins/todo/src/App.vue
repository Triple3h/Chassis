<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import UiSelect from '@launcher/ui/UiSelect.vue'
import { useToast } from '@launcher/ui/toast'
import { isTypingTarget, matchKey, modLabel } from '@launcher/ui/keys'
import { useVirtualList } from '@launcher/ui/virtual'
import { hostUi, notify } from '@launcher/api'
import type { Priority, Task, TaskFilter } from './core/tasks'
import {
  createTask,
  dueLabel,
  matchesFilter,
  parseDue,
  sortTasks,
  stats,
  toggleDone,
  updateTask,
} from './core/tasks'
import type { PomodoroState } from './core/pomodoro'
import { createPomodoro, formatClock, pause, progress, reset, setDurations, skip, start, tick } from './core/pomodoro'
import { loadPomodoro, loadTasks, savePomodoro, saveTasks } from './core/store'
import TaskDialog from './components/TaskDialog.vue'

const ROW_HEIGHT = 48

const tasks = ref<Task[]>([])
const loaded = ref(false)
const filter = ref<TaskFilter>('open')
const selectedId = ref('')
const pomoOpen = ref(false)
const pomodoro = ref<PomodoroState>(createPomodoro())
const draftTitle = ref('')
const draftPriority = ref<Priority>(0)
const draftDue = ref('')
const editing = ref<Task | null>(null)
const listEl = ref<HTMLElement | null>(null)
const addEl = ref<HTMLInputElement | null>(null)
const toast = useToast()

const visible = computed(() => sortTasks(tasks.value.filter((task) => matchesFilter(task, filter.value))))
const summary = computed(() => stats(tasks.value))
const selectedTask = computed(() => tasks.value.find((task) => task.id === selectedId.value) ?? null)
const selectedIndex = computed(() => visible.value.findIndex((task) => task.id === selectedId.value))

const { startIndex, endIndex, offsetY, totalHeight, scrollToIndex } = useVirtualList(listEl, {
  count: computed(() => visible.value.length),
  rowHeight: ROW_HEIGHT,
})
const rows = computed(() => visible.value.slice(startIndex.value, endIndex.value))

const tabs: Array<{ value: TaskFilter; label: string; count: () => number }> = [
  { value: 'open', label: '待处理', count: () => summary.value.open },
  { value: 'today', label: '今天', count: () => summary.value.today + summary.value.overdue },
  { value: 'done', label: '已完成', count: () => summary.value.done },
  { value: 'all', label: '全部', count: () => tasks.value.length },
]

watch(
  visible,
  (list) => {
    if (!list.length) {
      selectedId.value = ''
      return
    }
    if (!list.some((task) => task.id === selectedId.value)) selectedId.value = list[0]?.id ?? ''
  },
  { immediate: true },
)

const priorityOptions = [
  { value: 0, label: '普通' },
  { value: 1, label: '重要' },
  { value: 2, label: '紧急' },
]
const focusOptions = [15, 25, 45, 60].map((minutes) => ({ value: minutes, label: `${minutes} 分钟` }))
const breakOptions = [5, 10, 15].map((minutes) => ({ value: minutes, label: `${minutes} 分钟` }))

/* ------------------------------------------------------------- 读写 */

async function persist(): Promise<void> {
  await saveTasks(tasks.value)
}

async function load(): Promise<void> {
  tasks.value = await loadTasks()
  pomodoro.value = await loadPomodoro()
  loaded.value = true
  // 搜索框里的文字直接当新任务草稿（「功能关键字快速捕获」那条路径）
  const seed = (await hostUi.getSearchContent().catch(() => '')).trim()
  if (looksLikeContent(seed)) draftTitle.value = seed
  void nextTick(() => addEl.value?.focus())
}

/** 命中本插件的关键词就不当内容用（用户是在搜插件，不是要记这条） */
const TRIGGERS = ['todo', '待办', '任务', '清单', '番茄钟', '提醒', 'pomodoro']
function looksLikeContent(text: string): boolean {
  if (!text || text.length > 80) return false
  return !TRIGGERS.includes(text.toLowerCase())
}

/* ------------------------------------------------------------- 任务操作 */

function scrollToSelected(): void {
  const index = selectedIndex.value
  if (index >= 0) scrollToIndex(index)
}

async function addTask(): Promise<void> {
  const title = draftTitle.value.trim()
  if (!title) {
    addEl.value?.focus()
    return
  }
  let dueAt: number | undefined
  const dueRaw = draftDue.value.trim()
  if (dueRaw) {
    dueAt = parseDue(dueRaw)
    if (dueAt === undefined) {
      toast.err('截止日期看不懂：试试 明天 / 周五 / 3天后 / 2026-09-20')
      return
    }
  }
  const task = createTask(title, { priority: draftPriority.value, ...(dueAt === undefined ? {} : { dueAt }) })
  tasks.value = [task, ...tasks.value]
  draftTitle.value = ''
  draftDue.value = ''
  draftPriority.value = 0
  selectedId.value = task.id
  await persist()
  if (filter.value === 'done') filter.value = 'open'
  void nextTick(() => {
    scrollToSelected()
    addEl.value?.focus()
  })
  toast.ok('已加入待办')
}

async function toggle(task: Task): Promise<void> {
  tasks.value = tasks.value.map((item) => (item.id === task.id ? toggleDone(item) : item))
  await persist()
}

async function removeTask(task: Task): Promise<void> {
  tasks.value = tasks.value.filter((item) => item.id !== task.id)
  if (selectedId.value === task.id) selectedId.value = ''
  editing.value = null
  await persist()
  toast.info('已删除')
}

async function saveEdit(patch: { title: string; note: string; priority: Priority; dueAt?: number }): Promise<void> {
  const target = editing.value
  if (!target) return
  const next = updateTask(target, {
    title: patch.title,
    note: patch.note,
    priority: patch.priority,
    ...(patch.dueAt === undefined ? { dueAt: undefined } : { dueAt: patch.dueAt }),
  })
  tasks.value = tasks.value.map((item) => (item.id === next.id ? next : item))
  editing.value = null
  await persist()
  toast.ok('已保存')
}

async function clearCompleted(): Promise<void> {
  const before = tasks.value.length
  tasks.value = tasks.value.filter((task) => !task.done)
  if (before === tasks.value.length) {
    toast.info('没有已完成的待办')
    return
  }
  await persist()
  toast.ok(`清掉了 ${before - tasks.value.length} 条已完成的待办`)
}

function moveSelection(delta: number): void {
  const list = visible.value
  if (!list.length) return
  const current = selectedIndex.value
  const next = Math.min(list.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta))
  const task = list[next]
  if (!task) return
  selectedId.value = task.id
  scrollToIndex(next)
}

/* ------------------------------------------------------------- 番茄钟 */

let timer = 0

function startTimer(): void {
  window.clearInterval(timer)
  timer = window.setInterval(() => {
    const { state, finished } = tick(pomodoro.value, Date.now())
    pomodoro.value = state
    if (finished === 'focus') void onFocusFinished()
    if (finished === 'break') void onBreakFinished()
  }, 1000)
}

async function togglePomo(): Promise<void> {
  pomodoro.value = pomodoro.value.running ? pause(pomodoro.value) : start(pomodoro.value)
  // 计时的表不能藏在后面：一开跑就把面板露出来
  if (pomodoro.value.running) pomoOpen.value = true
  await savePomodoro(pomodoro.value)
}

async function resetPomo(): Promise<void> {
  pomodoro.value = reset(pomodoro.value)
  await savePomodoro(pomodoro.value)
}

async function skipPomo(): Promise<void> {
  pomodoro.value = skip(pomodoro.value)
  await savePomodoro(pomodoro.value)
}

async function onFocusFinished(): Promise<void> {
  const task = selectedTask.value
  if (task) {
    const next = updateTask(task, { pomodoros: task.pomodoros + 1 })
    tasks.value = tasks.value.map((item) => (item.id === next.id ? next : item))
    await persist()
  }
  await savePomodoro(pomodoro.value)
  toast.ok('专注结束，休息一下')
  void notify
    .show({
      title: '番茄钟：专注结束',
      body: task ? `「${task.title}」记了 1 个番茄，起来走两步吧` : '起来走两步吧，休息 5 分钟',
    })
    .catch(() => undefined)
}

async function onBreakFinished(): Promise<void> {
  await savePomodoro(pomodoro.value)
  toast.info('休息结束，开始下一轮')
  void notify.show({ title: '番茄钟：休息结束', body: '开始下一个专注段' }).catch(() => undefined)
}

async function changeDurations(focusMinutes: number, breakMinutes: number): Promise<void> {
  pomodoro.value = setDurations(pomodoro.value, focusMinutes, breakMinutes)
  await savePomodoro(pomodoro.value)
}

/* ------------------------------------------------------------- 快捷键 */

function onKeydown(event: KeyboardEvent): void {
  const typing = isTypingTarget(event.target)
  if (matchKey(event, 'Mod+n')) {
    event.preventDefault()
    addEl.value?.focus()
    return
  }
  if (matchKey(event, 'Mod+p')) {
    event.preventDefault()
    void togglePomo()
    return
  }
  if (matchKey(event, 'Mod+e') && !typing) {
    event.preventDefault()
    if (selectedTask.value) editing.value = selectedTask.value
    return
  }
  if (matchKey(event, 'Mod+Backspace') && !typing) {
    event.preventDefault()
    if (selectedTask.value) void removeTask(selectedTask.value)
    return
  }
  if (event.key === ' ' && !typing) {
    event.preventDefault()
    if (selectedTask.value) void toggle(selectedTask.value)
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveSelection(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveSelection(-1)
  }
}

/* ------------------------------------------------------------- 宿主 footer */

async function syncFooter(): Promise<void> {
  await hostUi
    .setFooter([
      {
        type: 'button',
        id: 'pomo',
        label: pomodoro.value.running ? '暂停番茄钟' : '开始番茄钟',
        icon: 'Timer',
        keys: [`${modLabel}+P`],
        onClick: () => void togglePomo(),
      },
      { type: 'button', id: 'add', label: '新建待办', icon: 'Plus', keys: [`${modLabel}+N`], onClick: () => addEl.value?.focus() },
      {
        type: 'action-panel',
        id: 'more',
        label: '更多',
        icon: 'Sliders',
        keys: [`${modLabel}+K`],
        title: '待办操作',
        items: [
          { id: 'panel', name: pomoOpen.value ? '收起番茄钟面板' : '展开番茄钟面板', icon: 'Timer', onSelect: () => (pomoOpen.value = !pomoOpen.value) },
          { id: 'edit', name: '编辑选中待办', icon: 'FileText', onSelect: () => selectedTask.value && (editing.value = selectedTask.value) },
          { id: 'done', name: '完成 / 取消完成', icon: 'Check', onSelect: () => selectedTask.value && void toggle(selectedTask.value) },
          { id: 'clear', name: '清空已完成', icon: 'Trash', onSelect: () => void clearCompleted() },
        ],
      },
    ])
    .catch(() => undefined)
}

watch(pomodoro, () => void syncFooter())

/* ------------------------------------------------------------- 生命周期 */

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await load()
  startTimer()
  void syncFooter()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.clearInterval(timer)
})

const pomoProgress = computed(() => progress(pomodoro.value))
</script>

<template>
  <AppShell>
    <header class="flex items-center gap-2 border-b border-line px-3 py-2">
      <UiIcon name="check" :size="16" class="text-accent" />
      <span class="text-[13px] font-semibold">ToDo 待办</span>
      <span class="launcher-chip">待处理 {{ summary.open }}</span>
      <span v-if="summary.today" class="launcher-chip text-accent">今天 {{ summary.today }}</span>
      <span v-if="summary.overdue" class="launcher-chip text-danger">逾期 {{ summary.overdue }}</span>
      <span class="launcher-chip">已完成 {{ summary.done }}</span>
      <div class="ml-auto flex items-center gap-1.5">
        <button class="launcher-btn ghost" :class="pomoOpen ? 'bg-active text-accent' : ''" @click="pomoOpen = !pomoOpen">
          <UiIcon name="timer" :size="13" />
          番茄钟
        </button>
        <button class="launcher-btn ghost" @click="clearCompleted">
          <UiIcon name="trash" :size="13" />
          清空已完成
        </button>
      </div>
    </header>

    <!-- 新增待办 -->
    <div class="flex items-center gap-1.5 border-b border-line px-3 py-2">
      <UiIcon name="plus" :size="14" class="text-faint" />
      <input
        ref="addEl"
        v-model="draftTitle"
        class="launcher-input min-w-0 flex-1"
        placeholder="要做什么？回车加入（搜索框里的文字会带进来）"
        @keydown.enter.prevent="addTask"
      />
      <div class="w-[92px] shrink-0">
        <UiSelect :model-value="draftPriority" :options="priorityOptions" @update:model-value="(value) => (draftPriority = Number(value) as Priority)" />
      </div>
      <input v-model="draftDue" class="launcher-input w-[132px] shrink-0" placeholder="截止：明天" @keydown.enter.prevent="addTask" />
      <button class="launcher-btn primary shrink-0" @click="addTask">添加</button>
    </div>

    <!-- 视图切换 -->
    <div class="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        class="launcher-btn ghost"
        :class="filter === tab.value ? 'bg-active text-accent' : ''"
        @click="filter = tab.value"
      >
        {{ tab.label }}
        <span class="text-[10.5px] text-faint">{{ tab.count() }}</span>
      </button>
      <span class="ml-auto text-[11px] text-faint">↑↓ 选择 · 空格完成</span>
    </div>

    <div class="flex min-h-0 flex-1">
      <!-- 待办列表（虚拟滚动） -->
      <div ref="listEl" class="launcher-scroll min-w-0 flex-1">
        <div :style="{ height: `${totalHeight}px`, position: 'relative' }">
          <div :style="{ transform: `translateY(${offsetY}px)` }">
            <div
              v-for="task in rows"
              :key="task.id"
              class="group flex items-center gap-2.5 border-b border-line px-3"
              :style="{ height: `${ROW_HEIGHT}px` }"
              :class="selectedId === task.id ? 'bg-active' : 'hover:bg-hover'"
              @click="selectedId = task.id"
              @dblclick="editing = task"
            >
              <button
                class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
                :class="task.done ? 'border-accent bg-accent text-accentfg' : 'border-linestrong text-transparent hover:border-accent'"
                @click.stop="toggle(task)"
              >
                <UiIcon name="check" :size="10" :weight="2.6" />
              </button>

              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-[12.5px]" :class="task.done ? 'task-done' : ''">{{ task.title }}</span>
                  <span v-if="task.priority === 2" class="launcher-chip shrink-0 text-danger">紧急</span>
                  <span v-else-if="task.priority === 1" class="launcher-chip shrink-0 text-accent">重要</span>
                </div>
                <div class="flex items-center gap-2 text-[10.5px] text-faint">
                  <span v-if="dueLabel(task)" :class="dueLabel(task)?.tone === 'danger' ? 'text-danger' : dueLabel(task)?.tone === 'warn' ? 'text-accent' : ''">
                    <UiIcon name="calendar" :size="10" class="mr-0.5 inline align-[-1px]" />{{ dueLabel(task)?.text }}
                  </span>
                  <span v-if="task.pomodoros" class="inline-flex items-center gap-0.5">
                    <UiIcon name="timer" :size="10" />{{ task.pomodoros }}
                  </span>
                  <span v-if="task.note" class="truncate">{{ task.note }}</span>
                </div>
              </div>

              <button class="launcher-btn ghost shrink-0 opacity-0 group-hover:opacity-100" title="编辑" @click.stop="editing = task">
                <UiIcon name="pencil" :size="12" />
              </button>
              <button class="launcher-btn ghost shrink-0 text-danger opacity-0 group-hover:opacity-100" title="删除" @click.stop="removeTask(task)">
                <UiIcon name="trash" :size="12" />
              </button>
            </div>
          </div>
        </div>

        <div v-if="!visible.length" class="flex flex-col items-center gap-2 px-6 py-10 text-center text-faint">
          <UiIcon name="check" :size="24" />
          <p class="text-[12.5px]">
            {{ !loaded ? '正在读取…' : filter === 'done' ? '还没有完成的待办' : filter === 'today' ? '今天没有到期的事' : '暂无待办，在上面的输入框里加一条' }}
          </p>
          <p v-if="loaded && filter === 'open'" class="text-[11px]">小技巧：把搜索框里的文字带进来，回车就是一条待办</p>
        </div>
      </div>

      <!-- 番茄钟 -->
      <aside v-if="pomoOpen" class="flex w-[228px] shrink-0 flex-col gap-2.5 border-l border-line px-3 py-3">
        <div class="flex items-center gap-2">
          <span class="text-[11.5px] text-muted">{{ pomodoro.phase === 'focus' ? '专注中' : '休息中' }}</span>
          <span class="launcher-chip">{{ pomodoro.running ? '计时中' : '已暂停' }}</span>
        </div>
        <div class="pomo-clock" :class="pomodoro.running ? 'pomo-running' : ''">{{ formatClock(pomodoro.remaining) }}</div>
        <div class="h-1 overflow-hidden rounded-full bg-panel2">
          <div class="h-full rounded-full bg-accent" :style="{ width: `${Math.round(pomoProgress * 100)}%` }" />
        </div>
        <div class="truncate text-[11.5px]" :title="selectedTask?.title ?? ''">
          <span class="text-faint">当前任务：</span>{{ selectedTask?.title ?? '未选择' }}
        </div>
        <div class="flex items-center gap-1.5">
          <button class="launcher-btn primary flex-1" @click="togglePomo">
            <UiIcon :name="pomodoro.running ? 'stop' : 'play'" :size="12" />
            {{ pomodoro.running ? '暂停' : '开始' }}
          </button>
          <button class="launcher-btn ghost" title="重置本段" @click="resetPomo">
            <UiIcon name="refresh" :size="12" />
          </button>
          <button class="launcher-btn ghost" title="跳到下一段" @click="skipPomo">
            <UiIcon name="arrowRight" :size="12" />
          </button>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="text-[11px] text-faint">专注</span>
          <UiSelect
            :model-value="Math.round(pomodoro.focusMs / 60_000)"
            :options="focusOptions"
            @update:model-value="(value) => changeDurations(Number(value), Math.round(pomodoro.breakMs / 60_000))"
          />
        </div>
        <div class="flex items-center gap-1.5">
          <span class="text-[11px] text-faint">休息</span>
          <UiSelect
            :model-value="Math.round(pomodoro.breakMs / 60_000)"
            :options="breakOptions"
            @update:model-value="(value) => changeDurations(Math.round(pomodoro.focusMs / 60_000), Number(value))"
          />
        </div>
        <p class="mt-auto text-[10.5px] leading-4 text-faint">
          累计完成 {{ pomodoro.rounds }} 个番茄；当前任务记了 {{ selectedTask?.pomodoros ?? 0 }} 个。专注结束时会给系统通知。
        </p>
      </aside>
    </div>

    <footer class="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
      <span><span class="launcher-kbd">Enter</span> 添加</span>
      <span><span class="launcher-kbd">Space</span> 完成 / 取消</span>
      <span><span class="launcher-kbd">{{ modLabel }}P</span> 番茄钟</span>
      <span><span class="launcher-kbd">{{ modLabel }}E</span> 编辑</span>
      <span class="ml-auto">双击一行也能编辑</span>
    </footer>

    <TaskDialog v-if="editing" :task="editing" @close="editing = null" @save="saveEdit" @remove="removeTask(editing!)" />
  </AppShell>
</template>
