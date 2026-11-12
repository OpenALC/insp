<script setup lang="ts">
import { computed, ref } from 'vue'
import { AlarmClock, ArrowLeft, CalendarDays, Check, ChevronLeft, ChevronRight, Plus, Search, Trash2, X } from 'lucide-vue-next'
import type { TodoItem } from '../domain/models'

const props = defineProps<{ items: TodoItem[]; error?: string }>()
const emit = defineEmits<{ back: []; save: [item: TodoItem]; delete: [id: string] }>()
const query = ref('')
const editing = ref<TodoItem | null>(null)
const sheetOpen = ref(false)
const pickerOpen = ref(false)
const text = ref('')
const remindAt = ref<string | null>(null)
const repeat = ref<TodoItem['repeat']>('none')
const month = ref(new Date())
const chosenDay = ref(new Date())
const chosenTime = ref('09:00')
const completedOpen = ref(false)

const matches = computed(() => props.items.filter(item => item.text.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
const pending = computed(() => matches.value.filter(item => !item.completed).sort((a, b) =>
  (a.remindAt ?? '9999').localeCompare(b.remindAt ?? '9999') || b.createdAt.localeCompare(a.createdAt)))
const completed = computed(() => matches.value.filter(item => item.completed).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
const days = computed(() => {
  const start = new Date(month.value.getFullYear(), month.value.getMonth(), 1)
  const offset = (start.getDay() + 6) % 7
  return [...Array(offset).fill(0), ...Array.from({ length: new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate() }, (_, index) => index + 1)]
})
const reminderLabel = computed(() => remindAt.value ? new Date(remindAt.value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '设置提醒')

function open(item: TodoItem | null = null) {
  editing.value = item
  text.value = item?.text ?? ''
  remindAt.value = item?.remindAt ?? null
  repeat.value = item?.repeat ?? 'none'
  sheetOpen.value = true
}

function save(continueAdding = false) {
  const value = text.value.trim()
  if (!value) return
  const now = new Date().toISOString()
  emit('save', { id: editing.value?.id ?? crypto.randomUUID(), text: value, completed: editing.value?.completed ?? false,
    remindAt: remindAt.value, repeat: remindAt.value ? repeat.value : 'none', createdAt: editing.value?.createdAt ?? now, updatedAt: now })
  if (continueAdding && !editing.value) { text.value = ''; remindAt.value = null; repeat.value = 'none' }
  else sheetOpen.value = false
}

function toggle(item: TodoItem) {
  emit('save', { ...item, completed: !item.completed, updatedAt: new Date().toISOString() })
}

function beginReminder() {
  const next = remindAt.value ? new Date(remindAt.value) : new Date(Date.now() + 60 * 60 * 1000)
  chosenDay.value = next
  month.value = new Date(next.getFullYear(), next.getMonth(), 1)
  chosenTime.value = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
  ;(document.activeElement as HTMLElement)?.blur()
  pickerOpen.value = true
}

function setReminder() {
  const [hour, minute] = chosenTime.value.split(':').map(Number)
  remindAt.value = new Date(chosenDay.value.getFullYear(), chosenDay.value.getMonth(), chosenDay.value.getDate(), hour, minute).toISOString()
  pickerOpen.value = false
}

function shiftMonth(amount: number) {
  month.value = new Date(month.value.getFullYear(), month.value.getMonth() + amount, 1)
}

function deleteCurrent() {
  if (editing.value) emit('delete', editing.value.id)
  sheetOpen.value = false
}

function formatReminder(item: TodoItem) {
  if (!item.remindAt) return ''
  const label = new Date(item.remindAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `${label}${item.repeat === 'none' ? '' : ' · 重复'}`
}
function handleBack(): boolean {
  if (pickerOpen.value) { pickerOpen.value = false; return true }
  if (sheetOpen.value) { sheetOpen.value = false; return true }
  return false
}
defineExpose({ handleBack })
</script>

<template>
  <section class="todo-page" aria-label="待办页面">
    <header class="todo-header"><button class="icon-button" aria-label="返回笔记" @click="emit('back')"><ArrowLeft :size="25" /></button><h1>待办</h1></header>
    <label class="todo-search"><Search :size="21" /><input v-model="query" type="search" placeholder="搜索待办" aria-label="搜索待办" /></label>
    <div class="todo-scroll">
      <div v-if="!pending.length && !completed.length" class="todo-empty"><div class="todo-empty-icon"><Check :size="48" /></div><p>{{ query ? '没有找到待办' : '没有待办' }}</p></div>
      <div v-for="item in pending" :key="item.id" class="todo-item"><button class="todo-check" :aria-label="`完成 ${item.text}`" @click="toggle(item)"></button><button class="todo-item-body" @click="open(item)"><span>{{ item.text }}</span><small v-if="item.remindAt"><AlarmClock :size="14" />{{ formatReminder(item) }}</small></button></div>
      <div v-if="completed.length" class="todo-completed"><button class="todo-completed-toggle" @click="completedOpen = !completedOpen">已完成 {{ completed.length }}<ChevronRight :size="18" :class="{ open: completedOpen }" /></button>
        <template v-if="completedOpen"><div v-for="item in completed" :key="item.id" class="todo-item done"><button class="todo-check checked" :aria-label="`取消完成 ${item.text}`" @click="toggle(item)"><Check :size="15" /></button><button class="todo-item-body" @click="open(item)"><span>{{ item.text }}</span></button></div></template>
      </div>
    </div>
    <button class="todo-add" aria-label="新建待办" @click="open()"><Plus :size="29" /></button>
    <div v-if="sheetOpen" class="todo-modal" @click.self="sheetOpen = false"><div class="todo-compose" role="dialog" aria-label="编辑待办"><div class="todo-compose-main"><span class="todo-compose-box"></span><textarea v-model="text" rows="3" placeholder="回车即可连续添加待办" autofocus @keydown.enter.prevent="save(true)"></textarea></div><div class="todo-compose-actions"><button class="todo-remind-button" @click="beginReminder"><AlarmClock :size="19" />{{ reminderLabel }}</button><button v-if="editing" class="todo-remove" aria-label="删除待办" @click="deleteCurrent"><Trash2 :size="20" /></button><button class="todo-submit" :disabled="!text.trim()" @click="save()">完成</button></div></div></div>
    <div v-if="pickerOpen" class="todo-modal todo-picker-modal" @click.self="pickerOpen = false"><div class="todo-picker" role="dialog" aria-label="设置提醒时间"><h2>设置提醒时间</h2><div class="todo-picker-summary"><span>提醒时间</span><span>{{ chosenDay.toLocaleDateString('zh-CN') }} <input v-model="chosenTime" type="time" aria-label="提醒时刻" /></span></div><div class="todo-repeat"><span>重复提醒</span><select v-model="repeat" aria-label="重复提醒"><option value="none">不重复</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select></div><div class="todo-calendar-heading"><button aria-label="上个月" @click="shiftMonth(-1)"><ChevronLeft :size="21" /></button><strong>{{ month.getFullYear() }}/{{ month.getMonth() + 1 }}</strong><button aria-label="下个月" @click="shiftMonth(1)"><ChevronRight :size="21" /></button></div><div class="todo-calendar"><span v-for="day in ['一','二','三','四','五','六','日']" :key="day" class="weekday">{{ day }}</span><template v-for="(day, index) in days" :key="index"><span v-if="!day"></span><button v-else :class="{ chosen: chosenDay.getFullYear() === month.getFullYear() && chosenDay.getMonth() === month.getMonth() && chosenDay.getDate() === day }" @click="chosenDay = new Date(month.getFullYear(), month.getMonth(), day)">{{ day }}</button></template></div><div class="todo-picker-actions"><button @click="remindAt = null; repeat = 'none'; pickerOpen = false">清除</button><button @click="pickerOpen = false">取消</button><button class="primary" @click="setReminder"><CalendarDays :size="17" />确定</button></div></div></div>
    <p v-if="error" class="todo-error" role="alert">{{ error }}</p>
  </section>
</template>
